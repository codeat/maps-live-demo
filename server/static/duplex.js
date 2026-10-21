/* static/duplex.js  —  Maps Live 全双工语音引擎 v2 (2026-09-11)
 *
 * 方案：原生 16 kHz PCM 上行 + Gemini Live 服务端 VAD / ASR / 打断（BidiGenerateContent realtimeInputConfig），
 *       叠加客户端三层声学防线：getUserMedia AEC 采集 → 残余回声动态门限（仅播报期间）→ 语义回声侦测 + 自动升级。
 *
 * 生命周期（“我自己点停止”）：
 *   点击任一麦克风按钮 → start()：麦克风常开，多轮对话持续进行，绝不因“说完一句 / 文字发送 / 模型播报”自动关麦；
 *   再点任一麦克风按钮 → stop()：发送 audioStreamEnd，释放麦克风与采集上下文。
 *
 * 打断（barge-in）：
 *   语音：本地门限连续 3 帧超阈 → 立即闪避（-18 dB）+ 补发预卷；门开持续 hardCutAfterMs 服务端仍未确认 → 本地硬切扬声器；
 *         服务端 serverContent.interrupted → app.js 清空播放队列并清除迟到帧门；
 *         duckRestoreMs 内既无 interrupted 也无 inputTranscription → 判定误报（多半是残余回声），恢复音量并抬高回声底。
 *   文字：app.js 的 bargeIn(reason) 负责掐断 + 布置迟到帧门；本模块只复位门限/闪避/轮次状态（D.bargeIn）。
 *
 * 语义回声侦测（第三层）：
 *   服务端 ASR 文本若与模型最近 45 s 播报连续 ≥ 8 个字/词逐字重合，且发生在扬声器刚出声的 3.5 s 内 → 判定回声泄漏：
 *   不上屏、不当作用户提问；第 1 次（Chromium）自动切换到 WebRTC 回环播放通道让 Chrome 把播放登记为 AEC 参考流，
 *   第 2 次起对该回声轮的模型回复静音（切断自环），第 3 次起进入严格模式（播报期间麦克风只上行静音帧，长按可插话）。
 *   注意：服务端此时已经消费了这段音频，客户端能做的是“不显示 + 不让它继续自环 + 收紧门限”，不是撤回。
 *
 * 加载顺序：必须放在 /static/app.js 之后（依赖其顶层 let 与函数）。
 * 依赖 app.js 全局：
 *   变量  ws, ready, playCtx, playTime, activeAudioSources, simState, sceneLock,
 *         currentUserTranscript, currentModelTranscript, lastRenderedOptionsKey
 *   函数  stopAllAudioPlayback, exitNavigation, renderRecommendationOptions, resetDispatchState,
 *         updateAllMicButtons, showVoiceToast, hideVoiceToast, resumeAudioIfNeeded, reconnectFresh,
 *         getMasterGain, broadcastUserTranscript, getActiveViewScope, $,
 *         armLateAudioGate / setAudioSinkMode / getAudioSinkMode（app.js v90 新增，可选）
 *
 * 对外 API（window.DuplexVoice）：
 *   supported()                        当前浏览器是否具备全双工能力（getUserMedia + AudioWorklet + AudioContext）
 *   start(scope) / stop() / toggle(scope)
 *   setupExtras()                      并入 setup 消息的 realtimeInputConfig / sessionResumption / contextWindowCompression
 *   onServerMessage(m)                 在 ws.onmessage 解析 JSON 后、app.js 自身处理前调用
 *   acceptInputTranscription(text)     app.js 把 serverContent.inputTranscription.text 交给本模块（回声侦测 + 上屏）
 *   noteModelText(fullTurnText)        app.js 每次累加模型转写后调用（语义回声比对语料）
 *   bargeIn(reason)                    app.js 文字/选项/出行方式打断时调用（复位门限、闪避、轮次）
 *   setForce(bool) / bindPushToTalk(el) 按住说话（强制旁路门限）
 *   setStrict(bool)                    严格防回声模式（播报期间麦克风静音）
 *   clearResumeHandle()                主动换会话（切城市）时清掉续接句柄
 *   refreshLabels() / stats()
 */
(function () {
  "use strict";

  // ---------------- 可调参数 ----------------
  const CFG = {
    targetRate: 16000,
    frameMs: 40,                      // 每帧 40ms = 640 采样 = 1280 字节，25 msg/s
    mime: "audio/pcm;rate=16000",

    // 服务端 VAD（写入 setup.realtimeInputConfig）
    startSensitivity: "START_SENSITIVITY_LOW", // 低起始灵敏度：屏蔽残余回声瞬态误打断，真人持续开口仍稳定触发 interrupted
    endSensitivity: "END_SENSITIVITY_HIGH",
    prefixPaddingMs: 300,             // 300ms 预拾音，防止吞字头
    silenceDurationMs: 800,           // 恢复 800ms 停顿断句，防止半句话停顿被抢答

    // 客户端残余回声门限（仅在扬声器出声期间生效；扬声器静默时全量直通）
    gateOpenFrames: 3,                // 连续 3 帧 (120ms) 超阈才开门
    gateHangoverFrames: 6,            // 关门滞后 240ms (< hardCutAfterMs)：外放回声在 -18dB 闪避后立即跌破门限并在 240ms 内关门，绝不误触硬切
    preRollFrames: 5,                 // 开门瞬间补发最近 200ms 真实音频（弥补开门判定延迟）
    noiseRatio: 4.0,                  // 阈值 ≥ 本底噪声 × 4  (+12 dB)
    echoRatio: 2.5,                   // 阈值 ≥ 残余回声底 × 2.5 (+8 dB)
    absMin: 0.012,                    // 绝对下限 (≈ -38 dBFS，拦截 AEC 收敛前的首字残音)
    maxThreshold: 0.22,               // 安全上限 (≈ -13 dBFS，既允许门限涨过外放大音量回声，又防止巨响后卡死)
    floorAlpha: 0.05,                 // 本底噪声 EMA（下行快）
    floorRiseAlpha: 0.002,            // 本底噪声 EMA（上行慢，防止把人声学进去）
    echoAlphaUp: 0.2,                 // 残余回声底 EMA（上行快）
    echoAlphaDown: 0.01,              // 残余回声底 EMA（下行慢，防止门限来回震荡）
    speakerTailSec: 0.5,              // 最后一段音频结束后再保守 500ms 视为扬声器仍在出声（混响 + WebRTC 回环缓冲延迟）

    // 闪避与本地硬切
    duckGain: 0.12,                   // 门一开立刻把扬声器压到 -18 dB（回声随之骤降 8 倍自动关门，误报可无损恢复）
    hardCutAfterMs: 500,              // 仅当门持续开启满 500ms（真人说话不随扬声器降音而消失）才本地硬切扬声器
    duckRestoreMs: 2000,              // 窗口内既无 interrupted 也无 inputTranscription → 误报：恢复音量并抬高回声底

    // 语义回声侦测
    echoRecentSpeakerMs: 3500,        // 仅当用户轮开始前 3.5s 内扬声器出过声才可能是回声
    echoMinTokens: 8,                 // 与模型近期播报连续 ≥ 8 个字/词逐字重合才判回声（短答如“天天”“滨海湾花园”永不误杀）
    holdUserTextMs: 700,              // 疑似窗口内先扣留 ASR 最多 700ms 再上屏（只影响字幕，不影响音频切断）
    echoTextWindowMs: 45000,
    echoTextMaxTokens: 1500,
    echoLoopWindowMs: 60000,          // 60s 内回声事件计数窗口
    turnGuardMs: 800,                 // 用户轮刚开始、模型尚无输出时，忽略紧随其后的 interrupted/turnComplete（它们属于被这句话打断的上一轮；ASR 可能比 interrupted 先到）
    autoSinkEscalate: true,           // 第 1 次回声事件（Chromium）自动切到回环播放通道
    muteEchoTurnAfter: 2,             // 第 2 次起：该回声轮的模型回复静音（切断自环）
    strictAfter: 3,                   // 第 3 次起：严格模式（播报期间麦克风上行静音帧）
    aecUnhealthyDb: 15,               // 回声底比噪声底高出这么多 dB 视为该设备 AEC 漏得多（仅提示）

    debug: false
  };

  const S = { OFF: "off", LISTENING: "listening", USER: "user_speaking", THINKING: "thinking", MODEL: "model_speaking" };
  const LABELS = {
    [S.OFF]:       { talk: "点击语音说话",
                     ast:  "正在收听 · 随时与 Gemini 自然对话",
                     mob:  "Gemini 3.1 Live 待命中 · 点击下方按钮说话" },
    [S.LISTENING]: { talk: "🎙️ 麦克风常开 · 直接说话（再点一次关闭）",
                     ast:  "🎙️ 麦克风常开 · 直接说话，无需再按（再点一次关闭）",
                     mob:  "🎙️ 全双工收听中 · 直接说话，停顿即自动发送" },
    [S.USER]:      { talk: "🗣️ 正在听您说…",
                     ast:  "🗣️ 正在听您说… 停顿即自动发送",
                     mob:  "🗣️ 正在听您说…" },
    [S.THINKING]:  { talk: "💭 Gemini 思考中…（可直接开口）",
                     ast:  "💭 Gemini 思考与实时检索中…",
                     mob:  "💭 Gemini 思考中…" },
    [S.MODEL]:     { talk: "🔊 播报中 · 直接开口即可打断",
                     ast:  "🔊 Gemini 播报中 · 直接开口即可打断",
                     mob:  "🔊 播报中 · 直接开口即可打断" }
  };
  const STRICT_MODEL_LABEL = { talk: "🔊 播报中 · 长按麦克风可插话（严格防回声）",
                               ast:  "🔊 Gemini 播报中 · 长按麦克风可插话（严格防回声模式）",
                               mob:  "🔊 播报中 · 长按麦克风可插话" };

  const D = {
    CFG, S,
    state: S.OFF,
    micOn: false, starting: false, cancelStart: false,
    scope: null,
    strict: false,
    stream: null, ctx: null, src: null, node: null,
    aecReported: null,               // track.getSettings().echoCancellation
    // 门限状态
    noiseFloor: 0.003, echoFloor: 0.01,
    speechRun: 0, hangover: 0, gateOpen: false, openPeak: 0, gateOpenedAt: 0, hardCutDone: false,
    preRoll: [],
    lastSpeakerBusyTs: 0,
    // 会话 / 轮次
    resumeHandle: null,
    voiceTurnOpen: false, turnAsr: "", turnShown: false, turnIsEcho: false, turnHadSpeaker: false, turnStartTs: 0,
    prevUserText: "",
    holdTimer: null,
    lastInputTs: 0,
    pttForce: false, suppressClickUntil: 0,
    duckTimer: null, tickTimer: null, statTimer: null,
    // 语义回声语料
    curModelText: "", modelHistory: [], echoEvents: [], sinkEscalated: false,
    // 统计
    framesSent: 0, framesGated: 0, framesDropped: 0, gateOpens: 0, falseAlarms: 0, confirmed: 0,
    hardCuts: 0, interrupts: 0, bargeIns: 0, echoTurns: 0, echoChunksDropped: 0, mutedEchoTurns: 0
  };
  window.DuplexVoice = D;

  const FRAME_BYTES = Math.round(CFG.targetRate * CFG.frameMs / 1000) * 2;
  const SILENCE_B64 = b64(new ArrayBuffer(FRAME_BYTES));

  // ---------------- 工具 ----------------
  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function ema(prev, x, a) { return prev + (x - prev) * a; }
  function log() { if (CFG.debug) console.log.apply(console, ["[Duplex]"].concat([].slice.call(arguments))); }
  function wsOpen() { return typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN && ready; }
  function toast(msg, ms) { try { showVoiceToast(msg, ms); } catch (e) {} }
  function el(id) { try { return (typeof $ === "function") ? $(id) : document.getElementById(id); } catch (e) { return null; } }
  function parseDurationMs(d) {          // protobuf Duration JSON 形如 "45s" / "45.5s"
    if (!d) return 0;
    if (typeof d === "number") return d * 1000;
    const m = String(d).match(/^([\d.]+)s$/);
    return m ? parseFloat(m[1]) * 1000 : 0;
  }
  function inferScope() {
    try { if (typeof getActiveViewScope === "function") return getActiveViewScope(); } catch (e) {}
    return "console";
  }
  function isChromium() {
    const ua = (navigator && navigator.userAgent) || "";
    return !!(window.chrome) || /Chrom(e|ium)\/|CriOS\//.test(ua);
  }
  // 文本 → 词元：CJK 每字一个词元，拉丁/数字按连续串一个词元（回声比对用，大小写/标点/空白无关）
  function tokens(s) {
    const out = [];
    const re = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|[a-z0-9]+/g;
    s = String(s || "").toLowerCase();
    let m;
    while ((m = re.exec(s))) out.push(m[0]);
    return out;
  }
  // 最长连续公共词元串（a 短 b 长）
  function longestCommonRun(a, b) {
    const m = b.length;
    if (!a.length || !m) return 0;
    let best = 0, prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= m; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
        if (cur[j] > best) best = cur[j];
      }
      const t = prev; prev = cur; cur = t; cur.fill(0);
    }
    return best;
  }

  // 扬声器此刻是否（可能）仍在出声：有活跃/排队的 source、模型播报中，或最后一段音频的尾巴 + 保守余量未过
  function speakerBusy() {
    if (typeof playCtx === "undefined" || !playCtx) return false;
    if (typeof activeAudioSources !== "undefined" && activeAudioSources && activeAudioSources.size > 0) return true;
    if (typeof isModelSpeaking !== "undefined" && isModelSpeaking) return true;
    if (typeof playTime === "undefined" || !(playTime > 0)) return false;   // 从未播放过：不能把刚创建的上下文（currentTime≈0）当成“尾音未过”
    return playCtx.currentTime < (playTime + CFG.speakerTailSec);
  }
  D.speakerBusy = speakerBusy;

  D.supported = function () {
    try {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
                window.AudioWorklet && (window.AudioContext || window.webkitAudioContext) && window.WebSocket);
    } catch (e) { return false; }
  };

  // ---------------- 采集管线 ----------------
  async function start(scope) {
    if (D.micOn) { if (typeof scope === "string") D.scope = scope; return; }
    if (D.starting) return;
    if (!D.supported()) {
      toast("⚠️ 当前浏览器不支持全双工语音（需要 getUserMedia + AudioWorklet）", 4000);
      return;
    }
    D.starting = true; D.cancelStart = false;
    D.scope = (typeof scope === "string") ? scope : inferScope();
    try { resumeAudioIfNeeded(); } catch (e) {}
    try { if (typeof getMasterGain === "function") getMasterGain(); } catch (e) {}   // 在用户手势内创建/恢复播放上下文（含回环通道）
    // macOS / 桌面 Chromium 的 Web Audio 直出（playCtx.destination）并不保证进入 getUserMedia 的 WebRTC AEC 参考流；
    // 开麦瞬间趁用户手势激活 WebRTC 本地回环通道，使第一句播报起就具备样本级 AEC 参考抵消（无 RTCPeerConnection 环境安全跳过）
    if (isChromium() && typeof RTCPeerConnection !== "undefined" &&
        typeof setAudioSinkMode === "function" && typeof getAudioSinkMode === "function" &&
        getAudioSinkMode() === "direct") {
      const explicitPref = (typeof readPref === "function") ? readPref("mlSink", "sink", "") : "";
      if (explicitPref !== "direct") {
        try { setAudioSinkMode("loopback"); } catch (e) {}
      }
    }
    try {
      if (navigator.audioSession) navigator.audioSession.type = "play-and-record";    // iOS Safari：提前锁定会话类别
    } catch (e) {}

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch (err) {
      D.starting = false;
      console.warn("[Duplex] getUserMedia failed:", err);
      toast(err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
        ? "⚠️ 请允许浏览器访问麦克风！" : "⚠️ 麦克风设备不可用，请检查系统设置", 4000);
      return;
    }
    if (D.cancelStart) {          // 等待授权期间用户又点了一次 = 取消
      D.starting = false;
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      return;
    }
    D.stream = stream;
    const track = stream.getAudioTracks()[0];
    try { D.aecReported = track.getSettings().echoCancellation; } catch (e) { D.aecReported = null; }

    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: CFG.targetRate }); }
    catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
    try {
      await ctx.audioWorklet.addModule("/static/pcm-capture-worklet.js?v=1");
    } catch (e) {
      console.error("[Duplex] worklet load failed:", e);
      toast("⚠️ 音频处理模块加载失败", 4000);
      try { ctx.close(); } catch (e2) {}
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e3) {} });
      D.stream = null; D.starting = false;
      return;
    }
    D.ctx = ctx;
    D.src = ctx.createMediaStreamSource(stream);
    D.node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
      processorOptions: { targetRate: CFG.targetRate, frameMs: CFG.frameMs }
    });
    D.node.port.onmessage = (e) => onFrame(e.data);
    D.src.connect(D.node);
    // worklet 不写输出（静音），接到 destination 只是为了让所有浏览器都稳定驱动 process()
    const mute = ctx.createGain(); mute.gain.value = 0;
    D.node.connect(mute).connect(ctx.destination);

    track.onended = () => { if (D.micOn) stop(true); };

    D.micOn = true; D.starting = false;
    D.echoFloor = Math.max(D.echoFloor || 0, 0.01);
    D.noiseFloor = Math.max(D.noiseFloor || 0, 0.003);
    D.gateOpen = false; D.speechRun = 0; D.preRoll = []; D.hardCutDone = false;
    D.voiceTurnOpen = false; D.turnAsr = ""; D.turnShown = false; D.turnIsEcho = false;
    const startSpeakingBusy = typeof playCtx !== "undefined" && playCtx && typeof playTime !== "undefined" && playTime > 0 && playCtx.currentTime < playTime;
    if (startSpeakingBusy) {
      try { if (typeof bargeIn === "function") bargeIn("mic_start"); else if (typeof stopAllAudioPlayback === "function") stopAllAudioPlayback(); } catch (e) {}
    }
    D.tickTimer = setInterval(tick, 100);
    if (CFG.debug) D.statTimer = setInterval(() => console.log("[Duplex] stats", D.stats()), 5000);
    try { updateAllMicButtons(true); } catch (e) {}
    setState(S.LISTENING, true);
    if (D.aecReported === false && !D.strict) {
      // 浏览器明确告知这条轨道没有回声消除：残余回声必然很大，直接进入严格模式，长按可插话
      D.strict = true;
      toast("⚠️ 浏览器未对麦克风启用回声消除：播报期间自动静音麦克风，长按按钮可强制插话", 5000);
    } else {
      toast("🎙️ 全双工已开启：直接说话即可，播报中也可随时开口打断（再点一次关闭麦克风）", 4000);
    }
    log("started; scope=", D.scope, "ctxRate=", ctx.sampleRate, "aecReported=", D.aecReported);
  }

  function stop(sendEnd) {
    if (!D.micOn) { if (D.starting) D.cancelStart = true; return; }
    D.micOn = false;
    if (sendEnd !== false && wsOpen()) {
      try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (e) {}
    }
    try { D.src && D.src.disconnect(); } catch (e) {}
    try { if (D.node) { D.node.port.onmessage = null; D.node.disconnect(); } } catch (e) {}
    try { D.stream && D.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { D.ctx && D.ctx.close(); } catch (e) {}
    D.stream = D.ctx = D.src = D.node = null;
    if (D.tickTimer) { clearInterval(D.tickTimer); D.tickTimer = null; }
    if (D.statTimer) { clearInterval(D.statTimer); D.statTimer = null; }
    D.gateOpen = false; D.speechRun = 0; D.preRoll = []; D.pttForce = false; D.hardCutDone = false;
    clearHold();
    D.voiceTurnOpen = false; D.turnAsr = ""; D.turnShown = false; D.turnIsEcho = false;
    duck(false);
    if (typeof RTCPeerConnection !== "undefined" &&
        typeof setAudioSinkMode === "function" && typeof getAudioSinkMode === "function" &&
        getAudioSinkMode() === "loopback") {
      const explicitPref = (typeof readPref === "function") ? readPref("mlSink", "sink", "") : "";
      if (explicitPref !== "loopback" && !/Android/.test((navigator && navigator.userAgent) || "")) {
        try { setAudioSinkMode("direct"); } catch (e) {}
      }
    }
    try { updateAllMicButtons(false); } catch (e) {}
    setState(S.OFF, true);
    try { hideVoiceToast(); } catch (e) {}
    toast("🔇 麦克风已关闭", 1500);
    log("stopped");
  }

  // 麦克风是全局唯一资源：任一端的麦克风按钮都反映同一个开/关状态，点任一个都是切换。
  // 当模型正在播报语音时，点击麦克风按钮优先执行“打断播报并继续收音”，而非关闭麦克风。
  function toggle(scope) {
    if (Date.now() < D.suppressClickUntil) return;   // 长按说话松开后紧随的 click 不算切换
    if (D.starting) { D.cancelStart = true; return; } // 等待麦克风授权期间再点一次 = 取消开麦
    if (D.micOn) {
      const activelySpeaking = typeof playCtx !== "undefined" && playCtx && typeof playTime !== "undefined" && playTime > 0 && playCtx.currentTime < playTime;
      if (activelySpeaking) {
        D.gateOpen = false; D.speechRun = 0; D.hardCutDone = false;
        try { if (typeof bargeIn === "function") bargeIn("mic_click"); else if (typeof stopAllAudioPlayback === "function") stopAllAudioPlayback(); } catch (e) {}
        toast("🎙️ 已打断播报 · 请直接说话", 2000);
        return;
      }
      return stop(true);
    }
    return start(scope);
  }

  // ---------------- 每帧处理：残余回声门限 ----------------
  function threshold() {
    return Math.min(CFG.maxThreshold, Math.max(D.noiseFloor * CFG.noiseRatio, D.echoFloor * CFG.echoRatio, CFG.absMin));
  }
  function learnEcho(rms) {
    D.echoFloor = ema(D.echoFloor, rms, rms > D.echoFloor ? CFG.echoAlphaUp : CFG.echoAlphaDown);
  }
  function learnNoise(rms) {
    if (rms < D.noiseFloor * 3) D.noiseFloor = Math.max(1e-4, ema(D.noiseFloor, rms, CFG.floorAlpha));
    else D.noiseFloor = ema(D.noiseFloor, rms, CFG.floorRiseAlpha);
  }
  function openGate(rms, thr) {
    D.gateOpen = true; D.hangover = CFG.gateHangoverFrames; D.openPeak = rms; D.gateOpens++;
    D.gateOpenedAt = Date.now(); D.hardCutDone = false;
    flushPreRoll();
    duck(true);
    log("gate OPEN rms=", rms.toFixed(4), "thr=", thr.toFixed(4));
  }
  function closeGate() {
    D.gateOpen = false; D.speechRun = 0;
    log("gate CLOSE");
  }

  function onFrame(msg) {
    if (!D.micOn || !msg) return;
    const rms = msg.rms;
    const busy = speakerBusy();
    if (busy) D.lastSpeakerBusyTs = Date.now();
    let forward = true;

    if (busy && !D.pttForce) {
      if (D.strict) {
        // 严格模式：播报期间一律上行静音帧（半双工），只有长按说话才旁路
        learnEcho(rms);
        forward = false;
      } else {
        const thr = threshold();
        const above = rms > thr;
        if (!D.gateOpen) {
          D.speechRun = above ? D.speechRun + 1 : 0;
          if (D.speechRun >= CFG.gateOpenFrames) {
            openGate(rms, thr);
          } else {
            // 未开门：用静音帧占位（保持上行流连续，供服务端 VAD 计时）。
            // 只把“低于阈值”的帧学进回声底；超阈但还没凑够 3 帧的候选帧不能学——否则回声底会以 0.2 的步长追着人声涨，
            // 门限永远追不上（v1 的门几乎只对突然的大声有效）。持续超阈的真回声由误报回滚路径（openPeak×1.2）学习。
            if (!above) learnEcho(rms);
            forward = false;
          }
        } else {
          if (rms > D.openPeak) D.openPeak = rms;
          if (above) D.hangover = CFG.gateHangoverFrames;
          else if (--D.hangover <= 0) closeGate();
        }
        if (D.gateOpen && !D.hardCutDone && D.duckTimer && CFG.hardCutAfterMs > 0 &&
            Date.now() - D.gateOpenedAt >= CFG.hardCutAfterMs) {
          localHardCut();
        }
      }
    } else {
      // 扬声器静默：全量直通，由服务端 VAD 全权判定；同时学习本底噪声
      D.gateOpen = false; D.speechRun = 0;
      learnNoise(rms);
    }

    if (!forward) {
      D.preRoll.push(msg.pcm);
      if (D.preRoll.length > CFG.preRollFrames) D.preRoll.shift();
      D.framesGated++;
      sendAudioB64(SILENCE_B64);
      return;
    }
    D.preRoll.length = 0;
    D.framesSent++;
    sendAudioB64(b64(msg.pcm));
  }

  function flushPreRoll() {
    for (const buf of D.preRoll) { sendAudioB64(b64(buf)); D.framesSent++; }
    D.preRoll.length = 0;
  }

  function sendAudioB64(data) {
    if (!wsOpen()) { D.framesDropped++; return; }
    ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: CFG.mime } } }));
  }

  // ---------------- 闪避 / 本地硬切 / 误报回滚 ----------------
  function masterGain() {
    try { return (typeof getMasterGain === "function") ? getMasterGain() : null; } catch (e) { return null; }
  }
  // on=true 且 noTimer=false：布置误报回滚计时（门限自动开门的场景）；按住说话时不计时（用户明确在说话）
  function duck(on, noTimer) {
    const g = masterGain();
    if (on) {
      if (D.duckTimer) clearTimeout(D.duckTimer);
      D.duckTimer = noTimer ? null : setTimeout(onDuckTimeout, CFG.duckRestoreMs);
    } else if (D.duckTimer) {
      clearTimeout(D.duckTimer); D.duckTimer = null;
    }
    if (!g || typeof playCtx === "undefined" || !playCtx) return;
    const t = playCtx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(on ? CFG.duckGain : 1, t, on ? 0.02 : 0.05);
    } catch (e) {}
  }
  // 服务端确认了这是真人插话（interrupted 或 inputTranscription 到达）：撤销误报计时，不再回滚
  function confirmBargeIn(src) {
    if (D.duckTimer) { clearTimeout(D.duckTimer); D.duckTimer = null; D.confirmed++; log("barge-in confirmed by", src); }
  }
  // 窗口内服务端既没有 interrupted 也没有 ASR → 本地门限误报（多半是残余回声）：恢复音量，并把回声底抬到误报峰值之上
  function onDuckTimeout() {
    D.duckTimer = null;
    D.falseAlarms++;
    D.echoFloor = Math.max(D.echoFloor, D.openPeak * 1.2);
    D.gateOpen = false; D.speechRun = 0; D.hardCutDone = false;
    duck(false);
    log("duck timeout → false alarm; echoFloor raised to", D.echoFloor.toFixed(4));
  }
  // 本地硬切：门开持续 hardCutAfterMs 服务端还没确认 → 不再等，立即掐断扬声器并布置迟到帧门
  function localHardCut() {
    D.hardCutDone = true; D.hardCuts++;
    try { stopAllAudioPlayback(); } catch (e) {}
    try { if (typeof armLateAudioGate === "function") armLateAudioGate("voice_gate_sustained"); } catch (e) {}
    log("local hard cut");
  }

  // ---------------- setup / 服务端事件 ----------------
  D.setupExtras = function () {
    return {
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: CFG.startSensitivity,
          endOfSpeechSensitivity: CFG.endSensitivity,
          prefixPaddingMs: CFG.prefixPaddingMs,
          silenceDurationMs: CFG.silenceDurationMs
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY"
      },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: D.resumeHandle ? { handle: D.resumeHandle } : {}
    };
  };
  D.clearResumeHandle = function () { D.resumeHandle = null; };

  D.onServerMessage = function (m) {
    if (!m) return;
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) { D.resumeHandle = u.newHandle; log("resume handle updated"); }
    }
    if (m.goAway) {
      const ms = parseDurationMs(m.goAway.timeLeft);
      console.warn("[Duplex] server goAway, timeLeft=", m.goAway.timeLeft, "→ 提前重连并用 handle 续会话");
      setTimeout(() => { try { reconnectFresh(true); } catch (e) {} }, Math.max(0, ms - 3000));
    }
    const sc = m.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // 服务端确认用户插话：瞬间掐断本地已排队的全部音频（Live API 下发领先于实时，本地可能还囤着数秒）
      D.interrupts++;
      confirmBargeIn("interrupted");
      try { stopAllAudioPlayback(); } catch (e) {}
      duck(false);
      D.hardCutDone = false;
      endVoiceTurn("interrupted");
      log("interrupted");
    }
    if (sc.turnComplete) {
      endVoiceTurn("turnComplete");
    }
  };

  // 关闭当前用户语音轮。保护：用户轮刚开始（< turnGuardMs）且模型对它还没有任何输出时，到达的 interrupted / turnComplete
  // 属于被这句话打断的上一轮（ASR 可能比 interrupted 先到），此时只归档语料、不关闭，否则同一句话会被拆成两轮。
  function endVoiceTurn(src) {
    if (D.voiceTurnOpen && !D.curModelText && (Date.now() - D.turnStartTs) < CFG.turnGuardMs) {
      log("endVoiceTurn(" + src + ") ignored: user turn just started");
      return;
    }
    D.voiceTurnOpen = false;
    clearHold();
    pushModelHistory();
  }
  function pushModelHistory() {
    if (!D.curModelText) return;
    D.modelHistory.push({ ts: Date.now(), text: D.curModelText });
    if (D.modelHistory.length > 12) D.modelHistory.shift();
    D.curModelText = "";
  }

  // app.js 每次累加模型转写后调用（本轮完整文本）
  D.noteModelText = function (fullTurnText) {
    D.curModelText = String(fullTurnText || "");
  };

  // ---------------- 用户语音轮：ASR 接收 + 语义回声侦测 + 上屏 ----------------
  // 由 app.js 在 serverContent.inputTranscription 到达时调用。本函数负责：
  //   · 服务端听到了人声 → 撤销本地门限的误报计时（这是最可靠的“真人在说话”证据）
  //   · 第一段 ASR 到达即掐断仍在本地排队的旧音频（模型已说完但尾巴还在播的场景，服务端不会发 interrupted）
  //   · 疑似窗口（扬声器 3.5s 内出过声）内先扣留字幕 ≤700ms，累计 ≥8 词元后与模型近期播报比对
  //   · 判定回声 → 不上屏、计数并按次数升级防御；否则 beginVoiceUserTurn() 清场并上屏
  D.acceptInputTranscription = function (chunk) {
    if (!chunk) return;
    const now = Date.now();
    D.lastInputTs = now;
    confirmBargeIn("asr");
    if (!D.voiceTurnOpen) {
      D.voiceTurnOpen = true;
      D.turnAsr = ""; D.turnShown = false; D.turnIsEcho = false; D.turnStartTs = now;
      D.turnHadSpeaker = (now - D.lastSpeakerBusyTs) < CFG.echoRecentSpeakerMs || speakerBusy();
      try { if (typeof currentUserTranscript !== "undefined") D.prevUserText = currentUserTranscript || ""; } catch (e) {}
      pushModelHistory();                // 上一轮模型文本归档进回声比对语料
      beginVoiceUserTurn();              // 立即清场：掐旧音频（自环的声源就是它）、清推荐按键、sceneLock；字幕可稍后再上
      duck(false);
    }
    if (D.turnIsEcho) { D.echoChunksDropped++; return; }
    D.turnAsr += chunk;

    if (D.turnHadSpeaker) {
      const v = echoVerdict(D.turnAsr);
      if (v === "echo") { markEchoTurn(); return; }
      if (v === "undecided" && !D.turnShown) { scheduleHoldFlush(); return; }
    }
    showUserTurn();
  };

  function echoVerdict(asrText) {
    const a = tokens(asrText);
    if (a.length < CFG.echoMinTokens) return "undecided";
    const run = longestCommonRun(a, recentModelTokens());
    return run >= CFG.echoMinTokens ? "echo" : "clean";
  }
  function recentModelTokens() {
    const cutoff = Date.now() - CFG.echoTextWindowMs;
    let text = D.modelHistory.filter(h => h.ts >= cutoff).map(h => h.text).join(" ") + " " + (D.curModelText || "");
    let t = tokens(text);
    if (t.length > CFG.echoTextMaxTokens) t = t.slice(t.length - CFG.echoTextMaxTokens);
    return t;
  }
  function scheduleHoldFlush() {
    if (D.holdTimer) return;
    D.holdTimer = setTimeout(() => {
      D.holdTimer = null;
      if (D.voiceTurnOpen && !D.turnShown && !D.turnIsEcho && D.turnAsr) showUserTurn();
    }, CFG.holdUserTextMs);
  }
  function clearHold() { if (D.holdTimer) { clearTimeout(D.holdTimer); D.holdTimer = null; } }

  function showUserTurn() {
    if (!D.turnShown) {
      D.turnShown = true;
      // 真人新话语开始：若仍挂着“回声轮静音门”，解除（用户此刻要听的是对这句话的回复）
      try { if (typeof clearLateAudioGate === "function") clearLateAudioGate("user_turn"); } catch (e) {}
    }
    try { currentUserTranscript = D.turnAsr; } catch (e) {}
    try { broadcastUserTranscript(D.turnAsr); } catch (e) {}
  }

  function markEchoTurn() {
    D.turnIsEcho = true; D.echoTurns++;
    const now = Date.now();
    D.echoEvents.push(now);
    D.echoEvents = D.echoEvents.filter(t => now - t <= CFG.echoLoopWindowMs);
    // 门限曾为这段回声开过门：把回声底抬到其峰值之上，下次同样响度不再开门
    if (D.openPeak > 0) D.echoFloor = Math.max(D.echoFloor, D.openPeak * 1.2);
    if (D.turnShown) {
      // 字幕已经上屏（扣留窗口过后才凑够词元）：撤回，恢复上一条真实提问
      try { currentUserTranscript = D.prevUserText; } catch (e) {}
      try { if (D.prevUserText) broadcastUserTranscript(D.prevUserText); } catch (e) {}
    }
    const n = D.echoEvents.length;
    console.warn("[Duplex] 语义回声：ASR 与模型近期播报逐字重合，已忽略 (60s 内第 " + n + " 次):", D.turnAsr);
    escalateEchoDefense(n);
  }

  // 回声升级策略：1 次 → 回环播放通道（Chromium）；2 次 → 静音该回声轮的模型回复（切断自环）；3 次 → 严格模式
  function escalateEchoDefense(n) {
    if (CFG.autoSinkEscalate && !D.sinkEscalated && isChromium() &&
        typeof setAudioSinkMode === "function" && typeof getAudioSinkMode === "function" && getAudioSinkMode() === "direct") {
      D.sinkEscalated = true;
      D.echoEvents.length = 0;               // 通道切换后重新计数，给回环通道验证机会
      try { setAudioSinkMode("loopback"); } catch (e) {}
      toast("🔁 检测到扬声器回声泄漏，已切换到回环播放通道以启用浏览器回声消除", 4000);
      return;
    }
    if (n >= CFG.muteEchoTurnAfter) {
      D.mutedEchoTurns++;
      try { if (typeof armLateAudioGate === "function") armLateAudioGate("echo_turn", true); } catch (e) {}
      toast("🔇 检测到扬声器回声被识别为语音，已忽略并静音本轮回复", 3000);
    }
    if (n >= CFG.strictAfter && !D.strict) {
      D.setStrict(true);
      toast("🛡️ 回声反复触发，已切换到严格防回声模式：播报期间麦克风静音，长按按钮可插话", 5000);
    }
  }

  // 语音新一轮开始（等价于 sendQuery 的前置清场，但不在导航进行中拆掉路线）
  function beginVoiceUserTurn() {
    try { if (typeof simState === "undefined" || !simState.active) exitNavigation(); } catch (e) {}
    try { currentModelTranscript = ""; } catch (e) {}
    try { renderRecommendationOptions([]); } catch (e) {}
    // 必须同步复位去重键：否则用户再次问到同一组地点时 key 相同，按键被清掉后永远不会再渲染
    try { if (typeof lastRenderedOptionsKey !== "undefined") lastRenderedOptionsKey = ""; } catch (e) {}
    try { resetDispatchState(); } catch (e) {}
    try { stopAllAudioPlayback(); } catch (e) {}
    if (el("modelBubble")) el("modelBubble").textContent = "正在收听…";
    try { sceneLock = true; } catch (e) {}
    log("voice user turn begin");
  }

  // 文字 / 选项 / 出行方式打断（app.js 已负责掐断播放与迟到帧门），这里复位本模块的门限、闪避与轮次（保留已学到的 echoFloor 防回声回归）
  D.bargeIn = function (reason) {
    D.bargeIns++;
    duck(false);
    D.gateOpen = false; D.speechRun = 0; D.hardCutDone = false;
    clearHold();
    D.voiceTurnOpen = false; D.turnAsr = ""; D.turnShown = false; D.turnIsEcho = false;
    pushModelHistory();
    log("bargeIn:", reason);
  };

  // ---------------- 派生状态机 + UI ----------------
  function tick() {
    if (!D.micOn) return;
    const busy = speakerBusy();
    // 本地硬切：仅当门仍处于开启态持续满 hardCutAfterMs 且服务端尚未确认（duckTimer 仍在）→ 掐断
    if (D.gateOpen && !D.hardCutDone && D.duckTimer && CFG.hardCutAfterMs > 0 &&
        busy && Date.now() - D.gateOpenedAt >= CFG.hardCutAfterMs) {
      localHardCut();
    }
    let s;
    if (D.gateOpen || D.pttForce) s = S.USER;
    else if (busy) s = S.MODEL;
    else if (Date.now() - D.lastInputTs < 1200) s = S.USER;
    else if (typeof sceneLock !== "undefined" && sceneLock) s = S.THINKING;
    else s = S.LISTENING;
    setState(s);
  }

  function labelsFor(s) {
    if (s === S.MODEL && D.strict) return STRICT_MODEL_LABEL;
    const base = LABELS[s] || LABELS[S.OFF];
    let modelName = "Gemini 3.8 Live";
    try {
      if (typeof window !== "undefined" && typeof window.getActiveModelObj === "function") {
        modelName = window.getActiveModelObj().shortName || "Gemini Live";
      }
    } catch (e) {}
    return {
      talk: base.talk,
      ast: base.ast,
      mob: (s === S.OFF) ? `${modelName} 待命中 · 点击下方按钮说话` : base.mob
    };
  }
  function setState(s, force) {
    if (D.state === s && !force) return;
    D.state = s;
    D.refreshLabels();
    try {
      Object.values(S).forEach(k => document.body.classList.remove("duplex-" + k));
      document.body.classList.add("duplex-" + s);
    } catch (e) {}
  }
  D.refreshLabels = function () {
    const s = D.micOn ? D.state : S.OFF;
    const L = labelsFor(s);
    if (el("mobTalkLabel")) el("mobTalkLabel").textContent = L.talk;
    if (el("astListeningText")) el("astListeningText").textContent = L.ast;
    if (el("mobAssistantState")) el("mobAssistantState").textContent = L.mob;
    const t = el("text");
    if (t) {
      if (s === S.OFF) {
        const old = t.getAttribute("data-old-placeholder");
        if (old) t.placeholder = old;
      } else {
        if (!t.getAttribute("data-old-placeholder")) t.setAttribute("data-old-placeholder", t.placeholder);
        t.placeholder = L.talk;
      }
    }
  };

  D.setStrict = function (on) {
    D.strict = !!on;
    D.refreshLabels();
  };

  // ---------------- 按住说话（强制旁路门限） ----------------
  D.setForce = function (on) {
    D.pttForce = !!on;
    if (on) { if (D.micOn) duck(true, true); }
    else duck(false);
  };
  D.bindPushToTalk = function (btn, holdMs) {
    if (!btn || btn.__duplexPtt) return;
    btn.__duplexPtt = true;
    holdMs = holdMs || 350;
    let timer = null, held = false;
    const down = () => { held = false; timer = setTimeout(() => { held = true; if (D.micOn) D.setForce(true); }, holdMs); };
    const up = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (held) { held = false; D.setForce(false); D.suppressClickUntil = Date.now() + 400; }   // 长按松开不触发 click 切换
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
  };

  D.start = start; D.stop = stop; D.toggle = toggle;
  D.stats = function () {
    const dB = (x) => Math.round(20 * Math.log10(Math.max(x, 1e-6)));
    return {
      state: D.state, micOn: D.micOn, scope: D.scope, strict: D.strict, aecReported: D.aecReported,
      sink: (typeof getAudioSinkMode === "function") ? getAudioSinkMode() : "n/a",
      noiseFloorDb: dB(D.noiseFloor), echoFloorDb: dB(D.echoFloor),
      aecHealthDb: dB(D.echoFloor) - dB(D.noiseFloor),   // 越接近 0 越好；>15 说明这台设备 AEC 漏得多
      framesSent: D.framesSent, framesGated: D.framesGated, framesDropped: D.framesDropped,
      gateOpens: D.gateOpens, confirmed: D.confirmed, falseAlarms: D.falseAlarms, hardCuts: D.hardCuts,
      interrupts: D.interrupts, bargeIns: D.bargeIns,
      echoTurns: D.echoTurns, echoChunksDropped: D.echoChunksDropped, mutedEchoTurns: D.mutedEchoTurns,
      resumeHandle: !!D.resumeHandle
    };
  };

  function autoBind() {
    ["btnMainMic", "btnMobTalk", "mobBtnMic", "gBtnMic", "astBtnMic"].forEach(id => { const b = el(id); if (b) D.bindPushToTalk(b); });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoBind);
    else autoBind();
  }
})();
