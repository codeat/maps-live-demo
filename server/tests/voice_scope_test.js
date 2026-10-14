#!/usr/bin/env node
// 语音会话作用域 (Voice Scope) 回归测试（无需浏览器）
// 守护的用户事故：手机端切到语音助手后说话，必须发送用户此刻说的话，
//               绝不能把主地图屏幕输入框 (#text) 里残留的上一轮问题发出去。
// 做法：从 static/app.js 切出 VoiceEngine（initVoiceEngine / toggleVoiceRecording / stopVoiceRecordingAndSend /
//       updateAllMicButtons / broadcastUserTranscript）与 playPcm，在 Node vm 里配假 DOM、假 SpeechRecognition、
//       假 getUserMedia 与可控定时器，逐条复现事故时序。
// 运行：node tests/voice_scope_test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = a < 0 ? -1 : src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error("marker not found in static/app.js:", startMarker, "/", endMarker); process.exit(2); }
  return src.slice(a, b);
}
const engineSrc = slice("let recognition = null;", "// 对话气泡展示专用清洗函数");
const playPcmSrc = slice("function playPcm(b64) {", "// ---------------- 交互调度与发送");

let passed = 0, failed = 0;
function assert(name, cond, details) {
  if (cond) { passed++; console.log("PASS [" + name + "]" + (details ? " " + details : "")); }
  else { failed++; console.error("FAIL [" + name + "]" + (details ? " " + details : "")); }
}
function fnBody(name) {
  const m = src.match(new RegExp("function " + name + "\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}"));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------
// A. 静态守卫：源码层面的结构性约束（比运行时更早拦住回归）
// ---------------------------------------------------------------
{
  const stopBody = fnBody("stopVoiceRecordingAndSend");
  assert("static: stopVoiceRecordingAndSend 存在", !!stopBody);
  assert("static: 发送路径不再回读任何输入框",
    stopBody && !/\$\("(?:text|mobSearchInput|astInputText)"\)\.value/.test(stopBody),
    "只允许 voiceAccumulatedText 作为语音发送来源");
  assert("static: 不存在 voiceAccumulatedText || $(...) 降级链", !/voiceAccumulatedText\s*\|\|\s*\(?\s*\$\(/.test(src));

  const bcBody = fnBody("broadcastUserTranscript");
  assert("static: broadcastUserTranscript 不再写入输入框", bcBody && !/\.value\s*=/.test(bcBody));

  const crossWrites = src.match(/\$\("text"\)\.value = (?:val|q|t|prompt|promptText);/g) || [];
  assert("static: 手机/助手/眼镜端不再向 #text 跨端写入", crossWrites.length === 0, "found " + crossWrites.length);

  assert("static: btnMobTalk 显式绑定 mobile 作用域", /\$\("btnMobTalk"\)\.onclick = \(\) => toggleVoiceRecording\("mobile"\)/.test(src));
  assert("static: mobBtnMic 显式绑定 mobile 作用域", /\$\("mobBtnMic"\)\.onclick = \(\) => toggleVoiceRecording\("mobile"\)/.test(src));
  assert("static: astBtnMic 显式绑定 assistant 作用域", (src.match(/toggleVoiceRecording\("assistant"\)/g) || []).length >= 2);
  assert("static: btnMainMic 显式绑定 console 作用域", (src.match(/toggleVoiceRecording\("console"\)/g) || []).length >= 2);
  assert("static: gBtnMic 显式绑定 glasses 作用域", /toggleVoiceRecording\("glasses"\)/.test(src));
  assert("static: 不再有裸绑定 onclick = toggleVoiceRecording", !/\.onclick = toggleVoiceRecording;/.test(src));
  const playBody = fnBody("playPcm");
  assert("static: playPcm 不再掐掉用户收音会话", playBody && !/stopVoiceRecordingAndSend/.test(playBody));
}

// ---------------------------------------------------------------
// B. 运行时沙箱
// ---------------------------------------------------------------
const VERBOSE = !!process.env.VERBOSE;

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { _track: track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function makeHarness(opts = {}) {
  const els = {};
  const makeEl = (id) => {
    const cls = new Set();
    return {
      id, value: "", textContent: "", placeholder: "", style: {}, _attrs: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      click() { if (this.onclick) this.onclick(); },
      appendChild() {}
    };
  };
  const $ = (id) => els[id] || (els[id] = makeEl(id));

  const timers = new Map(); let tid = 0;

  class FakeRec {
    constructor() { FakeRec.instances.push(this); this.started = false; this.startCalls = 0; this.stopCalls = 0; }
    start() {
      if (this.started) { const e = new Error("recognition already started"); e.name = "InvalidStateError"; throw e; }
      this.started = true; this.startCalls++;
      if (this.onstart) this.onstart();
    }
    stop() { this.stopCalls++; if (!this.started) return; this.started = false; if (this.onend) this.onend(); }
    abort() { this.stop(); }
    // 模拟浏览器吐出一段转写（isFinal=false 为中间结果）
    hear(text, isFinal) {
      if (!this.started) throw new Error("hear() called while recognition not started");
      const item = [{ transcript: text }]; item.isFinal = !!isFinal;
      if (this.onresult) this.onresult({ results: [item] });
    }
  }
  FakeRec.instances = [];

  const streams = [];
  const ctx = {
    console: VERBOSE ? console : { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: { createElement: makeEl, body: { appendChild() {} }, querySelectorAll: () => [], querySelector: () => null },
    navigator: { mediaDevices: { getUserMedia: opts.getUserMedia || (() => { const s = fakeStream(); streams.push(s); return Promise.resolve(s); }) } },
    window: { SpeechRecognition: FakeRec },
    atob: global.atob,
    $,
    // app.js 全局（切片之外声明，切片内以全局属性方式读写）
    isModelSpeaking: false,
    activeAudioSources: new Set(),
    currentUserTranscript: "",
    currentModelTranscript: "",
    playCtx: { currentTime: 0, destination: {}, createBuffer: () => ({ duration: 0.1, copyToChannel() {} }), createBufferSource: () => ({ buffer: null, onended: null, connect() {}, start() {} }) },
    playTime: 0,
    getMasterGain: () => ({}),
    duplexMicOn: () => false,
    // 桩函数
    sent: [], toasts: [],
    sendQuery: (t) => { ctx.sent.push(t); },
    broadcastModelTranscript: (t) => { ctx.currentModelTranscript = t; },
    isEchoOfRecentModelSpeech: () => false,
    resumeAudioIfNeeded: () => {},
    stopAllAudioPlayback: () => { ctx.activeAudioSources.clear(); ctx.isModelSpeaking = false; }
  };
  vm.createContext(ctx);
  vm.runInContext(
    engineSrc + "\n" + playPcmSrc +
    "\nthis.__vs = () => ({ isRecording, userWantsRecording, voiceScope, voiceSessionId, voiceAccumulatedText, hasTimer: !!voiceSilenceTimer, hasStream: !!voiceStream, streamObj: voiceStream });",
    ctx, { filename: "app.js[voice-slice]" }
  );
  // 顶层函数声明挂在沙箱全局对象上，可直接替换以捕获 toast
  ctx.showVoiceToast = (msg) => { ctx.toasts.push(String(msg)); };
  ctx.hideVoiceToast = () => {};

  return {
    ctx, $, els, timers, streams, FakeRec,
    vs: () => ctx.__vs(),
    rec: () => FakeRec.instances[FakeRec.instances.length - 1],
    toggle: (scope) => ctx.toggleVoiceRecording(scope),
    // 触发所有已到期定时器（静音自动发送 1.8s、重启 150ms 等）
    fireTimers(minMs = 0) {
      for (const [id, t] of [...timers.entries()]) { if (t.ms >= minMs) { timers.delete(id); t.fn(); } }
    }
  };
}

const Q1 = "推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。";
const Q2 = "附近有什么好吃的肉骨茶";

(async () => {
  // T1 —— 精确复现用户事故时序
  {
    const h = makeHarness();
    h.$("text").value = Q1;                 // 上一轮主地图屏幕残留
    h.ctx.currentUserTranscript = Q1;
    await h.toggle("console");              // 会话 A：桌面端开麦（用户还没说话，或结果尚未返回）
    // 用户切到手机视图：旧版会 broadcastUserTranscript(Q1) 把 Q1 灌回三个输入框；这里模拟最坏情况
    h.ctx.broadcastUserTranscript(Q1);
    h.$("text").value = Q1; h.$("mobSearchInput").value = Q1; h.$("astInputText").value = Q1;
    // 用户点 🎙️ 助手 Tab，再点 btnMobTalk（mobile 作用域）
    await h.toggle("mobile");
    assert("T1 跨端点击不得发送任何内容", h.ctx.sent.length === 0, JSON.stringify(h.ctx.sent));
    assert("T1 旧会话作废、新会话归属 mobile", h.vs().voiceScope === "mobile" && h.vs().userWantsRecording === true, JSON.stringify(h.vs()));
    assert("T1 mobile 端输入框已为新会话清空", h.$("mobSearchInput").value === "", JSON.stringify(h.$("mobSearchInput").value));
    // 用户此刻说话
    h.rec().hear(Q2, true);
    h.fireTimers(1800);                     // 停顿 1.8 秒自动发送
    assert("T1 发送的是用户此刻说的话", JSON.stringify(h.ctx.sent) === JSON.stringify([Q2]), JSON.stringify(h.ctx.sent));
    assert("T1 主屏旧问题从未被发送", !h.ctx.sent.includes(Q1));
    assert("T1 发送后 mobile 输入框清空，不残留成下一轮污染源", h.$("mobSearchInput").value === "");
    assert("T1 会话结束后作用域复位", h.vs().voiceScope === null && !h.vs().userWantsRecording && !h.vs().isRecording);
  }

  // T2 —— 同端二次点击 = 提前发送，但一个字都没听到时绝不回读输入框
  {
    const h = makeHarness();
    await h.toggle("assistant");
    h.$("text").value = Q1; h.$("mobSearchInput").value = Q1; h.$("astInputText").value = Q1; // 三个输入框全是旧问题
    await h.toggle("assistant");
    assert("T2 未听到内容时不发送（不回读任何输入框）", h.ctx.sent.length === 0, JSON.stringify(h.ctx.sent));
    assert("T2 提示未检测到有效说话内容", h.ctx.toasts.some(t => t.includes("未检测到有效说话内容")), JSON.stringify(h.ctx.toasts));
    assert("T2 会话已关闭", h.vs().voiceScope === null && !h.vs().userWantsRecording);
    assert("T2 其它端输入框未被触碰", h.$("text").value === Q1 && h.$("mobSearchInput").value === Q1, "只清理本端 astInputText");
    assert("T2 本端输入框已清空", h.$("astInputText").value === "");
  }

  // T3 —— broadcastUserTranscript 只更新气泡，不写任何输入框
  {
    const h = makeHarness();
    h.ctx.broadcastUserTranscript(Q1);
    assert("T3 三个输入框保持为空", h.$("text").value === "" && h.$("mobSearchInput").value === "" && h.$("astInputText").value === "");
    assert("T3 气泡已更新", h.$("userBubble").textContent.includes(Q1) && h.$("mobUserBubble").textContent.includes(Q1) && h.$("astUserBubble").textContent.includes(Q1));
    assert("T3 currentUserTranscript 已更新", h.ctx.currentUserTranscript === Q1);
  }

  // T4 —— 实时打字机只上屏到本端输入框
  {
    const h = makeHarness();
    await h.toggle("mobile");
    h.rec().hear("带我去滨海湾花园", false);
    assert("T4 mobile 输入框显示实时转写", h.$("mobSearchInput").value === "带我去滨海湾花园");
    assert("T4 桌面 #text 与助手输入框不被横向写入", h.$("text").value === "" && h.$("astInputText").value === "");
    assert("T4 静音定时器已布防", h.vs().hasTimer === true);
    h.rec().hear("带我去滨海湾花园，开车", true);
    h.fireTimers(1800);
    assert("T4 自动发送最终转写", JSON.stringify(h.ctx.sent) === JSON.stringify(["带我去滨海湾花园，开车"]), JSON.stringify(h.ctx.sent));
  }

  // T5 —— 麦克风按钮高亮与提示文案只在本端
  {
    const h = makeHarness();
    await h.toggle("assistant");
    const rec = (id) => h.$(id).classList.contains("recording");
    assert("T5 只有 astBtnMic 高亮", rec("astBtnMic") && !rec("btnMobTalk") && !rec("mobBtnMic") && !rec("btnMainMic") && !rec("gBtnMic"));
    assert("T5 手机对讲大按钮文案保持空闲态", h.$("mobTalkLabel").textContent === "点击语音说话", h.$("mobTalkLabel").textContent);
    assert("T5 助手端提示为收听中", h.$("astListeningText").textContent.includes("正在收听电脑麦克风"));
    assert("T5 桌面输入框 placeholder 不被劫持", !h.$("text").placeholder.includes("正在收听"));
    await h.toggle("assistant");
    assert("T5 结束后全部按钮熄灭", !rec("astBtnMic") && !rec("btnMobTalk") && !rec("btnMainMic"));
  }

  // T6 —— 等待麦克风授权期间被另一端替换：过期票据不得拉起识别引擎、不得覆盖 voiceStream
  {
    const pend = [];
    const h = makeHarness({ getUserMedia: () => new Promise((resolve) => { pend.push(resolve); }) });
    const pA = h.toggle("console");          // 会话 A 卡在授权弹窗
    const pB = h.toggle("mobile");           // 用户已切到手机端开麦：A 作废，B 领新票据
    assert("T6 两次 getUserMedia 均已发起", pend.length === 2, "pend=" + pend.length);
    const sA = fakeStream(), sB = fakeStream();
    pend[1](sB);                             // B 先拿到麦克风
    await pB;
    pend[0](sA);                             // A 的授权迟到
    await pA;
    const v = h.vs();
    assert("T6 识别引擎只被 B 拉起一次", h.rec() && h.rec().startCalls === 1, "startCalls=" + (h.rec() && h.rec().startCalls));
    assert("T6 当前会话归属 mobile", v.voiceScope === "mobile" && v.userWantsRecording === true);
    assert("T6 迟到的 A 流被立即释放", sA._track.stopped === true);
    assert("T6 voiceStream 仍是 B 的流", v.streamObj === sB && sB._track.stopped === false);
  }

  // T7 —— 旧会话的静音定时器（过期票据）不得替新会话发送，也不得打断新会话
  {
    const h = makeHarness();
    await h.toggle("console");
    h.rec().hear("嗯", false);               // A 会话布防了 1.8s 定时器
    const staleTimer = [...h.timers.values()].find(t => t.ms === 1800);
    assert("T7 旧定时器已存在", !!staleTimer);
    await h.toggle("mobile");                // 跨端：A 作废（定时器被清），B 开始
    staleTimer.fn();                         // 模拟旧定时器回调仍被触发
    assert("T7 过期定时器不发送任何内容", h.ctx.sent.length === 0, JSON.stringify(h.ctx.sent));
    assert("T7 过期定时器不打断新会话", h.vs().userWantsRecording === true && h.vs().voiceScope === "mobile");
    h.rec().hear("去鱼尾狮公园", true);
    h.fireTimers(1800);
    assert("T7 新会话正常发送", JSON.stringify(h.ctx.sent) === JSON.stringify(["去鱼尾狮公园"]), JSON.stringify(h.ctx.sent));
  }

  // T8 —— 同端二次点击提前发送已听到的内容
  {
    const h = makeHarness();
    await h.toggle("mobile");
    h.rec().hear("附近咖啡馆", false);
    await h.toggle("mobile");
    assert("T8 同端二次点击立即发送本会话内容", JSON.stringify(h.ctx.sent) === JSON.stringify(["附近咖啡馆"]), JSON.stringify(h.ctx.sent));
  }

  // T9 —— 用户收音中收到上一轮迟到的模型音频：丢弃分片，不掐掉收音
  {
    const h = makeHarness();
    await h.toggle("mobile");
    h.ctx.playPcm("AAAAAA==");
    const v = h.vs();
    assert("T9 收音会话未被掐掉", v.userWantsRecording === true && v.isRecording === true && v.voiceScope === "mobile", JSON.stringify(v));
    assert("T9 迟到分片被丢弃不播放", h.ctx.activeAudioSources.size === 0 && h.ctx.isModelSpeaking === false);
    await h.toggle("mobile");                // 关闭会话（无内容）
    h.ctx.playPcm("AAAAAA==");
    assert("T9 无收音时音频正常播放", h.ctx.activeAudioSources.size === 1 && h.ctx.isModelSpeaking === true);
  }

  // T10 —— 无参调用按当前可见视图推断作用域（控制台 / 自动化脚本兼容）
  {
    const h = makeHarness();
    h.$("viewAssistantOverlay").classList.add("hidden");
    h.$("viewGlassesOverlay").classList.add("hidden");   // 仅手机视图可见
    await h.toggle();
    assert("T10 无参推断为 mobile", h.vs().voiceScope === "mobile", h.vs().voiceScope);
    await h.toggle({ type: "click" });                  // 误传 Event 对象 → 同端二次点击 = 结束
    assert("T10 传入 Event 视同当前视图（同端二次点击结束会话）", h.vs().voiceScope === null);
    h.$("viewMobileOverlay").classList.add("hidden");
    await h.toggle();
    assert("T10 所有 overlay 隐藏时推断为 console", h.vs().voiceScope === "console", h.vs().voiceScope);
  }

  // T11 —— 会话被取消后引擎吐出的尾包必须丢弃，不写入任何输入框、不布防定时器
  {
    const h = makeHarness();
    await h.toggle("console");
    const rec = h.rec();
    h.ctx.stopVoiceRecordingAndSend(false);
    rec.started = true;                      // 模拟底层引擎尚未真正停下、仍吐出尾包
    rec.hear("尾包文字", true);
    assert("T11 尾包不写入输入框", h.$("text").value === "" && h.$("mobSearchInput").value === "" && h.$("astInputText").value === "");
    assert("T11 尾包不布防定时器/不发送", h.vs().hasTimer === false && h.ctx.sent.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
