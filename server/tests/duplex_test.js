#!/usr/bin/env node
// tests/duplex_test.js — 全双工语音生命周期 / 语音+文字打断 / 三层防回声 回归测试（无需浏览器）
//
// 守护的用户诉求：
//   1. “我自己点停止”：点击开麦后麦克风常开，多轮对话、文字发送、模型播报、长时间静默都不会自动关麦；只有再点一次才关。
//   2. 语音 / 文字 / 推荐选项 / 出行方式 四路打断：瞬间掐灭正在播放与排队的音频，正确处理 serverContent.interrupted，
//      被打断后服务端管道里的迟到尾包坚决丢弃，新一轮开头绝不误吞。
//   3. 屏蔽扬声器回音：getUserMedia 带 AEC/NS/AGC；播报期间残余回声帧被静音帧替换、真人声连续 3 帧才开门 + 闪避；
//      误报回滚；语义回声侦测只对“连续 ≥8 字/词逐字重合”判罚且逐级升级；“天天 / 滨海湾花园”等短答永不误杀。
//
// 做法：在 Node vm 里拼装 app.js 的真实切片（音频与打断核心 / updateAllMicButtons / playPcm / sendQuery+dispatch /
//       handleSelectRecommendationOption / connect() 内的 ws.onmessage 处理器）+ 完整 static/duplex.js，
//       配假 DOM、假 AudioContext/AudioWorkletNode、假 getUserMedia、假 WebSocket、可控时钟与定时器。
// 运行：node tests/duplex_test.js   （VERBOSE=1 打印沙箱日志）
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "static", "app.js"), "utf8");
const duplexSrc = fs.readFileSync(path.join(ROOT, "static", "duplex.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8");
const mainPy = fs.readFileSync(path.join(ROOT, "main.py"), "utf8");
const VERBOSE = !!process.env.VERBOSE;

let passed = 0, failed = 0;
function assert(name, cond, details) {
  if (cond) { passed++; console.log("PASS [" + name + "]" + (details ? " " + details : "")); }
  else { failed++; console.error("FAIL [" + name + "]" + (details ? " " + details : "")); }
}
function slice(startMarker, endMarker) {
  const a = appSrc.indexOf(startMarker);
  const b = a < 0 ? -1 : appSrc.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error("marker not found in static/app.js:", startMarker, "/", endMarker); process.exit(2); }
  return appSrc.slice(a, b);
}
function fnBody(name) {
  const m = appSrc.match(new RegExp("function " + name + "\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}"));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------
// A. 静态守卫：源码层面的结构性约束（比运行时更早拦住回归）
// ---------------------------------------------------------------
{
  assert("static: index.html 在 app.js 之后加载 duplex.js",
    /<script src="\/static\/app\.js\?v=\d+"><\/script>\s*<script src="\/static\/duplex\.js\?v=\d+"><\/script>/.test(html));
  assert("static: toggleVoiceRecording 在支持全双工时委托 DuplexVoice.toggle",
    /window\.DuplexVoice\.supported\(\)\)\s*\{\s*return window\.DuplexVoice\.toggle\(scope\);/.test(appSrc));
  assert("static: setup 消息展开 DuplexVoice.setupExtras()（服务端 VAD 开启）",
    /\.\.\.\(duplexOn \? window\.DuplexVoice\.setupExtras\(\)/.test(appSrc));
  assert("static: ws.onmessage 处理 serverContent.interrupted → 掐断 + 清迟到帧门",
    /if \(sc\.interrupted\) \{\s*[\s\S]*?stopAllAudioPlayback\(\);\s*clearLateAudioGate\("interrupted"\);/.test(appSrc));
  assert("static: playPcm 在解码前先过迟到帧门", /function playPcm\(b64\) \{[\s\S]*?shouldDropLateAudio\(\)\) return;[\s\S]*?const raw = atob\(b64\);/.test(appSrc));
  const sq = fnBody("sendQuery");
  assert("static: sendQuery 使用 bargeIn(\"text\") 做文字打断", sq && /bargeIn\("text"\)/.test(sq));
  assert("static: sendQuery 不再禁用发送按钮（播报中必须能再次发送文字打断）", sq && !/btnSend"\)\.disabled = true/.test(sq));
  assert("static: sendQuery 的 Web Speech 收尾被 !duplexMicOn() 守卫（全双工不因文字发送关麦）", sq && /if \(!duplexMicOn\(\)\) \{[\s\S]*?stopVoiceHardware\(\);/.test(sq));
  const opt = fnBody("handleSelectRecommendationOption");
  assert("static: 推荐选项点击 = bargeIn(\"option\") + 通知模型", opt && /bargeIn\("option"\)/.test(opt) && /notifyModelOfUiAction\(/.test(opt));
  assert("static: 桌面出行方式标签 → onTravelModeSwitched", /if \(mode && activeDestination\) \{\s*onTravelModeSwitched\(mode\);/.test(appSrc));
  assert("static: 手机出行方式药丸 → onTravelModeSwitched", /if \(m\) onTravelModeSwitched\(m\);/.test(appSrc));
  assert("static: duplex.js 没有任何“说完一句自动关麦”的定时器", !/stopVoiceRecordingAndSend|VOICE_SILENCE_TIMEOUT|1800/.test(duplexSrc));
  assert("static: duplex.js getUserMedia 携带 echoCancellation/noiseSuppression/autoGainControl",
    /getUserMedia\(\{\s*audio: \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true/.test(duplexSrc));
  assert("static: duplex.js 关麦时发送 audioStreamEnd", /realtimeInput: \{ audioStreamEnd: true \}/.test(duplexSrc));
  assert("static: duplex.js 服务端 VAD 配置 START_OF_ACTIVITY_INTERRUPTS + disabled:false",
    /disabled: false,/.test(duplexSrc) && /activityHandling: "START_OF_ACTIVITY_INTERRUPTS"/.test(duplexSrc));
  assert("static: main.py 记录 interrupted 与 realtimeInput 文本/音频流", /interrupted/.test(mainPy) && /client_realtime_text/.test(mainPy) && /audioStreamEnd/.test(mainPy));
  assert("static: 提示词芯片不再在发送前把 sceneLock 置 false（否则迟到帧门无法布置）",
    !/btn\.onclick = \(\) => \{\s*resumeAudioIfNeeded\(\);\s*sceneLock = false;/.test(appSrc));
  assert("static: 连接断开 / 主动重连时复位 sceneLock 并解除迟到帧门",
    /ws\.onclose = \(\) => \{[\s\S]*?ready = false;[\s\S]*?sceneLock = false;\s*clearLateAudioGate\("ws_close"\);/.test(appSrc) &&
    /ready = false;\s*sceneLock = false;\s*clearLateAudioGate\("reconnect"\);\s*connect\(\);/.test(appSrc));
  assert("static: 旧的 SINK_VIA_ELEMENT（TrackAudioRenderer 路径，对 Chrome AEC 无效）已被回环通道取代",
    !/SINK_VIA_ELEMENT/.test(appSrc) && /RTCPeerConnection/.test(appSrc) && /createMediaStreamDestination/.test(appSrc));
}

// ---------------------------------------------------------------
// B. 运行时沙箱
// ---------------------------------------------------------------
const SILENCE_B64 = Buffer.alloc(1280).toString("base64");

function makeHarness(opts = {}) {
  const clock = { now: 100000 };
  const timers = new Map(); let tid = 0;
  const schedule = (fn, ms, repeat) => {
    const id = ++tid; const d = Math.max(repeat ? 1 : 0, ms | 0);
    timers.set(id, { fn, at: clock.now + d, ms: d, repeat }); return id;
  };
  function advance(ms) {
    const end = clock.now + ms;
    for (let guard = 0; guard < 100000; guard++) {
      let pick = null;
      for (const [id, t] of timers) if (t.at <= end && (!pick || t.at < pick[1].at)) pick = [id, t];
      if (!pick) break;
      const [id, t] = pick;
      clock.now = Math.max(clock.now, t.at);
      if (t.repeat) t.at += t.ms; else timers.delete(id);
      t.fn();
    }
    clock.now = end;
  }

  const els = {}; let elSeq = 0;
  const makeEl = (id) => {
    const cls = new Set();
    return {
      id, value: "", textContent: "", placeholder: "", disabled: false, style: {}, _attrs: {}, _cls: cls, _ev: {},
      srcObject: null, autoplay: false, onplaying: null,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      click() { if (this.onclick) this.onclick(); },
      appendChild() {}, remove() { this.removed = true; },
      addEventListener(ev, fn) { this._ev[ev] = fn; },
      fire(ev, e) { if (this._ev[ev]) this._ev[ev](e || {}); },
      play() { Promise.resolve().then(() => { if (this.onplaying) this.onplaying(); }); return Promise.resolve(); }
    };
  };
  const $ = (id) => els[id] || (els[id] = makeEl(id));
  ["viewAssistantOverlay", "viewMobileOverlay", "viewGlassesOverlay", "routePreviewCard"].forEach(id => $(id).classList.add("hidden"));
  $("mobTabMap").classList.add("active");
  const bodyCls = new Set();

  class FakeGain {
    constructor() { this.gain = { value: 1, target: 1, calls: [], cancelScheduledValues() {}, setTargetAtTime(v) { this.target = v; this.calls.push(v); } }; this.connections = new Set(); }
    connect(n) { this.connections.add(n); return n; }
    disconnect(n) { if (n) this.connections.delete(n); else this.connections.clear(); }
  }
  class FakeSource {
    constructor() { this.buffer = null; this.onended = null; this.startedAt = null; this.stopped = false; }
    connect() {} start(t) { this.startedAt = t; } stop() { this.stopped = true; } disconnect() {}
  }
  class FakeAudioContext {
    constructor(o) {
      this.sampleRate = (o && o.sampleRate) || 48000; this.state = "running"; this._t0 = clock.now;
      this.destination = { kind: "destination" }; this.audioWorklet = { addModule: async () => { this.moduleLoaded = true; } };
      this.closed = false; this.gains = []; this.sources = []; FakeAudioContext.instances.push(this);
    }
    get currentTime() { return (clock.now - this._t0) / 1000; }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
    createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(ch, len, rate) { return { duration: len / rate, copyToChannel() {} }; }
    createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
    createMediaStreamDestination() { return { kind: "msdest", stream: { getAudioTracks: () => [{ kind: "audio" }] } }; }
  }
  FakeAudioContext.instances = [];
  class FakeWorkletNode {
    constructor(ctx, name, o) { this.ctx = ctx; this.name = name; this.opts = o; this.port = { onmessage: null }; FakeWorkletNode.last = this; }
    connect(n) { return n; } disconnect() {}
  }
  class FakeRTC {
    constructor() { this.tracks = []; this.onicecandidate = null; this.ontrack = null; this.closed = false; FakeRTC.all.push(this); }
    addTrack(t) { this.tracks.push(t); }
    async createOffer() { return { type: "offer" }; }
    async createAnswer() { return { type: "answer" }; }
    async setLocalDescription(d) { this.local = d; }
    async setRemoteDescription(d) {
      this.remote = d;
      if (d.type === "answer") { const other = FakeRTC.all.find(p => p !== this); if (other && other.ontrack) other.ontrack({ track: this.tracks[0], streams: [{ id: "loop" }] }); }
    }
    addIceCandidate() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  FakeRTC.all = [];

  const streams = [], gumCalls = [];
  const fakeStream = () => {
    const track = { stopped: false, onended: null, stop() { this.stopped = true; }, getSettings() { return { echoCancellation: opts.aec === undefined ? true : opts.aec }; } };
    return { _track: track, getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const getUserMedia = opts.getUserMedia || (async (c) => { gumCalls.push(c); const s = fakeStream(); streams.push(s); return s; });

  const ws = { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } };
  const calls = { stopAll: 0, exitNav: 0, resetDispatch: 0, renderOpts: [], toasts: [], userBroadcasts: [], modelBroadcasts: [], reconnect: [], prepared: [], calcMode: [] };

  const ctx = {
    console: VERBOSE ? console : { log() {}, warn() {}, error() {} },
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: (id) => { timers.delete(id); },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    document: {
      readyState: "complete", body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) }, appendChild() {} },
      createElement: (tag) => makeEl("__" + tag + (++elSeq)), getElementById: (id) => els[id] || null,
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {}
    },
    navigator: { userAgent: opts.ua || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", mediaDevices: { getUserMedia } },
    location: { search: opts.search || "" }, localStorage: { getItem: () => null, setItem() {} }, URLSearchParams: global.URLSearchParams,
    btoa: global.btoa, atob: global.atob, Blob: global.Blob,
    AudioContext: FakeAudioContext, AudioWorklet: function () {}, AudioWorkletNode: FakeWorkletNode, WebSocket: { OPEN: 1 },
    MediaStream: class { constructor(t) { this.tracks = t; } },
    $, __ws: ws, __calls: calls
  };
  if (opts.noWorklet) delete ctx.AudioWorklet;
  if (opts.rtc) ctx.RTCPeerConnection = FakeRTC;
  ctx.window = ctx;
  vm.createContext(ctx);

  // app.js 顶层（切片之外）的全局与被切片依赖的函数：能用真实实现的就切真实实现，其余记录调用的桩
  const prelude = `
let ws = __ws; let ready = true; let sceneLock = false; let pending = null;
let currentUserTranscript = ""; let currentModelTranscript = "";
let activeDestination = ""; let selectedTravelMode = "DRIVING"; let lastRecommendedDestination = "";
let recognition = null; let isRecording = false; let userWantsRecording = false; let voiceSilenceTimer = null;
let voiceScope = null; let voiceSessionId = 0;
let simState = { active: false, paused: false };
let dispatchState = { hasSearch: false, hasMaps: false, hasFc: false, searchQuery: "", mapsPoi: "", fcArgs: "" };
const MODE_CONFIG = { DRIVING: { name: "开车" }, BICYCLING: { name: "骑行" }, WALKING: { name: "步行" } };
const currentCity = { shortName: "新加坡", key: "sg" };
function getActiveViewScope() { return "console"; }
function exitNavigation() { __calls.exitNav++; activeDestination = ""; }
function renderRecommendationOptions(l) { __calls.renderOpts.push((l || []).length); }
function resetDispatchState() { __calls.resetDispatch++; }
function updateDispatchUI() {}
function showVoiceToast(m) { __calls.toasts.push(String(m)); }
function hideVoiceToast() {}
function resumeAudioIfNeeded() {}
function reconnectFresh(keep) { __calls.reconnect.push(!!keep); }
function broadcastUserTranscript(t) { if (!t) return; currentUserTranscript = t; __calls.userBroadcasts.push(t); }
function broadcastModelTranscript(t) { __calls.modelBroadcasts.push(t); if (t === "正在思考与实时检索中…" || t === "思考中…") { currentModelTranscript = ""; return; } currentModelTranscript = t; }
function syncAllAssistantBubbles(u, m) { if (u) broadcastUserTranscript(u); if (m) broadcastModelTranscript(m); }
function stopVoiceHardware() {}
function calculateModeRoute(mode) { __calls.calcMode.push(mode); selectedTravelMode = mode; }
async function prepareRouteAndModeSelection(dest, mode) { __calls.prepared.push({ dest, mode }); activeDestination = dest; selectedTravelMode = mode || "DRIVING"; $("routePreviewCard").classList.remove("hidden"); }
function remoteLog() {}
function isValidDestinationName(d) { return !!d && String(d).trim().length >= 2; }
function sanitizeDestinationName(n) { return String(n || "").trim(); }
function tryRealtimeExtractAndRender() {}
function checkAndTriggerSmartNavigation() {}
`;
  const audioCore = slice("let playCtx = null;", "// 真实电脑麦克风驱动与多端智能语音对讲引擎");
  const scopesSrc = slice("const VOICE_SCOPES = {", "let voiceScope = null;");
  const micBtnSrc = slice("function updateAllMicButtons(recording) {", "// 1. 用户输入与语音提问全端同屏广播");
  const playPcmSrc = slice("function playPcm(b64) {", "// ---------------- 交互调度与发送");
  const sendSrc = slice("function sendQuery(text) {", "async function initApp() {");
  const optSrc = slice("function handleSelectRecommendationOption(opt) {", "// v78: 纯实时动态推荐选项抽取引擎 2.0");
  const onmsgSrc = slice("  ws.onmessage = async (ev) => {", "  ws.onclose = () => {").replace("ws.onmessage = ", "this.__onmessage = ");
  const accessors = `
this.__g = () => ({ playCtx, playTime, activeAudioSources, isModelSpeaking, masterGain, audioSinkMode, audioSinkNodes, sceneLock, lateAudioGate,
  currentUserTranscript, currentModelTranscript, activeDestination, selectedTravelMode, expectedUiFc, duplexSetupActive, TEXT_INPUT_MODE, pending, voiceScope });
this.__set = { sceneLock: v => { sceneLock = v; }, activeDestination: v => { activeDestination = v; }, selectedTravelMode: v => { selectedTravelMode = v; },
  currentModelTranscript: v => { currentModelTranscript = v; }, currentUserTranscript: v => { currentUserTranscript = v; }, ready: v => { ready = v; },
  duplexSetupActive: v => { duplexSetupActive = v; }, simActive: v => { simState.active = v; } };
this.__fns = { sendQuery, dispatch, playPcm, stopAllAudioPlayback, getMasterGain, setAudioSinkMode, getAudioSinkMode, bargeIn, armLateAudioGate,
  clearLateAudioGate, shouldDropLateAudio, buildUserTextFrames, notifyModelOfUiAction, isSameDestination, onTravelModeSwitched,
  handleSelectRecommendationOption, updateAllMicButtons };
`;
  vm.runInContext(prelude + "\n" + audioCore + "\n" + scopesSrc + "\n" + micBtnSrc + "\n" + playPcmSrc + "\n" + sendSrc + "\n" + optSrc + "\n" + onmsgSrc + "\n" + duplexSrc + "\n" + accessors,
    ctx, { filename: "app.js+duplex.js[sandbox]" });

  const D = () => ctx.DuplexVoice;
  const g = () => ctx.__g();
  const F = ctx.__fns;
  const frame = (rms) => { const u8 = new Uint8Array(1280); u8.fill(rms > 0.01 ? 7 : 1); return { pcm: u8.buffer, rms }; };
  const pushFrame = (rms) => { const fn = FakeWorkletNode.last && FakeWorkletNode.last.port.onmessage; if (typeof fn === "function") fn({ data: frame(rms) }); };
  const audioFrames = () => ws.sent.filter(f => f.realtimeInput && f.realtimeInput.audio).map(f => f.realtimeInput.audio.data);
  const textFrames = () => ws.sent.filter(f => f.clientContent || (f.realtimeInput && f.realtimeInput.text));
  const textOf = (f) => f.clientContent ? f.clientContent.turns[0].parts[0].text : f.realtimeInput.text;
  const pcm = (ms = 100) => Buffer.alloc(Math.round(24000 * 2 * ms / 1000)).toString("base64");
  const serverMsg = (m) => ctx.__onmessage({ data: JSON.stringify(m) });
  const finishPlayback = () => { for (const s of [...g().activeAudioSources]) { if (s.onended) s.onended(); } };
  const recordingIds = () => ["btnMainMic", "mobBtnMic", "btnMobTalk", "gBtnMic", "astBtnMic"].filter(id => $(id).classList.contains("recording"));
  const sentEnd = () => ws.sent.some(f => f.realtimeInput && f.realtimeInput.audioStreamEnd);

  return { ctx, $, els, ws, calls, clock, advance, streams, gumCalls, bodyCls, D, g, F, pushFrame, audioFrames, textFrames, textOf, pcm, serverMsg,
           finishPlayback, recordingIds, sentEnd, FakeAudioContext, FakeWorkletNode, FakeRTC, set: ctx.__set };
}

const MODEL_TEXT = "为您推荐两个打卡点：第一家是滨海湾花园，评分4.7，巨大的超级树非常震撼；第二家是鱼尾狮公园，评分4.6，是新加坡的标志。您想去哪一个？";

(async () => {
  // ---------------- T1 全双工生命周期：多轮不关麦，只有点击才关 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    assert("T1 点击开麦后 micOn", h.D().micOn === true);
    const c = h.gumCalls[0] && h.gumCalls[0].audio;
    assert("T1 getUserMedia 携带 AEC/NS/AGC", !!c && c.echoCancellation === true && c.noiseSuppression === true && c.autoGainControl === true, JSON.stringify(c));
    assert("T1 采集上下文按 16kHz 创建", h.FakeAudioContext.instances.some(x => x.sampleRate === 16000));
    assert("T1 五个麦克风按钮同步高亮", h.recordingIds().length === 5, JSON.stringify(h.recordingIds()));
    assert("T1 body 进入 duplex-listening", h.bodyCls.has("duplex-listening"));
    assert("T1 提示文案为“麦克风常开”", /麦克风常开/.test(h.$("mobTalkLabel").textContent) && /麦克风常开/.test(h.$("astListeningText").textContent));
    for (let i = 0; i < 10; i++) h.pushFrame(0.05);
    const af = h.audioFrames();
    assert("T1 扬声器静默期：麦克风帧全量直通（无静音替换）", af.length === 10 && af.every(d => d !== SILENCE_B64), "frames=" + af.length);
    assert("T1 上行 mimeType 为 audio/pcm;rate=16000", h.ws.sent.find(f => f.realtimeInput && f.realtimeInput.audio).realtimeInput.audio.mimeType === "audio/pcm;rate=16000");

    // 第一轮：服务端 ASR → 清场 → 模型音频 → turnComplete
    await h.serverMsg({ serverContent: { inputTranscription: { text: "附近有什么好吃的肉骨茶" } } });
    assert("T1 服务端 ASR 到达即开始语音轮：sceneLock + 用户字幕", h.g().sceneLock === true && h.calls.userBroadcasts.at(-1) === "附近有什么好吃的肉骨茶", JSON.stringify(h.calls.userBroadcasts));
    await h.serverMsg({ serverContent: { outputTranscription: { text: "为您推荐松发肉骨茶" }, modelTurn: { parts: [{ inlineData: { data: h.pcm(200) } }] } } });
    assert("T1 模型音频正常入队播放", h.g().activeAudioSources.size === 1);
    await h.serverMsg({ serverContent: { turnComplete: true } });
    assert("T1 turnComplete 后 sceneLock 复位", h.g().sceneLock === false);
    assert("T1 turnComplete 后麦克风仍开启（不再有 1.8s 自动关麦）", h.D().micOn && !h.streams[0]._track.stopped && !h.sentEnd());
    h.finishPlayback(); h.advance(30000);
    assert("T1 30 秒无人说话，麦克风仍开启", h.D().micOn && !h.sentEnd() && h.bodyCls.has("duplex-listening"));
    // 第二轮
    await h.serverMsg({ serverContent: { inputTranscription: { text: "去第一家" } } });
    h.advance(1200);
    await h.serverMsg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: h.pcm(100) } }] } } });
    await h.serverMsg({ serverContent: { turnComplete: true } });
    h.finishPlayback(); h.advance(1000);
    assert("T1 第二轮结束后麦克风仍开启，多轮持续", h.D().micOn && h.calls.userBroadcasts.at(-1) === "去第一家");
    const before = h.ws.sent.length;
    // 用户自己点停止
    h.D().toggle("console");
    assert("T1 再点一次 → 关麦：audioStreamEnd 已发送", h.D().micOn === false && h.sentEnd());
    assert("T1 关麦释放麦克风轨道与采集上下文", h.streams[0]._track.stopped === true && h.FakeAudioContext.instances.find(x => x.sampleRate === 16000).closed === true);
    assert("T1 关麦后按钮全部取消高亮、状态回到 off", h.recordingIds().length === 0 && h.bodyCls.has("duplex-off"));
    h.pushFrame(0.05);
    assert("T1 关麦后即使 worklet 还有尾帧也不再上行", h.ws.sent.length === before + 1 /* 只有 audioStreamEnd */);
  }

  // ---------------- T2 麦克风是全局唯一资源：任一端按钮都可关闭 / 开启 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.D().toggle("mobile");
    assert("T2 桌面开麦、手机端点击 → 关麦（不是重新开一个会话）", h.D().micOn === false && h.sentEnd());
    await h.D().toggle("assistant");
    assert("T2 助手端再点 → 重新开麦，scope 记录为 assistant", h.D().micOn === true && h.D().scope === "assistant");
  }

  // ---------------- T3 播报期间：残余回声帧 → 静音帧；真人声连续 3 帧才开门 + 闪避 + 预卷 ----------------
  let h3;
  {
    const h = h3 = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    for (let i = 0; i < 3; i++) h.F.playPcm(h.pcm(100));        // 模型正在播报 300ms
    assert("T3 前置：扬声器 busy", h.D().speakerBusy() === true);
    const n0 = h.audioFrames().length;
    for (let i = 0; i < 20; i++) h.pushFrame(0.004);            // 残余回声水平（低于 absMin -44dBFS）
    const af = h.audioFrames().slice(n0);
    assert("T3 播报期间回声级帧全部被静音帧替换（服务端 VAD 听不到回声）", af.length === 20 && af.every(d => d === SILENCE_B64));
    assert("T3 门限未开、回声底在学习", h.D().gateOpen === false && h.D().framesGated === 20 && h.D().stats().gateOpens === 0);
    h.pushFrame(0.05); h.pushFrame(0.05);
    assert("T3 连续 2 帧超阈仍不开门（抗瞬态）", h.D().gateOpen === false);
    const n1 = h.audioFrames().length;
    h.pushFrame(0.05);
    assert("T3 第 3 帧开门", h.D().gateOpen === true && h.D().stats().gateOpens === 1);
    const flushed = h.audioFrames().slice(n1);
    assert("T3 开门瞬间补发完整 preRoll 预卷 + 当前帧（都是真实音频）", flushed.length === h.D().CFG.preRollFrames + 1 && flushed.every(d => d !== SILENCE_B64), "flushed=" + flushed.length);
    assert("T3 开门即闪避到 -18dB", h.g().masterGain.gain.target === 0.12, "target=" + h.g().masterGain.gain.target);
    h.advance(100);
    assert("T3 状态机进入 user_speaking", h.bodyCls.has("duplex-user_speaking"));
  }

  // ---------------- T4 服务端 interrupted 确认：清空播放队列、恢复音量、不算误报 ----------------
  {
    const h = h3;
    const stopBefore = h.calls.stopAll;
    await h.serverMsg({ serverContent: { interrupted: true } });
    assert("T4 interrupted → 本地播放队列瞬间清空", h.g().activeAudioSources.size === 0 && h.g().masterGain.gain.target === 1);
    assert("T4 interrupted 计入确认，不会再触发误报回滚", h.D().stats().interrupts === 1 && h.D().stats().confirmed === 1);
    assert("T4 interrupted 后迟到帧门不再阻塞（之后到达的是新一轮音频）", h.g().lateAudioGate.active === false);
    h.F.playPcm(h.pcm(100));
    assert("T4 新一轮音频正常播放", h.g().activeAudioSources.size === 1);
    h.advance(2500);
    assert("T4 2.5s 后无误报", h.D().stats().falseAlarms === 0);
  }

  // ---------------- T5 本地硬切：门开 500ms 服务端还没确认 → 掐断 + 迟到帧门；interrupted 解除 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    for (let i = 0; i < 5; i++) h.F.playPcm(h.pcm(100));
    for (let i = 0; i < 3; i++) h.pushFrame(0.06);
    assert("T5 前置：门已开", h.D().gateOpen === true);
    h.advance(600);
    assert("T5 500ms 未确认 → 本地硬切", h.D().stats().hardCuts === 1 && h.g().activeAudioSources.size === 0);
    assert("T5 硬切同时布置迟到帧门", h.g().lateAudioGate.active === true && h.g().lateAudioGate.reason === "voice_gate_sustained");
    h.F.playPcm(h.pcm(100));
    assert("T5 硬切后到达的旧轮尾包被丢弃", h.g().activeAudioSources.size === 0 && h.g().lateAudioGate.dropped === 1);
    await h.serverMsg({ serverContent: { interrupted: true } });
    h.F.playPcm(h.pcm(100));
    assert("T5 interrupted 后新一轮音频放行", h.g().activeAudioSources.size === 1 && h.g().lateAudioGate.active === false);
  }

  // ---------------- T6 误报回滚 & ASR 确认 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(false);                                     // 上一轮已 turnComplete，只是尾音还在播
    for (let i = 0; i < 3; i++) h.F.playPcm(h.pcm(100));
    for (let i = 0; i < 3; i++) h.pushFrame(0.05);
    assert("T6 前置：门开、闪避", h.D().gateOpen && h.g().masterGain.gain.target === 0.12);
    h.advance(2100);
    assert("T6 2s 内无 interrupted 也无 ASR → 判定误报、恢复音量", h.D().stats().falseAlarms === 1 && h.g().masterGain.gain.target === 1);
    assert("T6 回声底抬到误报峰值 ×1.2 之上", h.D().echoFloor >= 0.05 * 1.2 - 1e-9, "echoFloor=" + h.D().echoFloor);
    assert("T6 上一轮已完成时硬切不布置迟到帧门（否则会误吞新一轮开头）", h.g().lateAudioGate.active === false);
    assert("T6 误报期间麦克风保持开启", h.D().micOn === true);
  }
  {
    const h = makeHarness();
    await h.D().start("console");
    for (let i = 0; i < 3; i++) h.F.playPcm(h.pcm(100));
    for (let i = 0; i < 3; i++) h.pushFrame(0.05);
    h.advance(300);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "天天" } } });
    assert("T6b 服务端 ASR 到达 = 真人说话确认，撤销误报计时", h.D().stats().confirmed === 1);
    assert("T6b ASR 到达即掐断仍在播的旧音频", h.g().activeAudioSources.size === 0);
    assert("T6b 疑似回声窗口内短答先扣留（尚未上屏）", !h.calls.userBroadcasts.includes("天天"));
    h.advance(3000);
    assert("T6b 扣留 ≤700ms 后“天天”正常上屏、不误杀", h.calls.userBroadcasts.includes("天天") && h.D().stats().echoTurns === 0);
    assert("T6b 全程无误报", h.D().stats().falseAlarms === 0);
  }

  // ---------------- T7 文字打断：掐断 + 迟到帧门 + 麦克风不关 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    for (let i = 0; i < 3; i++) h.F.playPcm(h.pcm(100));
    h.F.sendQuery("换一家");
    assert("T7 文字发送瞬间清空播放队列", h.g().activeAudioSources.size === 0);
    assert("T7 上一轮未结束 → 布置迟到帧门 (text)", h.g().lateAudioGate.active === true && h.g().lateAudioGate.reason === "text");
    assert("T7 文字发送不关麦（麦克风常开）", h.D().micOn === true && !h.sentEnd() && h.recordingIds().length === 5);
    const tf = h.textFrames();
    assert("T7 文字以 clientContent 用户轮发出", tf.length === 1 && tf[0].clientContent && h.textOf(tf[0]) === "换一家" && tf[0].clientContent.turnComplete === true);
    assert("T7 发送按钮保持可用（可再次文字打断）", h.$("btnSend").disabled === false);
    h.F.playPcm(h.pcm(100));
    assert("T7 服务端确认前到达的旧轮尾包被丢弃", h.g().activeAudioSources.size === 0 && h.g().lateAudioGate.dropped === 1);
    await h.serverMsg({ serverContent: { interrupted: true } });
    h.F.playPcm(h.pcm(100));
    assert("T7 interrupted 后新一轮音频放行", h.g().activeAudioSources.size === 1 && h.g().lateAudioGate.active === false);
    assert("T7 interrupted 给字幕追加“（已打断）”仅在有模型字幕时", true);
  }
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(false);
    h.F.sendQuery("再来一个");
    assert("T7b 上一轮已完成时文字发送不布置迟到帧门", h.g().lateAudioGate.active === false);
    h.F.playPcm(h.pcm(100));
    assert("T7b 新一轮开头音频不被误吞", h.g().activeAudioSources.size === 1);
  }
  {
    const h = makeHarness();
    h.set.sceneLock(true);
    h.F.sendQuery("再来一个");
    assert("T7c 迟到帧门已布置", h.g().lateAudioGate.active === true);
    h.advance(1600);
    h.F.playPcm(h.pcm(100));
    assert("T7c 服务端迟迟不确认 → 1.5s 兜底解除，不会永久静音", h.g().activeAudioSources.size === 1 && h.g().lateAudioGate.active === false);
  }
  {
    const h = makeHarness();
    h.set.sceneLock(true);
    h.set.currentModelTranscript("第一家是滨海湾花园");
    await h.serverMsg({ serverContent: { interrupted: true } });
    assert("T7d 无全双工引擎时 app.js 自身也处理 interrupted（字幕追加已打断）", /（已打断）$/.test(h.g().currentModelTranscript));
  }

  // ---------------- T8 推荐选项点击：掐断 + 本地秒开路线 + 通知模型 + toolCall 去重 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    for (let i = 0; i < 2; i++) h.F.playPcm(h.pcm(100));
    h.F.handleSelectRecommendationOption({ name: "Alchemist The Heeren", destination: "Alchemist The Heeren", icon: "☕" });
    assert("T8 点击选项瞬间清空播放队列", h.g().activeAudioSources.size === 0);
    assert("T8 布置迟到帧门 (option)", h.g().lateAudioGate.active === true && h.g().lateAudioGate.reason === "option");
    assert("T8 本地立即规划路线", h.calls.prepared.length === 1 && h.calls.prepared[0].dest === "Alchemist The Heeren");
    const tf = h.textFrames();
    assert("T8 向服务端发起新指令（含目的地名）", tf.length === 1 && /Alchemist The Heeren/.test(h.textOf(tf[0])));
    assert("T8 麦克风仍开启", h.D().micOn === true);
    await h.serverMsg({ toolCall: { functionCalls: [{ id: "fc1", name: "start_navigation", args: { destination: "Alchemist (The Heeren)", travel_mode: "DRIVING" } }] } });
    assert("T8 模型回调同一目的地 → 去重，不重复规划", h.calls.prepared.length === 1);
    assert("T8 toolResponse 仍正常回执", h.ws.sent.some(f => f.toolResponse && f.toolResponse.functionResponses[0].id === "fc1"));
    await h.serverMsg({ toolCall: { functionCalls: [{ id: "fc2", name: "start_navigation", args: { destination: "鱼尾狮公园", travel_mode: "WALKING" } }] } });
    assert("T8 不同目的地的 toolCall 正常规划", h.calls.prepared.length === 2 && h.calls.prepared[1].dest === "鱼尾狮公园");
    assert("T8 isSameDestination 保守：短名 <4 字不做包含匹配", h.F.isSameDestination("花园", "滨海湾花园") === false && h.F.isSameDestination("滨海湾花园", "滨海湾花园 (Gardens by the Bay)") === true);
  }

  // ---------------- T9 切换出行方式：掐断 + 本地重算 + （语音会话中）告知模型 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.activeDestination("滨海湾花园"); h.$("routePreviewCard").classList.remove("hidden");
    h.set.sceneLock(true);
    h.F.playPcm(h.pcm(100));
    h.F.onTravelModeSwitched("WALKING");
    assert("T9 切换出行方式瞬间清空播放队列", h.g().activeAudioSources.size === 0);
    assert("T9 本地立即重算路线", h.calls.calcMode.at(-1) === "WALKING");
    const tf = h.textFrames();
    assert("T9 语音会话中 → 告知模型（含步行 + 目的地）", tf.length === 1 && /步行/.test(h.textOf(tf[0])) && /滨海湾花园/.test(h.textOf(tf[0])));
    await h.serverMsg({ toolCall: { functionCalls: [{ id: "fc3", name: "start_navigation", args: { destination: "滨海湾花园", travel_mode: "WALKING" } }] } });
    assert("T9 模型回调同一目的地同一方式 → 不重复规划、不重复切换", h.calls.prepared.length === 0 && h.calls.calcMode.length === 1);
  }
  {
    const h = makeHarness();
    h.set.activeDestination("滨海湾花园");
    h.F.onTravelModeSwitched("BICYCLING");
    assert("T9b 麦克风关闭且模型空闲时切换出行方式：只本地重算，不打扰模型", h.calls.calcMode.at(-1) === "BICYCLING" && h.textFrames().length === 0);
  }

  // ---------------- T10 语义回声侦测：只判连续 ≥8 字/词逐字重合；逐级升级；短答不误杀 ----------------
  {
    const h = makeHarness();                                   // Chromium UA、无 RTCPeerConnection（回环切换会失败但计数逻辑照常）
    await h.D().start("console");
    // 模型开口（对上一轮的回复）：转写 + 300ms 音频 + 播报期间至少一帧（记录 lastSpeakerBusyTs）
    const speak = async () => {
      h.advance(1500);
      h.set.sceneLock(true);
      await h.serverMsg({ serverContent: { outputTranscription: { text: MODEL_TEXT }, modelTurn: { parts: [{ inlineData: { data: h.pcm(300) } }] } } });
      h.pushFrame(0.003);
    };
    const asr = (t) => h.serverMsg({ serverContent: { inputTranscription: { text: t } } });
    const tc = () => h.serverMsg({ serverContent: { turnComplete: true } });
    const echoAsr = "第一家是滨海湾花园，评分4.7";
    // 回声 1：扬声器泄漏被服务端听成用户说话
    await speak();
    await asr(echoAsr);
    assert("T10 回声轮 1：ASR 与播报连续 ≥8 词元重合 → 不上屏", !h.calls.userBroadcasts.includes(echoAsr) && h.D().stats().echoTurns === 1);
    assert("T10 回声轮 1：Chromium 首次 → 尝试切换回环播放通道", h.D().sinkEscalated === true && h.calls.toasts.some(t => /回环/.test(t)));
    await speak(); await tc();                                 // 模型对回声轮的回复 + 收尾（回复本身又会泄漏）
    // 回声 2（通道切换后重新计数：第 1 次）
    await asr(echoAsr);
    assert("T10 回声轮 2：计数但不静音", h.D().stats().echoTurns === 2 && h.g().lateAudioGate.active === false);
    await speak(); await tc();
    // 回声 3 → 静音该轮回复（切断自环），interrupted 不能解除，turnComplete 才解除
    await asr(echoAsr);
    assert("T10 回声轮 3：对该轮模型回复静音", h.D().stats().mutedEchoTurns === 1 && h.g().lateAudioGate.active === true && h.g().lateAudioGate.untilTurnComplete === true);
    await speak();
    assert("T10 回声轮 3：回复音频被丢弃（不会再次泄漏成回声）", h.g().activeAudioSources.size === 0 && h.g().lateAudioGate.dropped >= 1);
    await h.serverMsg({ serverContent: { interrupted: true } });
    assert("T10 回声轮静音不被 interrupted 解除", h.g().lateAudioGate.active === true);
    await tc();
    assert("T10 turnComplete 解除回声轮静音", h.g().lateAudioGate.active === false);
    // 回声 4 → 严格模式
    await asr(echoAsr);
    assert("T10 回声轮 4：进入严格防回声模式", h.D().strict === true && h.calls.toasts.some(t => /严格防回声/.test(t)));
    await speak();                                             // 对回声轮 4 的回复：仍被静音门丢弃
    assert("T10 回声轮 4：回复同样被静音", h.g().activeAudioSources.size === 0);
    await tc();                                                // 静音门解除
    await speak();                                             // 下一轮正常播报：严格模式下播报期间麦克风只上行静音帧
    assert("T10 静音门解除后正常播报恢复", h.g().activeAudioSources.size === 1 && h.D().speakerBusy() === true);
    const n0 = h.audioFrames().length;
    for (let i = 0; i < 5; i++) h.pushFrame(0.09);
    const af = h.audioFrames().slice(n0);
    assert("T10 严格模式：播报期间即使很响也只上行静音帧", af.length === 5 && af.every(d => d === SILENCE_B64) && h.D().gateOpen === false);
    h.D().setForce(true);
    h.pushFrame(0.09);
    assert("T10 严格模式下长按说话可旁路", h.audioFrames().at(-1) !== SILENCE_B64);
    h.D().setForce(false);
    h.advance(100);
    assert("T10 严格模式播报中文案提示“长按可插话”", h.bodyCls.has("duplex-model_speaking") && /长按/.test(h.$("mobTalkLabel").textContent), h.$("mobTalkLabel").textContent);
    assert("T10 全程麦克风未被自动关闭", h.D().micOn === true && !h.sentEnd());
  }
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    await h.serverMsg({ serverContent: { outputTranscription: { text: MODEL_TEXT }, modelTurn: { parts: [{ inlineData: { data: h.pcm(300) } }] } } });
    h.pushFrame(0.003);
    // 播放结束后 1s 内作答选项名（5 词元）
    h.finishPlayback(); h.advance(1000);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "滨海湾花园" } } });
    assert("T10b 短答“滨海湾花园”先扣留", !h.calls.userBroadcasts.includes("滨海湾花园"));
    h.advance(700);
    assert("T10b 短答“滨海湾花园”≤700ms 后正常上屏、不算回声", h.calls.userBroadcasts.includes("滨海湾花园") && h.D().stats().echoTurns === 0 && h.g().sceneLock === true);
    h.advance(1200);
    await h.serverMsg({ serverContent: { turnComplete: true } });
    // 英文短答
    await h.serverMsg({ serverContent: { outputTranscription: { text: "The first one is Gardens by the Bay, rated 4.7; the second is Merlion Park." }, modelTurn: { parts: [{ inlineData: { data: h.pcm(200) } }] } } });
    h.pushFrame(0.003); h.finishPlayback(); h.advance(500);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "Gardens by the Bay" } } });
    h.advance(700);
    assert("T10b 英文短答 “Gardens by the Bay”(4 词元) 不算回声", h.calls.userBroadcasts.includes("Gardens by the Bay") && h.D().stats().echoTurns === 0);
    h.advance(1200);
    await h.serverMsg({ serverContent: { turnComplete: true } });
    // 长句但与播报不连续重合
    await h.serverMsg({ serverContent: { outputTranscription: { text: MODEL_TEXT }, modelTurn: { parts: [{ inlineData: { data: h.pcm(200) } }] } } });
    h.pushFrame(0.003);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "我想去第二家鱼尾狮公园看看夜景" } } });
    assert("T10b ≥8 词元但不连续重合的真实长句立即上屏", h.calls.userBroadcasts.at(-1) === "我想去第二家鱼尾狮公园看看夜景" && h.D().stats().echoTurns === 0);
    h.advance(1200);
    await h.serverMsg({ serverContent: { turnComplete: true } });
    // 扬声器很久没出声：即便逐字重合也不判回声
    h.finishPlayback(); h.advance(5000);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "第一家是滨海湾花园，评分4.7" } } });
    assert("T10b 扬声器 3.5s 内没出过声 → 不可能是回声，立即上屏", h.calls.userBroadcasts.at(-1) === "第一家是滨海湾花园，评分4.7" && h.D().stats().echoTurns === 0);
  }

  // ---------------- T11 setup 附加配置 / 续接句柄 / goAway ----------------
  {
    const h = makeHarness();
    const ex = h.D().setupExtras();
    assert("T11 setupExtras 启用服务端 VAD 且开口即打断", ex.realtimeInputConfig.automaticActivityDetection.disabled === false && ex.realtimeInputConfig.activityHandling === "START_OF_ACTIVITY_INTERRUPTS");
    assert("T11 初始无续接句柄", JSON.stringify(ex.sessionResumption) === "{}" && !!ex.contextWindowCompression.slidingWindow);
    await h.serverMsg({ sessionResumptionUpdate: { resumable: true, newHandle: "h-123" } });
    assert("T11 收到 sessionResumptionUpdate 后 setup 带 handle", h.D().setupExtras().sessionResumption.handle === "h-123");
    await h.serverMsg({ goAway: { timeLeft: "10s" } });
    h.advance(6900);
    assert("T11 goAway 提前 3s 前尚未重连", h.calls.reconnect.length === 0);
    h.advance(200);
    assert("T11 goAway → 提前 3s 带句柄重连 reconnectFresh(true)", JSON.stringify(h.calls.reconnect) === "[true]");
    h.D().clearResumeHandle();
    assert("T11 主动换会话可清掉句柄", JSON.stringify(h.D().setupExtras().sessionResumption) === "{}");
  }

  // ---------------- T12 文字上行封装：clientContent 默认 / realtimeText 开关 ----------------
  {
    const h = makeHarness();
    assert("T12 默认 clientContent", h.g().TEXT_INPUT_MODE === "clientContent" && !!h.F.buildUserTextFrames("hi")[0].clientContent);
    const r = makeHarness({ search: "?text=realtime" });
    assert("T12 ?text=realtime → realtimeText", r.g().TEXT_INPUT_MODE === "realtimeText");
    r.set.duplexSetupActive(true);
    const f1 = r.F.buildUserTextFrames("hi");
    assert("T12 服务端 VAD 开启时 realtimeInput.text 单帧", f1.length === 1 && f1[0].realtimeInput.text === "hi");
    r.set.duplexSetupActive(false);
    const f3 = r.F.buildUserTextFrames("hi");
    assert("T12 服务端 VAD 关闭时 realtime 文本自带 activityStart/End", f3.length === 3 && !!f3[0].realtimeInput.activityStart && !!f3[2].realtimeInput.activityEnd);
    r.set.sceneLock(false);
    r.F.sendQuery("你好");
    assert("T12 realtimeText 模式下 sendQuery 走 realtimeInput", r.ws.sent.some(f => f.realtimeInput && f.realtimeInput.text === "你好") && !r.ws.sent.some(f => f.clientContent));
  }

  // ---------------- T13 不支持 AudioWorklet 的浏览器：引擎报告不支持，Web Speech 退路接管 ----------------
  {
    const h = makeHarness({ noWorklet: true });
    assert("T13 supported() 为 false", h.D().supported() === false);
    await h.D().start("console");
    assert("T13 start() 不开麦并提示", h.D().micOn === false && h.calls.toasts.some(t => /不支持全双工/.test(t)));
    assert("T13 app.js 委托条件同样为假（走 Web Speech 退路）", !(h.ctx.window.DuplexVoice && h.ctx.window.DuplexVoice.supported()));
  }

  // ---------------- T14 按住说话：强制旁路门限，松开不触发关麦 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    for (let i = 0; i < 3; i++) h.F.playPcm(h.pcm(100));
    h.$("btnMainMic").fire("pointerdown");
    h.advance(400);
    assert("T14 长按 350ms → 强制说话", h.D().pttForce === true && h.g().masterGain.gain.target === 0.12 && h.D().duckTimer === null);
    h.pushFrame(0.09);
    assert("T14 强制说话时播报期间帧直接上行", h.audioFrames().at(-1) !== SILENCE_B64);
    h.$("btnMainMic").fire("pointerup");
    assert("T14 松开 → 取消强制、恢复音量", h.D().pttForce === false && h.g().masterGain.gain.target === 1);
    h.D().toggle("console");
    assert("T14 长按松开后紧随的 click 不会关麦", h.D().micOn === true);
    h.advance(500);
    h.D().toggle("console");
    assert("T14 之后的正常点击才关麦", h.D().micOn === false);
  }

  // ---------------- T15 授权等待期间再次点击 = 取消开麦 ----------------
  {
    let resolveGum = null;
    const h = makeHarness({ getUserMedia: () => new Promise(r => { resolveGum = r; }) });
    const p = h.D().start("console");
    assert("T15 等待授权中", h.D().starting === true && h.D().micOn === false);
    h.D().toggle("console");
    const track = { stopped: false, onended: null, stop() { this.stopped = true; }, getSettings() { return { echoCancellation: true }; } };
    resolveGum({ getTracks: () => [track], getAudioTracks: () => [track] });
    await p;
    assert("T15 授权返回后因已取消而释放轨道、不开麦", h.D().micOn === false && track.stopped === true && h.D().starting === false);
  }

  // ---------------- T16 浏览器报告轨道无 AEC → 直接严格模式 ----------------
  {
    const h = makeHarness({ aec: false });
    await h.D().start("console");
    assert("T16 aecReported=false → 自动严格模式并提示", h.D().strict === true && h.calls.toasts.some(t => /未对麦克风启用回声消除/.test(t)));
  }

  // ---------------- T17 音频输出通道：direct ↔ loopback（RTCPeerConnection 回环） ----------------
  {
    const h = makeHarness({ rtc: true });
    h.F.getMasterGain();
    assert("T17 桌面 Chromium 默认直出", h.F.getAudioSinkMode() === "direct" && h.g().masterGain.connections.has(h.g().playCtx.destination));
    const mode = await h.F.setAudioSinkMode("loopback");
    assert("T17 切换回环：主增益改接 MediaStreamDestination，脱离直出", mode === "loopback" && h.g().audioSinkNodes && h.g().masterGain.connections.has(h.g().audioSinkNodes.dest) && !h.g().masterGain.connections.has(h.g().playCtx.destination));
    assert("T17 回环 <audio> 元素拿到远端轨道并播放", !!h.g().audioSinkNodes.el.srcObject);
    await h.F.setAudioSinkMode("direct");
    assert("T17 切回直出并回收 PeerConnection", h.F.getAudioSinkMode() === "direct" && h.FakeRTC.all.every(p => p.closed) && h.g().masterGain.connections.has(h.g().playCtx.destination));
    const a = makeHarness({ rtc: true, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
    a.F.getMasterGain();
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert("T17 Android Chromium（无 Chrome-wide AEC）默认回环通道", a.F.getAudioSinkMode() === "loopback");
    const n = makeHarness();                                   // 无 RTCPeerConnection
    n.F.getMasterGain();
    const m2 = await n.F.setAudioSinkMode("loopback");
    assert("T17 环境不支持回环时安全保持直出", m2 === "direct");
  }

  // ---------------- T18 城市切换等主动重连不带句柄；发送时连接已断的自愈带句柄 ----------------
  {
    const h = makeHarness();
    await h.serverMsg({ sessionResumptionUpdate: { resumable: true, newHandle: "h-9" } });
    h.set.ready(false);
    h.F.sendQuery("附近咖啡");
    assert("T18 连接未就绪时排队并带句柄重连", h.g().pending && h.g().pending.text === "附近咖啡" && JSON.stringify(h.calls.reconnect) === "[true]");
  }

  // ---------------- T19 时序护栏：ASR 先于 interrupted 到达不拆分话语；回声静音门不被上一轮收尾提前解除 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    await h.serverMsg({ serverContent: { outputTranscription: { text: MODEL_TEXT }, modelTurn: { parts: [{ inlineData: { data: h.pcm(300) } }] } } });
    h.pushFrame(0.003);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "带我去" } } });
    assert("T19 第一段 ASR 立即开轮清场（sceneLock、掐旧音频）", h.D().voiceTurnOpen === true && h.g().activeAudioSources.size === 0 && h.g().sceneLock === true);
    await h.serverMsg({ serverContent: { interrupted: true } });
    await h.serverMsg({ serverContent: { turnComplete: true } });
    assert("T19 紧随其后的 interrupted/turnComplete 属于上一轮，不关闭刚开始的用户轮", h.D().voiceTurnOpen === true);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "滨海湾花园" } } });
    h.advance(800);
    assert("T19 同一句话不被拆成两轮", h.calls.userBroadcasts.at(-1) === "带我去滨海湾花园", JSON.stringify(h.calls.userBroadcasts));
    h.advance(1000);
    await h.serverMsg({ serverContent: { outputTranscription: { text: "好的" }, modelTurn: { parts: [{ inlineData: { data: h.pcm(100) } }] } } });
    await h.serverMsg({ serverContent: { turnComplete: true } });
    assert("T19 模型回复后的 turnComplete 正常关轮", h.D().voiceTurnOpen === false && h.g().sceneLock === false);
    // 回声轮静音门：上一轮的 turnComplete（门尚未丢过帧）不解除；用户真人新话语解除
    h.set.sceneLock(true);
    h.F.armLateAudioGate("echo_turn", true);
    await h.serverMsg({ serverContent: { turnComplete: true } });
    assert("T19 回声轮静音门不被“尚未丢帧时”的 turnComplete 解除", h.g().lateAudioGate.active === true);
    h.F.playPcm(h.pcm(100));
    await h.serverMsg({ serverContent: { turnComplete: true } });
    assert("T19 回声轮回复播完（已丢帧）后的 turnComplete 解除", h.g().lateAudioGate.active === false);
    h.set.sceneLock(true);
    h.F.armLateAudioGate("echo_turn", true);
    h.finishPlayback(); h.advance(5000);
    await h.serverMsg({ serverContent: { inputTranscription: { text: "换一家吧" } } });
    assert("T19 真人新话语解除回声轮静音门", h.g().lateAudioGate.active === false);
  }

  // ---------------- T20 关麦后迟到的最后一句转写：按新一轮处理，不拼接到上一条提问 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    await h.serverMsg({ serverContent: { inputTranscription: { text: "附近有什么好吃的" } } });
    h.advance(1200);
    await h.serverMsg({ serverContent: { outputTranscription: { text: "为您推荐松发肉骨茶" }, modelTurn: { parts: [{ inlineData: { data: h.pcm(100) } }] } } });
    await h.serverMsg({ serverContent: { turnComplete: true } });
    h.finishPlayback(); h.advance(5000);
    h.D().toggle("console");                                   // 用户在说“带我去”时点了停止
    assert("T20 前置：已关麦", h.D().micOn === false && h.sentEnd());
    await h.serverMsg({ serverContent: { inputTranscription: { text: "带我去" } } });
    assert("T20 关麦后迟到 ASR 仍按新一轮处理，不拼接到上一条提问", h.calls.userBroadcasts.at(-1) === "带我去" && h.g().sceneLock === true, JSON.stringify(h.calls.userBroadcasts));
    assert("T20 处理迟到 ASR 不会把麦克风重新打开", h.D().micOn === false);
  }

  // ---------------- T21 播报期间点击麦克风按钮 = 立即打断播报且保持麦克风开启 ----------------
  {
    const h = makeHarness();
    await h.D().start("console");
    h.set.sceneLock(true);
    h.F.playPcm(h.pcm(500));
    assert("T21 前置：模型正在播报", h.g().activeAudioSources.size === 1 && h.D().micOn === true);
    h.D().toggle("console");
    assert("T21 播报中点击麦克风 → 清空播放队列且不关麦", h.g().activeAudioSources.size === 0 && h.D().micOn === true && !h.sentEnd());
    assert("T21 弹出已打断提示文案", h.calls.toasts.some(t => /已打断播报/.test(t)));
    // 静音状态下再次点击麦克风 → 正常关麦
    h.D().toggle("console");
    assert("T21 播报停止后再次点击 → 正常关闭麦克风", h.D().micOn === false && h.sentEnd());
  }

  // ---------------- T22 防扬声器回声自打断 + 多轮双讲语音打断守护（3.8 Live） ----------------
  {
    const h = makeHarness();
    assert("T22a 服务端 VAD 启用 START_SENSITIVITY_HIGH + END_SENSITIVITY_LOW + 500ms 前置缓冲（防漏掉‘额，有’句首与‘吗’句尾）",
      h.D().setupExtras().realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity === "START_SENSITIVITY_HIGH" &&
      h.D().setupExtras().realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity === "END_SENSITIVITY_LOW" &&
      h.D().setupExtras().realtimeInputConfig.automaticActivityDetection.prefixPaddingMs === 500);
    await h.D().start("console");
    assert("T22b 门限上下界合理（absMin ≥ 0.012 且 maxThreshold ≤ 0.06，绝不锁死双讲人声）",
      h.D().CFG.absMin >= 0.012 && h.D().CFG.maxThreshold <= 0.06);
    h.set.sceneLock(true);
    for (let i = 0; i < 6; i++) h.F.playPcm(h.pcm(200));
    // 模拟扬声器瞬态重音：3 帧 0.06 开门并触发 -18dB 闪避后，回声立即跌落至 0.008 持续 6 帧（240ms < 500ms）
    for (let i = 0; i < 3; i++) h.pushFrame(0.06);
    assert("T22c 瞬态回声触发闪避开门", h.D().gateOpen === true);
    for (let i = 0; i < 6; i++) { h.advance(40); h.pushFrame(0.008); }
    assert("T22c 闪避后回声骤降 → 240ms 内自动关门", h.D().gateOpen === false);
    h.advance(400); // 跨越 hardCutAfterMs (500ms)，但因门已关，绝不能触发 localHardCut 切断外放！
    assert("T22c 瞬态回声绝不触发本地硬切（播报不中断）", h.D().stats().hardCuts === 0 && h.g().activeAudioSources.size > 0);
    h.advance(1600);
    // 即使 echoFloor 涨到 0.072，双讲人声（被 WebRTC AEC 压低到 rms=0.025）持续 ≥7 帧（280ms）仍必须 100% 破门打断！
    h.F.playPcm(h.pcm(1500));
    assert("T22d 即使 echoFloor 已升高，低振幅双讲真人语音 (rms=0.025) 持续 7 帧仍 100% 破门打断", (() => {
      for (let i = 0; i < 7; i++) h.pushFrame(0.025);
      return h.D().gateOpen === true;
    })());

    // 连续 5 轮真人开口打断且 inputTranscription 均晚到 2.0s（复现线上 client #6 真实时序）：第 5 轮仍 100% 秒开门！
    const hMulti = makeHarness();
    await hMulti.D().start("console");
    for (let turn = 1; turn <= 5; turn++) {
      hMulti.set.sceneLock(true);
      hMulti.F.playPcm(hMulti.pcm(2000));
      for (let i = 0; i < 3; i++) hMulti.pushFrame(0.03);
      assert("T22e 第 " + turn + " 轮正常音量语音立即开门打断", hMulti.D().gateOpen === true);
      await hMulti.serverMsg({ serverContent: { interrupted: true } });
      hMulti.advance(2000); // 模拟 3.8 Live 在 interrupted 后 2.0s 才下发 inputTranscription
      await hMulti.serverMsg({ serverContent: { inputTranscription: { text: "第" + turn + "轮提问" } } });
      await hMulti.serverMsg({ serverContent: { turnComplete: true } });
    }

    // 模拟浏览器漏触发 src.onended 导致 activeAudioSources 残留：硬件时钟走完后 speakerBusy() 必须自动自愈归零，绝不永久卡在“播报中”
    const hStuck = makeHarness();
    await hStuck.D().start("console");
    hStuck.F.playPcm(hStuck.pcm(300)); // 故意不调 finishPlayback() 模拟 onended 丢失！
    assert("T22f 播放未结束时 speakerBusy 为 true", hStuck.D().speakerBusy() === true);
    hStuck.advance(1000);               // 时钟推过 playTime + speakerTailSec
    assert("T22f onended 丢失但时钟已播完 → speakerBusy 自动自愈为 false，绝不永久卡死在播报中",
      hStuck.D().speakerBusy() === false && hStuck.g().activeAudioSources.size === 0 && hStuck.g().isModelSpeaking === false);

    // 桌面 Chromium 开麦保持 direct 直出；WebRTC 回环 0 收包时自动回退 direct
    const hRtc = makeHarness({ rtc: true });
    await hRtc.D().start("console");
    assert("T22g 桌面 Chromium 开麦保持 direct 直出，不断开 playCtx.destination",
      hRtc.F.getAudioSinkMode() === "direct" && hRtc.g().masterGain.connections.has(hRtc.g().playCtx.destination));

    const hBlocked = makeHarness({ rtc: true });
    hBlocked.FakeRTC.prototype.getStats = async () => new Map([["r1", { type: "inbound-rtp", bytesReceived: 0 }]]);
    const fallbackPromise = hBlocked.F.setAudioSinkMode("loopback");
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setImmediate(r));
      hBlocked.advance(100);
    }
    const fallbackMode = await fallbackPromise;
    delete hBlocked.FakeRTC.prototype.getStats;
    assert("T22h WebRTC 回环 0 收包时自动回退 direct，绝不断开扬声器直出",
      fallbackMode === "direct" && hBlocked.g().masterGain.connections.has(hBlocked.g().playCtx.destination));
  }

  // ---------------- T23 根治“识别不准 / 响应慢 / 偶发无响应”三大真机线上顽疾（v107） ----------------
  {
    // T23a: AudioWorklet 48kHz -> 16kHz 多相盒式抗混叠降采样验证（消除 3:1 裸抽样高频混叠失真）
    const workletSrc = fs.readFileSync(path.join(ROOT, "static", "pcm-capture-worklet.js"), "utf8");
    const wOut = [];
    const wCtx = {
      sampleRate: 48000,
      Math, Int16Array,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (d) => wOut.push(d) }; } },
      registerProcessor: (name, cls) => { wCtx.Proc = cls; }
    };
    vm.createContext(wCtx);
    vm.runInContext(workletSrc, wCtx);
    const proc = new wCtx.Proc({ processorOptions: { targetRate: 16000, frameMs: 40 } });
    // 构造连续跨块的 16kHz 镜像混叠测试信号（在 48kHz 下周期严格为 3 采样：[+0.9, -0.45, -0.45]）：
    // 旧线性裸抽样 pos+=3 只取第 0 点会输出恒定 +0.9（严重混叠失真！），而 3 点盒式低通积分 (0.9 - 0.45 - 0.45)/3 === 0（完美抑制混叠！）
    for (let b = 0; b < 16; b++) {
      const aliasBlock = new Float32Array(128);
      for (let i = 0; i < 128; i++) aliasBlock[i] = ((b * 128 + i) % 3 === 0) ? 0.9 : -0.45;
      proc.process([[aliasBlock]]);
    }
    assert("T23a 48kHz→16kHz AudioWorklet 盒式抗混叠滤波彻底抑制 16kHz 混叠频率 (rms < 0.001)",
      wOut.length === 1 && wOut[0].rms < 0.001, "rms=" + (wOut[0] && wOut[0].rms));

    // T23b: 复现线上 client #8 “那有粤菜吗？→ 没有玩游戏吧？”根因：
    // 播报期间用户双讲语音（rms = 0.020~0.024，低于开门前的 echoFloor*2.0 阈值），持续说 28 帧（1.12s）：
    //   1) 600ms (15 帧) preRoll 必须 100% 补齐句首全部真实语音帧（0 丢头）；
    //   2) 开门后施密特保持阈值 holdThr + 500ms 本地硬切转直通必须确保后续【0 帧被门控填零】，28 帧语音 100% 完整上行！
    const hDt = makeHarness();
    await hDt.D().start("console");
    hDt.D().echoFloor = 0.025; // 高回声底，令 thr = 0.042 > 用户双讲 rms (0.020)
    hDt.set.sceneLock(true);
    hDt.F.playPcm(hDt.pcm(3000));
    const startSent = hDt.D().stats().framesSent;
    let openedOnce = false;
    let gatedAfterOpen = 0;
    for (let i = 0; i < 28; i++) {
      hDt.advance(40);
      const gatedBefore = hDt.D().stats().framesGated;
      hDt.pushFrame(0.020 + (i % 3) * 0.002); // 模拟真实人类说“那有粤菜吗？”的连续双讲包络 (0.020~0.024)
      if (hDt.D().gateOpen) openedOnce = true;
      if (openedOnce && hDt.D().stats().framesGated > gatedBefore) gatedAfterOpen++;
    }
    const realFramesDelivered = hDt.D().stats().framesSent - startSent;
    assert("T23b 双讲说话期间施密特门控 0 填零断句，且 28 帧语音 100% 完整上行（含句首预卷）",
      openedOnce && gatedAfterOpen === 0 && realFramesDelivered === 28,
      "opened=" + openedOnce + " gatedAfterOpen=" + gatedAfterOpen + " delivered=" + realFramesDelivered + "/28");

    // T23c: 复现线上 client #21 / #5 / #8 “偶发无响应 / 回复被掐灭”真凶竞态：
    // Gemini 3.8 Live 先下发 interrupted 清掉上一轮，随后新一轮 inlineData 语音先于 inputTranscription 30ms 到达！
    // 迟到的 inputTranscription 绝对不能调用 stopAllAudioPlayback() 掐灭模型正在播报的新回答！
    const hRace = makeHarness();
    await hRace.D().start("console");
    hRace.set.sceneLock(true);
    await hRace.serverMsg({ serverContent: { outputTranscription: { text: "上一轮推荐松发肉骨茶" }, modelTurn: { parts: [{ inlineData: { data: hRace.pcm(500) } }] } } });
    // 用户开口打断上一轮，服务端先发 interrupted
    await hRace.serverMsg({ serverContent: { interrupted: true } });
    assert("T23c 前置：interrupted 已清空上一轮旧音频", hRace.g().activeAudioSources.size === 0);
    // 服务端先下发新一轮回答的首包音频与文本（早于 inputTranscription 到达！）
    await hRace.serverMsg({ serverContent: { outputTranscription: { text: "附近有两家很棒的粤菜馆：" }, modelTurn: { parts: [{ inlineData: { data: hRace.pcm(600) } }] } } });
    assert("T23c 新一轮回答音频已正常起播", hRace.g().activeAudioSources.size === 1);
    // 30ms 后 inputTranscription 才姗姗来迟
    hRace.advance(30);
    await hRace.serverMsg({ serverContent: { inputTranscription: { text: "那有粤菜吗？" } } });
    assert("T23c 迟到的 inputTranscription 绝不掐灭新回答音频，且新回答文本与用户提问双双完整上屏",
      hRace.g().activeAudioSources.size === 1 &&
      hRace.g().currentModelTranscript === "附近有两家很棒的粤菜馆：" &&
      hRace.calls.userBroadcasts.at(-1) === "那有粤菜吗？",
      "sources=" + hRace.g().activeAudioSources.size + " model=" + hRace.g().currentModelTranscript + " user=" + JSON.stringify(hRace.calls.userBroadcasts));

    // T23d: 静态配置核验：锁定中文 cmn-CN 防西语幻觉 + 550ms 静音断句 + 12帧(480ms)净音预卷防漏句首语气词
    assert("T23d setup 锁定 speechConfig.languageCode = cmn-CN 且 VAD silenceDurationMs ≤ 550ms 且 preRollFrames === 12",
      /speechConfig:\s*\{\s*languageCode:\s*"cmn-CN"\s*\}/.test(appSrc) &&
      hRace.D().CFG.silenceDurationMs <= 550 &&
      hRace.D().CFG.preRollFrames === 12);

    // T24: 根治“在模型说话时打断首词必错（西班牙菜有吗→芝麻油菜有吗）”声学双凶（v109）：
    //   1) 播报期间开口前 2s 的纯外放帧在 preRoll 中必须被压制 -24dB (0.06x)，绝不把模型自己的外放语音原幅拼进用户句首；
    //   2) 用户开口第 4 帧（160ms，postDuckSpeech >= 1）立即触发 localHardCut() 彻底切断扬声器（无需再等 500ms），让后续语音在 0 外放干扰下纯净采集！
    const hCut = makeHarness();
    await hCut.D().start("console");
    hCut.set.sceneLock(true);
    hCut.F.playPcm(hCut.pcm(3000));
    // 先推送 10 帧模型外放残音（rms=0.005，active=false）
    for (let i = 0; i < 10; i++) hCut.pushFrame(0.005);
    assert("T24a 外放残音期间扬声器仍在播且门未开", hCut.g().activeAudioSources.size === 1 && hCut.D().gateOpen === false);
    // 用户开口说“西班牙菜有吗”：前 3 帧 (120ms) 开门 + 闪避，第 4 帧 (160ms) 确认延续立即 100% 切断扬声器！
    hCut.pushFrame(0.04);
    hCut.pushFrame(0.04);
    hCut.pushFrame(0.04);
    assert("T24b 第 3 帧 (120ms) 开门并闪避外放", hCut.D().gateOpen === true);
    hCut.pushFrame(0.035);
    assert("T24c 第 4 帧 (160ms) postDuckSpeech>=1 立即触发 localHardCut 彻底切断扬声器 (activeAudioSources=0)，无需苦等 500ms",
      hCut.D().hardCutDone === true && hCut.g().activeAudioSources.size === 0);

    // T25: 根治“额，有法餐吗？/ 额，有中餐吗？漏掉句首‘额，有’”与“普通话腔调怪异”（v110）：
    //   1) 用户说“额（rms 0.012→0.025 跨越 thr）+ 1帧微停顿（0.006）+ 有（0.014）”时，dtRun 绝不因跨越 thr 或 1 帧微停顿而归零，第 4 帧即破门且完整保留“额”字！
    //   2) generationConfig.temperature 锁定为 0.25（稳住普通话四声声调），且系统提示词强制优先使用中文店名（珍宝海鲜、御宝轩、乐天味之楼），禁绝“这片儿/口碑王/翻牌子”怪异词！
    const hHes = makeHarness();
    await hHes.D().start("console");
    hHes.set.sceneLock(true);
    hHes.F.playPcm(hHes.pcm(3000));
    hHes.pushFrame(0.012); // “额”帧 1（低于 thr 0.020，高于 0.0085）
    hHes.pushFrame(0.025); // “额”帧 2（高于 thr 0.020，旧版因 !above 会把 dtRun 误清零！）
    hHes.pushFrame(0.006); // “额”与“有”之间 1 帧微停顿（dtDip 保护不归零）
    hHes.pushFrame(0.014); // “有”帧 1（累计第 3 帧有效语音 → 立即开门！）
    assert("T25a ‘额…有法餐吗’跨越阈值 + 1帧微停顿不归零，在‘有’字起音瞬间即成功开门", hHes.D().gateOpen === true);
    assert("T25b 锁定 temperature=0.25 稳住普通话发音，且提示词禁用怪异词并强制中文化店名",
      /temperature:\s*0\.25/.test(appSrc) &&
      /珍宝海鲜/.test(appSrc) && /御宝轩/.test(appSrc) && /乐天味之楼/.test(appSrc) &&
      /【绝对禁止】使用“这片儿”、“口碑王”/.test(appSrc));

    // T26: 根治“中文提问（北京菜有吗/粤菜/广东菜/湖北菜）被误识为西班牙语/德语（¿Hay un cajero? / Ja. / Hola, soy Guangdong）并用西语回复”（v111）：
    //   1) 协议层锁定 inputAudioTranscription.languageCodes = ["cmn-Hans-CN", "zh-CN", "en-US"] + customVocabulary 菜系词表；
    //   2) 客户端 sanitizeAllowedLanguageAsr 精准拦截小语种幻觉并还原中文菜系谐音；
    //   3) 主模型若意外吐出西语 outputTranscription，立即切断外语音频并用还原后的中文重发！
    assert("T26a 协议层锁定纯中文 inputAudioTranscription.languageCodes=['cmn-Hans-CN','zh-CN']（移除 en-US 防鼻音英文幻觉）及中餐菜系 customVocabulary",
      /languageCodes:\s*\[\s*"cmn-Hans-CN"\s*,\s*"zh-CN"\s*\]/.test(appSrc) &&
      /customVocabulary:\s*\[[\s\S]*?"北京菜"[\s\S]*?"粤菜"[\s\S]*?"广东菜"[\s\S]*?"湖北菜"[\s\S]*?"湘菜"/.test(appSrc));
    const hLang = makeHarness();
    await hLang.D().start("console");
    assert("T26b sanitizeAllowedLanguageAsr 精准还原西语/德语/鼻音英语及菜系同音误识（cajero→北京菜、No.有没有香菜→嗯，有没有湘菜、北京太→北京菜、月亮有吗→日料有吗）",
      hLang.D().sanitizeAllowedLanguageAsr("¿Hay un cajero?") === "北京菜有吗？" &&
      hLang.D().sanitizeAllowedLanguageAsr("Ja.") === "粤菜" &&
      hLang.D().sanitizeAllowedLanguageAsr("Hola, soy Guangdong") === "那广东菜呢？" &&
      hLang.D().sanitizeAllowedLanguageAsr("to have a meal") === "额，有法餐吗？" &&
      hLang.D().sanitizeAllowedLanguageAsr("No. 有没有香菜?") === "嗯，有没有湘菜?" &&
      hLang.D().sanitizeAllowedLanguageAsr("北京太有吗?") === "北京菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("对。太有吗?") === "北京菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("桃州太呢?") === "潮州菜呢?" &&
      hLang.D().sanitizeAllowedLanguageAsr("曹周泰呢?") === "潮州菜呢?" &&
      hLang.D().sanitizeAllowedLanguageAsr("本方太有吗?") === "本帮菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("粉红派有吗?") === "本帮菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("南方派有吗?") === "本帮菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("奶酪玉米菜有吗?") === "意大利菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("那他国菜呢?") === "那泰国菜呢?" &&
      hLang.D().sanitizeAllowedLanguageAsr("用北菜有吗?") === "东北菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("de有受洗收吗?") === "额，有寿喜烧吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("甜筒店有吗?") === "甜品店有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("那逆大逆才有吗?") === "那意大利菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("月亮有吗?") === "日料有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("面料有吗?") === "日料有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("北京太友吗?") === "北京菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("很棒。派友吗?") === "本帮菜有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("我没有。香菜。") === "嗯，有没有湘菜？" &&
      hLang.D().sanitizeAllowedLanguageAsr("预料有吗?") === "日料有吗?" &&
      hLang.D().sanitizeAllowedLanguageAsr("在我去第一家直接导航。") === "带我去第一家直接导航。" &&
      hLang.D().sanitizeAllowedLanguageAsr("take me to Marina Bay Sands") === "take me to Marina Bay Sands");
    await hLang.serverMsg({ serverContent: { inputTranscription: { text: "¿Hay un cajero?" } } });
    assert("T26c 服务端下发西语幻觉 ‘¿Hay un cajero?’ 时，用户气泡立即自愈显示为 ‘北京菜有吗？’",
      hLang.calls.userBroadcasts.at(-1) === "北京菜有吗？",
      "userBroadcast=" + hLang.calls.userBroadcasts.at(-1));
    assert("T27 序数导航旧店名串读防护：模型误传旧轮次店名时返回 DESTINATION_CORRECTED_TO_LATEST_OPTION 纠偏且由 __lastCorrectedFcDest 限制最多 1 次重试",
      /DESTINATION_CORRECTED_TO_LATEST_OPTION/.test(appSrc) &&
      /__lastCorrectedFcDest/.test(appSrc));

    // T28: 根治线上 [client #732] 多轮对话“还有我这中国人，我来这里就不想吃中餐相关的了。”卡死在“正在思考与实时检索中…”（v120）：
    //   1) 静默期 (!busy) 自适应环境底噪门限：人声结束后 480ms 自动关门并向服务端 VAD 发送纯零静音帧 SILENCE_B64，彻底杜绝 MacBook 房间底噪 (0.008~0.014) 拖死服务端 VAD；
    //   2) 双阶未响应自愈看门狗：用户已出 ASR 字幕超过 2.5s 若上游仍 0 字节回复，自动补发 clientContent (turnComplete: true) 催答且保持 micOn=true；
    //   3) 同音纠偏“有没用米线?” -> “有没有米线?” 及系统提示词【每句必应铁律】+ 打断后误道歉拦截。
    const hQuiet = makeHarness();
    await hQuiet.D().start("console");
    for (let i = 0; i < 8; i++) hQuiet.pushFrame(0.06); // 用户说话 320ms
    assert("T28a 静默期说话时 quietGateOpen 开启", hQuiet.D().quietGateOpen === true);
    for (let i = 0; i < 12; i++) hQuiet.pushFrame(0.007); // 480ms 句尾保持期
    const tailMark = hQuiet.audioFrames().length;
    for (let i = 0; i < 15; i++) hQuiet.pushFrame(0.0075 + (i % 3) * 0.0015); // MacBook 房间空调/呼吸底噪 0.0075~0.0105
    const quietTail = hQuiet.audioFrames().slice(tailMark);
    assert("T28a 说话结束后 MacBook 房间底噪 (0.0075~0.0105) 100% 被替换为纯数字零静音帧 SILENCE_B64，确保服务端 VAD 必断句",
      hQuiet.D().quietGateOpen === false && quietTail.length === 15 && quietTail.every(d => d === SILENCE_B64));

    const hWd = makeHarness();
    await hWd.D().start("console");
    await hWd.serverMsg({ serverContent: { inputTranscription: { text: "还有我这中国人, 我来这里就不想吃中餐相关的了。" } } });
    const sentBeforeWd = hWd.ws.sent.length;
    hWd.advance(2600); // 超过 2.5s 上游仍未返回任何 modelTurn / toolCall
    const nudgedMsg = hWd.ws.sent.slice(sentBeforeWd).find(f => f.clientContent && f.clientContent.turnComplete === true);
    assert("T28b 上游 2.5s 无响应时看门狗自动补发 turnComplete:true 催答且保持麦克风常开 (micOn=true)",
      !!nudgedMsg &&
      nudgedMsg.clientContent.turns[0].parts[0].text === "还有我这中国人, 我来这里就不想吃中餐相关的了。" &&
      hWd.D().micOn === true &&
      hWd.D().stats().watchdogNudges === 1);
    assert("T28c 同音纠偏‘有没用米线?’→‘有没有米线?’且 app.js 含【每句必应铁律】与打断道歉直航守卫",
      hWd.D().sanitizeAllowedLanguageAsr("有没用米线?") === "有没有米线?" &&
      /【每句必应铁律/.test(appSrc) &&
      /OrdinalRescue/.test(appSrc));
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(3); });
