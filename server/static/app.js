
// ---------------- 客户端调试日志 (仅控制台本地输出，不走公网网络上报) ----------------
function remoteLog(level, category, message, extra = {}) {
  try {
    const prefix = `[MapsLive][${category || "CLIENT"}]`;
    const lvl = (level || "INFO").toUpperCase();
    if (lvl === "WARN" || lvl === "WARNING") {
      console.warn(prefix, message, extra);
    } else if (lvl === "ERROR") {
      console.error(prefix, message, extra);
    } else {
      console.log(prefix, message, extra);
    }
  } catch (e) {}
}

// ---------------- 净化目的地实体名称 (剔除 markdown 加粗、代码、引号及两端标点) ----------------
function sanitizeDestinationName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/[*_~`"“”'‘’#]/g, " ")
    .replace(/^[^一-龥぀-ヿ가-힯A-Za-z0-9]+/, "")
    .replace(/[\s，。！？；、,.!?;:：]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------- 严格目的地有效性校验 (防量词、泛词与跨国漂移) ----------------
function isValidDestinationName(dest) {
  if (!dest || typeof dest !== "string") return false;
  const s = sanitizeDestinationName(dest);
  if (s.length < 2 || s.length > 60) return false;

  const invalidExact = [
    "两家", "一家", "几家", "三家", "四家", "两个", "三个", "四个", "多个",
    "这几家", "这两家", "这几个", "这俩", "几个", "一些", "如下", "推荐",
    "周边", "附近", "商圈", "目的地", "起点", "上车点", "出发点", "路线", "导航",
    "咖啡店", "精品咖啡", "餐厅", "美食", "商场", "这里", "那里", "那儿", "这家", "那家",
    "这处", "那处", "两处", "三处", "景点", "店铺", "门店", "评价", "评分", "哪一个", "哪一家",
    "规划路线", "带我过去", "去那儿", "去那里", "走吧", "带我去", "规划", "前往"
  ];
  if (invalidExact.includes(s)) return false;

  // 正则过滤纯量词结构，如“两家店”、“两家咖啡”、“几家”、“三个”
  if (/^[一两二三四五六七八九十几多][家个间处座条所]$/.test(s)) return false;
  if (/^[一两二三四五六七八九十几多][家个间处座条所](?:店|家|个|餐厅|咖啡|美食|商圈)?$/.test(s)) return false;
  if (/^(?:为您推荐|推荐前往|规划前往|想去哪|您想去)/.test(s)) return false;

  return true;
}

// ---------------- 动态按需调度状态管理 (On-Demand Dispatch) ----------------
let dispatchState = {
  hasSearch: false,
  hasMaps: false,
  hasFc: false,
  routePrepared: false,
  searchQuery: "",
  mapsPoi: "",
  fcArgs: ""
};

function resetDispatchState() {
  dispatchState = {
    hasSearch: false,
    hasMaps: false,
    hasFc: false,
    routePrepared: false,
    searchQuery: "",
    mapsPoi: "",
    fcArgs: ""
  };
  updateDispatchUI();
  lastTurnGroundingMeta = null;
  renderRecommendationOptions([]);
}

function updateDispatchUI() {
  const isPureNative = (!dispatchState.hasSearch && !dispatchState.hasMaps && !dispatchState.hasFc);

  // 1. Console Tags & Telemetry
  if ($("tagNative")) {
    if (isPureNative) $("tagNative").classList.remove("hidden");
    else $("tagNative").classList.add("hidden");
  }
  if ($("tagSearch")) {
    if (dispatchState.hasSearch) $("tagSearch").classList.remove("hidden");
    else $("tagSearch").classList.add("hidden");
  }
  if ($("tagMaps")) {
    if (dispatchState.hasMaps) $("tagMaps").classList.remove("hidden");
    else $("tagMaps").classList.add("hidden");
  }
  if ($("tagFunction")) {
    if (dispatchState.hasFc) $("tagFunction").classList.remove("hidden");
    else $("tagFunction").classList.add("hidden");
  }

  if ($("telemetryBox")) {
    $("telemetryBox").classList.remove("hidden");
    if ($("telNativeRow")) {
      if (isPureNative) {
        $("telNativeRow").classList.remove("hidden");
        $("telNativeText").textContent = "纯大模型原生知识推理 (未调用外部搜索/地图/函数，零外部延迟)";
      } else {
        $("telNativeRow").classList.add("hidden");
      }
    }
    if ($("telSearchRow")) {
      if (dispatchState.hasSearch) {
        $("telSearchRow").classList.remove("hidden");
        $("telSearchText").textContent = dispatchState.searchQuery || "实时检索天气与外部资讯";
      } else {
        $("telSearchRow").classList.add("hidden");
      }
    }
    if ($("telMapsRow")) {
      if (dispatchState.hasMaps) {
        $("telMapsRow").classList.remove("hidden");
        $("telMapsText").textContent = dispatchState.mapsPoi || "已精准对齐周边 Google Maps 地图位置实体";
      } else {
        $("telMapsRow").classList.add("hidden");
      }
    }
    if ($("telFcRow")) {
      if (dispatchState.hasFc) {
        $("telFcRow").classList.remove("hidden");
        $("telFcText").textContent = dispatchState.fcArgs || "start_navigation(...)";
      } else {
        $("telFcRow").classList.add("hidden");
      }
    }
  }

  // 2. Mobile tool chips
  if ($("mobChipNative")) $("mobChipNative").className = "mob-tool-chip" + (isPureNative ? " active" : "");
  if ($("mobChipSearch")) $("mobChipSearch").className = "mob-tool-chip" + (dispatchState.hasSearch ? " active" : "");
  if ($("mobChipMaps")) $("mobChipMaps").className = "mob-tool-chip" + (dispatchState.hasMaps ? " active" : "");
  if ($("mobChipFc")) $("mobChipFc").className = "mob-tool-chip" + (dispatchState.hasFc ? " active" : "");

  // 3. Glasses HUD Badges
  if ($("hudBadgeNative")) $("hudBadgeNative").className = "hud-badge" + (isPureNative ? " active" : "");
  if ($("hudBadgeSearch")) $("hudBadgeSearch").className = "hud-badge" + (dispatchState.hasSearch ? " active" : "");
  if ($("hudBadgeMaps")) $("hudBadgeMaps").className = "hud-badge" + (dispatchState.hasMaps ? " active" : "");
  if ($("hudBadgeFc")) $("hudBadgeFc").className = "hud-badge" + (dispatchState.hasFc ? " active" : "");

  // 4. Fullscreen Assistant Chips & Pill
  if ($("astChipNative")) $("astChipNative").className = "ast-chip" + (isPureNative ? " active" : "");
  if ($("astChipSearch")) $("astChipSearch").className = "ast-chip" + (dispatchState.hasSearch ? " active" : "");
  if ($("astChipMaps")) $("astChipMaps").className = "ast-chip" + (dispatchState.hasMaps ? " active" : "");
  if ($("astChipFc")) $("astChipFc").className = "ast-chip" + (dispatchState.hasFc ? " active" : "");

  if ($("astTelemetryPill")) {
    $("astTelemetryPill").classList.remove("hidden");
    if (isPureNative) {
      if ($("astTelType")) $("astTelType").textContent = "🧠 原生大模型推理";
      if ($("astTelDetail")) $("astTelDetail").textContent = "纯原生回答，未产生外部工具与接地开销 (毫秒级响应)";
    } else {
      let parts = [];
      if (dispatchState.hasSearch) parts.push("🌐 Google Search: " + dispatchState.searchQuery);
      if (dispatchState.hasMaps) parts.push("🗺️ Google Maps: " + dispatchState.mapsPoi);
      if (dispatchState.hasFc) parts.push("⚡ Function Call: " + dispatchState.fcArgs);
      if ($("astTelType")) $("astTelType").textContent = "⚡ 按需工具调度已触发";
      if ($("astTelDetail")) $("astTelDetail").textContent = parts.join(" | ");
    }
  }
}


// ----------------------------------------------------
// v66: 语音识别引擎 (Web Speech API) + 智能停顿自动发送 + 扬声器回声消除防御
// ----------------------------------------------------
// ========================================================
// 全局 Web Audio 播放管理与回声防御状态
// ========================================================
let playCtx = null;
let playTime = 0;
let activeAudioSources = new Set();
let isModelSpeaking = false;
let recentModelSpokenTexts = [];
let lastRenderedOptionsKey = "";
let lastTurnGroundingMeta = null; // 本轮最近一次 groundingMetadata（turnComplete 时用于权威名对齐/兜底）
let masterGain = null;
// v90 音频输出通道 (AEC 参考流)：
//   direct   = Web Audio 直出 playCtx.destination。Chrome 124+ 默认开启 Chrome-wide Echo Cancellation，把浏览器全部输出
//              （含 Web Audio）作为 AEC 参考；Safari/iOS 走系统级 voice processing；Firefox 全双工 cubeb 流——三者均无需兜底。
//   loopback = 经 MediaStreamAudioDestinationNode → RTCPeerConnection 本地回环 → <audio> 播放。旧版 Chrome 与 Android Chrome
//              （无 Chrome-wide AEC）的软件 AEC 只把 WebRtcAudioRenderer 渲染的“远端流”当参考；单纯把 MediaStream 接到 <audio>
//              走的是 TrackAudioRenderer，不进参考——所以必须过一次 PeerConnection 回环（v89 之前的 <audio> 直挂写法因此无效）。
//   默认：Android Chromium → loopback，其余 → direct；可用 ?sink=loopback|direct 或 localStorage.mlSink 强制；
//   duplex.js 侦测到回声泄漏时（Chromium）会自动调用 setAudioSinkMode("loopback") 升级一次。
let audioSinkMode = "direct";
let audioSinkNodes = null;
function pickDefaultSinkMode() {
  const pref = readPref("mlSink", "sink", "");
  if (pref === "direct" || pref === "loopback") return pref;
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const chromium = !!(typeof window !== "undefined" && window.chrome) || /Chrom(e|ium)\/|CriOS\//.test(ua);
  if (chromium && /Android/.test(ua)) return "loopback";
  return "direct";
}

function getMasterGain() {
  if (!playCtx) {
    try {
      playCtx = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 24000});
      window.playCtx = playCtx;
    } catch (e) {
      console.warn("[Audio] create AudioContext error:", e);
    }
  }
  if (!masterGain && playCtx) {
    masterGain = playCtx.createGain();
    masterGain.connect(playCtx.destination);
    audioSinkMode = "direct";
    if (pickDefaultSinkMode() === "loopback") { setAudioSinkMode("loopback"); }
  }
  return masterGain;
}
function getAudioSinkMode() { return audioSinkMode; }
async function setAudioSinkMode(mode) {
  if (mode !== "loopback" && mode !== "direct") return audioSinkMode;
  getMasterGain();
  if (mode === audioSinkMode) return audioSinkMode;
  if (mode === "direct") {
    try { masterGain.connect(playCtx.destination); } catch (e) {}
    if (audioSinkNodes) {
      try { if (audioSinkNodes.keepSrc) { audioSinkNodes.keepSrc.stop(); audioSinkNodes.keepSrc.disconnect(); } } catch (e) {}
      try { if (audioSinkNodes.keepGain) audioSinkNodes.keepGain.disconnect(); } catch (e) {}
      try { masterGain.disconnect(audioSinkNodes.dest); } catch (e) {}
      try { audioSinkNodes.pcA.close(); audioSinkNodes.pcB.close(); } catch (e) {}
      try { audioSinkNodes.el.srcObject = null; audioSinkNodes.el.remove(); } catch (e) {}
      audioSinkNodes = null;
    }
    audioSinkMode = "direct";
    console.log("[AudioSink] 已切回 Web Audio 直出通道");
    return audioSinkMode;
  }
  if (typeof RTCPeerConnection === "undefined" || typeof playCtx.createMediaStreamDestination !== "function") {
    console.warn("[AudioSink] 当前环境不支持 RTCPeerConnection 回环，保持直出");
    return audioSinkMode;
  }
  let dest = null, pcA = null, pcB = null, el = null, keepSrc = null, keepGain = null, probeSrc = null;
  try {
    dest = playCtx.createMediaStreamDestination();
    pcA = new RTCPeerConnection(); pcB = new RTCPeerConnection();
    pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate).catch(() => {}); };
    pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate).catch(() => {}); };
    el = document.createElement("audio");
    el.id = "aecLoopbackSink"; el.autoplay = true; el.setAttribute("playsinline", ""); el.style.display = "none";
    document.body.appendChild(el);
    const playing = new Promise((resolve) => {
      el.onplaying = () => resolve(true);
      setTimeout(() => resolve(false), 4000);
    });
    pcB.ontrack = (e) => {
      el.srcObject = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
      el.play().catch(() => {});
    };
    dest.stream.getAudioTracks().forEach(t => pcA.addTrack(t, dest.stream));
    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer);
    await pcB.setRemoteDescription(offer);
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await pcA.setRemoteDescription(answer);
    masterGain.connect(dest);              // 回环就绪前双路并行输出，避免切换瞬间丢音
    const ok = await playing;
    if (!ok) throw new Error("loopback <audio> did not start playing");
    // 真实浏览器必须实测 WebRTC RTP 字节真正到达 pcB（防止 Corp Chrome / VPN 阻断本地 UDP ICE 时 el.onplaying 假阳性导致切流静音）
    if (typeof pcB.getStats === "function") {
      if (typeof playCtx.createConstantSource === "function") {
        probeSrc = playCtx.createConstantSource();
        probeSrc.offset.value = 1e-5;
        probeSrc.connect(dest);
        probeSrc.start();
      }
      let rtpFlowing = false;
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && !rtpFlowing) {
        await new Promise(r => setTimeout(r, 80));
        const stats = await pcB.getStats();
        stats.forEach((rep) => {
          if (rep.type === "inbound-rtp" && rep.bytesReceived > 0) rtpFlowing = true;
        });
      }
      try { if (probeSrc) { probeSrc.stop(); probeSrc.disconnect(); probeSrc = null; } } catch (e2) {}
      if (!rtpFlowing) throw new Error("loopback WebRTC RTP blocked (0 bytes received)");
      pcB.oniceconnectionstatechange = () => {
        if (audioSinkMode === "loopback" && (pcB.iceConnectionState === "failed" || pcB.iceConnectionState === "disconnected")) {
          console.warn("[AudioSink] 回环 ICE 中断，自动恢复 Web Audio 直出");
          setAudioSinkMode("direct");
        }
      };
    }
    // 保持极低静音拉流负载挂接 destination，防止 macOS CoreAudio 下 AudioContext 因无直出节点停止时钟拉流 (crbug.com/933677)
    if (typeof playCtx.createConstantSource === "function") {
      keepSrc = playCtx.createConstantSource();
      keepGain = playCtx.createGain();
      keepSrc.offset.value = 0;
      keepGain.gain.value = 0;
      keepSrc.connect(keepGain);
      keepGain.connect(playCtx.destination);
      keepSrc.start();
    }
    try { masterGain.disconnect(playCtx.destination); } catch (e) {}
    audioSinkNodes = { dest, pcA, pcB, el, keepSrc, keepGain };
    audioSinkMode = "loopback";
    console.log("[AudioSink] 已切换为 WebRTC 回环播放通道（浏览器 AEC 参考流）");
  } catch (e) {
    console.warn("[AudioSink] 回环通道切换失败，保持直出:", e);
    try { if (probeSrc) { probeSrc.stop(); probeSrc.disconnect(); } } catch (e2) {}
    try { if (keepSrc) { keepSrc.stop(); keepSrc.disconnect(); } } catch (e2) {}
    try { if (keepGain) keepGain.disconnect(); } catch (e2) {}
    try { if (dest) masterGain.disconnect(dest); } catch (e2) {}
    try { if (pcA) pcA.close(); if (pcB) pcB.close(); } catch (e2) {}
    try { if (el) { el.srcObject = null; el.remove(); } } catch (e2) {}
  }
  return audioSinkMode;
}

// 彻底切断当前所有正在播放与排队的扬声器音频，实现0延迟即时静音打断 (Barge-in)
function stopAllAudioPlayback() {
  console.log("[Audio] 彻底掐断所有正在播放和排队的扬声器音频，activeSources count =", activeAudioSources.size);
  if (activeAudioSources && activeAudioSources.size > 0) {
    activeAudioSources.forEach(srcNode => {
      try {
        srcNode.stop();
        srcNode.disconnect();
      } catch (e) {}
    });
    activeAudioSources.clear();
  }
  if (playCtx) {
    try {
      playTime = playCtx.currentTime;
    } catch (e) {}
  }
  isModelSpeaking = false;
  if ($("mobMapSoundWave")) $("mobMapSoundWave").classList.remove("speaking");
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("playing"));
}

// 语义回声防御安全桩：在方案 A 全双工 PCM + AEC 下无此问题，避免误杀“天天”等选项作答
// （v90：语义回声侦测改由 duplex.js 在服务端 ASR 文本上做，阈值为“连续 ≥8 字/词逐字重合”，短答永不误杀）
function isEchoOfRecentModelSpeech(spoken) {
  return false;
}

// ========================================================
// v90: 打断协调核心 (Barge-in Core) —— 语音 / 文字 / 推荐选项 / 出行方式 四路打断共用
//   · bargeIn(reason)        瞬间掐灭全部正在播放与排队的扬声器音频；若上一轮尚未 turnComplete，布置“迟到尾包丢弃门”
//   · lateAudioGate          打断后服务端管道里仍可能有上一轮音频分片在路上，播放前一律丢弃，直到服务端 interrupted /
//                            turnComplete 确认新一轮开始（或超时兜底），杜绝“被打断后还自言自语”
//   · buildUserTextFrames    文字轮的上行封装：clientContent（默认，本项目实测可用）或 realtimeInput.text
//                            （Live API 文档对 gemini-3.1-flash-live-preview 的推荐写法；?text=realtime 或
//                            localStorage.mlTextMode="realtimeText" 切换）
//   · notifyModelOfUiAction  界面操作（点推荐选项 / 切出行方式）同步告知模型，保持多轮上下文一致并获得语音确认
// ========================================================
function readPref(lsKey, qsKey, def) {
  try {
    const q = new URLSearchParams(location.search).get(qsKey);
    if (q) return q;
    const v = localStorage.getItem(lsKey);
    if (v) return v;
  } catch (e) {}
  return def;
}
const TEXT_INPUT_MODE = /^realtime/i.test(readPref("mlTextMode", "text", "clientContent")) ? "realtimeText" : "clientContent";
const NOTIFY_MODEL_ON_UI_ACTIONS = true;
const LATE_AUDIO_DROP_MS = 1500;       // 打断后迟到尾包最长丢弃窗口（正常情况下 interrupted / turnComplete 会更早清门）
const ECHO_TURN_MUTE_MS = 15000;       // 回声轮静音上限（正常由该轮 turnComplete 或用户新话语解除）
let duplexSetupActive = false;         // 本连接 setup 是否启用了服务端 VAD（决定 realtimeText 是否需要 activityStart/End）
let expectedUiFc = null;               // 界面操作后预期模型回调的 start_navigation（去重日志用）
const lateAudioGate = { active: false, reason: "", until: 0, untilTurnComplete: false, dropped: 0, armed: 0 };
if (typeof window !== "undefined") {
  window.__awaitingNewModelTurn = false;
  window.__newModelTurnStarted = false;
}
function markModelBoundaryCleared() {
  if (typeof window !== "undefined") {
    window.__awaitingNewModelTurn = true;
    window.__newModelTurnStarted = false;
  }
}
function prepareFreshModelTurnIfNeeded() {
  if (typeof window === "undefined" || !window.__awaitingNewModelTurn) return;
  window.__awaitingNewModelTurn = false;
  // 若 Duplex 尚未收到新一轮 inputTranscription（Gemini 3.8 Live 常提前 2~200ms 先发 inlineData 语音），
  // 在首帧新模型输出前做无损清场（绝不调 stopAllAudioPlayback），并标记新回复已开流，防止迟到的 inputTranscription 误杀新声音！
  const userTurnAlreadyOpen = !!(window.DuplexVoice && window.DuplexVoice.voiceTurnOpen);
  if (!userTurnAlreadyOpen) {
    window.__newModelTurnStarted = true;
    if (window.DuplexVoice && typeof window.DuplexVoice.noteModelText === "function" && currentModelTranscript) {
      try { window.DuplexVoice.noteModelText(currentModelTranscript); } catch (e) {}
    }
    try { if (typeof simState === "undefined" || !simState.active) exitNavigation(); } catch (e) {}
    currentModelTranscript = "";
    try { renderRecommendationOptions([]); } catch (e) {}
    try { if (typeof lastRenderedOptionsKey !== "undefined") lastRenderedOptionsKey = ""; } catch (e) {}
    try { resetDispatchState(); } catch (e) {}
    sceneLock = true;
  }
}

function duplexMicOn() { return !!(typeof window !== "undefined" && window.DuplexVoice && window.DuplexVoice.micOn); }
function duplexReady() {
  return !!(typeof window !== "undefined" && window.DuplexVoice &&
            typeof window.DuplexVoice.supported === "function" && window.DuplexVoice.supported());
}

function armLateAudioGate(reason, untilTurnComplete) {
  // 上一轮已 turnComplete：服务端不会再下发旧音频，不设门（否则会误吞新一轮的开头）
  if (!sceneLock && !untilTurnComplete) return false;
  lateAudioGate.active = true;
  lateAudioGate.reason = reason || "barge-in";
  lateAudioGate.untilTurnComplete = !!untilTurnComplete;
  lateAudioGate.until = Date.now() + (untilTurnComplete ? ECHO_TURN_MUTE_MS : LATE_AUDIO_DROP_MS);
  lateAudioGate.armed++;
  console.log(`[BargeIn] 迟到音频丢弃门已布置 (${lateAudioGate.reason})`);
  return true;
}
function clearLateAudioGate(why) {
  if (!lateAudioGate.active) return;
  if (lateAudioGate.untilTurnComplete) {
    if (why === "interrupted") return;                                    // 回声轮静音要坚持到该轮 turnComplete
    if (why === "turnComplete" && lateAudioGate.dropped === 0) return;    // 这是被回声打断的上一轮的收尾，回声轮自己的回复还没开始
  } else if (why === "user_turn") {
    return;                                                               // 普通迟到帧门只认 interrupted / turnComplete / 超时
  }
  console.log(`[BargeIn] 迟到音频丢弃门解除 (${why})，期间丢弃分片 ${lateAudioGate.dropped}`);
  lateAudioGate.active = false; lateAudioGate.untilTurnComplete = false; lateAudioGate.dropped = 0;
}
function shouldDropLateAudio() {
  if (!lateAudioGate.active) return false;
  if (Date.now() > lateAudioGate.until) { clearLateAudioGate("timeout"); return false; }
  lateAudioGate.dropped++;
  return true;
}

// 四路打断统一入口。返回：上一轮是否仍在进行（即是否布置了迟到帧门）
function bargeIn(reason) {
  const turnOpen = !!sceneLock;
  if (typeof window !== "undefined") {
    window.__awaitingNewModelTurn = false;
    window.__newModelTurnStarted = false;
  }
  stopAllAudioPlayback();
  if (turnOpen) armLateAudioGate(reason);
  if (typeof window !== "undefined" && window.DuplexVoice && typeof window.DuplexVoice.bargeIn === "function") {
    try { window.DuplexVoice.bargeIn(reason); } catch (e) {}
  }
  return turnOpen;
}

function buildUserTextFrames(text) {
  if (TEXT_INPUT_MODE === "realtimeText") {
    if (duplexSetupActive) return [{ realtimeInput: { text } }];
    // 服务端 VAD 关闭时，realtime 文本必须自带活动边界
    return [{ realtimeInput: { activityStart: {} } }, { realtimeInput: { text } }, { realtimeInput: { activityEnd: {} } }];
  }
  return [{ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }];
}

// 界面操作 → 模型：opts.always 无条件发送；否则仅在语音会话进行中、或模型正处于本轮（刚被打断）时发送
function notifyModelOfUiAction(text, opts) {
  opts = opts || {};
  if (!NOTIFY_MODEL_ON_UI_ACTIONS || !text) return false;
  if (!opts.always && !duplexMicOn() && !opts.wasMidTurn) return false;
  if (!(ws && ws.readyState === WebSocket.OPEN && ready)) return false;
  if (opts.expectDest) expectedUiFc = { dest: opts.expectDest, mode: opts.expectMode || "DRIVING", ts: Date.now() };
  sceneLock = true;
  currentModelTranscript = "";
  dispatch({ kind: "text", text });
  return true;
}

function normDestKey(s) { return String(s || "").toLowerCase().replace(/[\s\-·'’&\.,，、()（）【】\[\]]/g, ""); }
// 同一目的地判定（保守）：归一化后相等，或短名（≥4 字）被长名包含
function isSameDestination(a, b) {
  const x = normDestKey(a), y = normDestKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const s = x.length <= y.length ? x : y, l = x.length <= y.length ? y : x;
  return s.length >= 4 && l.indexOf(s) >= 0;
}
function routeUiActive() {
  const card = $("routePreviewCard");
  return !!((card && !card.classList.contains("hidden")) || (typeof simState !== "undefined" && simState && simState.active));
}

// 切换出行方式（桌面 .mode-tab / 手机 .mob-mode-pill）：先掐断播报，再本地重算路线，并（语音会话中 / 模型正在说时）告知模型
function onTravelModeSwitched(mode) {
  if (!mode) return;
  const wasMidTurn = !!sceneLock || !!(activeAudioSources && activeAudioSources.size > 0);
  bargeIn("mode");
  calculateModeRoute(mode, false);
  if (!activeDestination) return;
  const modeName = (MODE_CONFIG[mode] && MODE_CONFIG[mode].name) || mode;
  notifyModelOfUiAction(`我已在界面上改为${modeName}前往「${activeDestination}」，请一句话简短确认即可，不要重复规划，也不要再询问出行方式。`,
    { wasMidTurn, expectDest: activeDestination, expectMode: mode });
}
// ==== BARGE-IN CORE (v90) END ====

// ========================================================
// 真实电脑麦克风驱动与多端智能语音对讲引擎 (VoiceEngine)
// 支持: 持续收音模式 (Continuous)
//       + 智能停顿自动发送 (说话停止 1.8 秒后自动断开并发送)
//       + 随时主动点击麦克风提前发送
//       + 开麦瞬间强停扬声器音频，彻底杜绝回声自环
//       + 物理麦克风硬件唤醒 (getUserMedia AEC) + 实时音量电平感知
//       + 毫秒级打字机上屏与全端同屏广播
// ========================================================

let recognition = null;
let isRecording = false;
let userWantsRecording = false; // 用户意图状态机：用户要求收音
let voiceStream = null;
let voiceAudioCtx = null;
let voiceAnalyser = null;
let voiceDataArray = null;
let voiceAnimId = null;
let voiceAccumulatedText = ""; // 持续累积识别的完整文本
let voiceSilenceTimer = null;
const VOICE_SILENCE_TIMEOUT_MS = 1800; // 黄金 1.8 秒静音自动提交判定窗口

// ========================================================
// v82: 语音会话作用域 (Voice Scope) —— 每一次开麦都归属于一个视图工作区，
// 采集、上屏、发送、按钮高亮全部只在该工作区内发生，彻底杜绝
// “在手机端语音助手说话，却把主地图屏幕输入框里的旧问题发出去”。
//   console   桌面全景控制台  输入框 #text            麦克风 #btnMainMic
//   mobile    手机旅行伴侣    输入框 #mobSearchInput  麦克风 #btnMobTalk / #mobBtnMic
//   glasses   AR 眼镜 HUD     (无输入框)              麦克风 #gBtnMic
//   assistant 全屏语音助手    输入框 #astInputText    麦克风 #astBtnMic
// ========================================================
const VOICE_SCOPES = {
  console:   { input: "text",           mics: ["btnMainMic"] },
  mobile:    { input: "mobSearchInput", mics: ["btnMobTalk", "mobBtnMic"] },
  glasses:   { input: null,             mics: ["gBtnMic"] },
  assistant: { input: "astInputText",   mics: ["astBtnMic"] }
};
const ALL_MIC_BUTTON_IDS = ["btnMainMic", "mobBtnMic", "btnMobTalk", "gBtnMic", "astBtnMic"];
let voiceScope = null;    // 当前语音会话所属工作区；无会话时为 null
let voiceSessionId = 0;   // 会话票据：每次开麦自增，异步回调/定时器凭票据校验，过期一律作废

// 根据当前可见的视图层推断工作区（供无参调用 toggleVoiceRecording() 的控制台/自动化脚本使用）
function getActiveViewScope() {
  const shown = (id) => { const el = $(id); return !!el && !el.classList.contains("hidden"); };
  if (shown("viewAssistantOverlay")) return "assistant";
  if (shown("viewMobileOverlay")) return "mobile";
  if (shown("viewGlassesOverlay")) return "glasses";
  return "console";
}
function scopeInput(scope) {
  const s = scope && VOICE_SCOPES[scope];
  return (s && s.input) ? $(s.input) : null;
}
function clearScopeInput(scope) {
  const inp = scopeInput(scope);
  if (inp) inp.value = "";
}

function showVoiceToast(msg, duration = 3500) {
  let toast = $("voiceToastPill");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "voiceToastPill";
    toast.className = "voice-toast-pill";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("visible");
  if (window._voiceToastTimer) clearTimeout(window._voiceToastTimer);
  if (duration > 0) {
    window._voiceToastTimer = setTimeout(() => {
      hideVoiceToast();
    }, duration);
  }
}

function hideVoiceToast() {
  const toast = $("voiceToastPill");
  if (toast) toast.classList.remove("visible");
}

function initVoiceEngine() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    console.warn("当前浏览器未开放原生 SpeechRecognition，将采用 getUserMedia 麦克风音频感知模式");
    return;
  }
  try {
    if (recognition) {
      try { recognition.abort(); } catch (e) {}
    }
    recognition = new SpeechRec();
    recognition.lang = "zh-CN"; // 默认普通话，支持中英文混识
    recognition.continuous = true; // 开启持续收音，句间思考换气绝不提前误断开
    recognition.interimResults = true; // 开启实时中间转写结果，实现打字机效果
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (!userWantsRecording) {
        // 会话在引擎拉起期间已被取消/替换：立即停掉，不允许出现无主的僵尸收音
        try { recognition.stop(); } catch (e) {}
        return;
      }
      console.log(`[VoiceEngine] 麦克风持续收音已启动 (scope=${voiceScope}, 停顿 1.8s 自动发送)`);
      isRecording = true;
      updateAllMicButtons(true);
      showVoiceToast("🎙️ 正在收听… 说话停顿约2秒自动发送，也可点击麦克风提前发送", 4000);
    };

    recognition.onresult = (event) => {
      // 【作用域守卫】会话已被取消/替换后，底层引擎仍可能吐出尾包，一律丢弃，绝不写入任何输入框
      if (!userWantsRecording) return;
      const sid = voiceSessionId;

      // 【防打断与防回声安全网 1】：若模型正在播报语音，坚决忽略麦克风输入，防止外放声音触发打断！
      if (isModelSpeaking || (activeAudioSources && activeAudioSources.size > 0)) {
        console.log("[VoiceEngine] 模型正在播报语音中，忽略扬声器外放声音");
        if (voiceSilenceTimer) {
          clearTimeout(voiceSilenceTimer);
          voiceSilenceTimer = null;
        }
        return;
      }

      let finalTranscript = "";
      let interimTranscript = "";
      for (let i = 0; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          finalTranscript += item[0].transcript;
        } else {
          interimTranscript += item[0].transcript;
        }
      }
      const fullSpoken = (finalTranscript + interimTranscript).trim();
      if (fullSpoken) {
        voiceAccumulatedText = fullSpoken;
        // 实时打字机只上屏到【本次语音会话所属工作区】自己的输入框（视图隔离），不再横向写入其它端
        const ownInput = scopeInput(voiceScope);
        if (ownInput) ownInput.value = fullSpoken;
        broadcastModelTranscript(`🎙️ 正在收听您的麦克风: “${fullSpoken}”`);

        // 【核心能力 1】：动态重置静音定时器！
        // 说话过程中每次有新字进来，立即清除旧定时器；
        // 允许正常换气停顿，停顿超过 1.8 秒无新语音输入时，判定整句说完，自动停止录音并发送！
        if (voiceSilenceTimer) {
          clearTimeout(voiceSilenceTimer);
          voiceSilenceTimer = null;
        }
        voiceSilenceTimer = setTimeout(() => {
          voiceSilenceTimer = null;
          // 过期票据：定时器所属会话已被替换（例如用户已在另一端重新开麦），绝不能替新会话发送旧内容
          if (sid !== voiceSessionId || !userWantsRecording) return;
          console.log("[VoiceEngine] ⏱️ 说话停顿已达 1.8 秒，自动停止录音并发送！");
          stopVoiceRecordingAndSend(true);
        }, VOICE_SILENCE_TIMEOUT_MS);
      }
    };

    recognition.onend = () => {
      console.log("[VoiceEngine] recognition.onend 触发. userWantsRecording =", userWantsRecording);
      // 如果用户仍处于录音态但底层意外关闭（例如静音偶发），平滑自动续接保持监听
      if (userWantsRecording) {
        console.log("[VoiceEngine] 用户处于录音态，平滑重启持续收音…");
        setTimeout(() => {
          if (userWantsRecording && recognition) {
            try { recognition.start(); } catch (e) {}
          }
        }, 150);
        return;
      }

      // 录音正常停止后的硬件释放与状态复位
      if (voiceSilenceTimer) {
        clearTimeout(voiceSilenceTimer);
        voiceSilenceTimer = null;
      }
      stopVoiceHardware();
      isRecording = false;
      updateAllMicButtons(false);
      hideVoiceToast();
    };

    recognition.onerror = (err) => {
      console.warn("[VoiceEngine] 语音识别事件或状态:", err.error, err);
      if (err.error === "audio-capture") {
        showVoiceToast("⚠️ 电脑麦克风设备未就绪，请检查系统麦克风连接或权限设置！", 4000);
      } else if (err.error === "not-allowed" || err.error === "service-not-allowed") {
        showVoiceToast("⚠️ 麦克风权限被拒绝，请在浏览器地址栏左侧允许麦克风权限！", 4000);
      } else if (err.error === "no-speech") {
        return;
      } else if (err.error === "network") {
        showVoiceToast("网络连接波动，正在保持收音…", 2500);
      }
      if (!userWantsRecording) {
        stopVoiceHardware();
        isRecording = false;
        updateAllMicButtons(false);
      }
    };
  } catch (e) {
    console.warn("[VoiceEngine] 初始化异常:", e);
  }
}

// 停止录音并可选提交发送
function stopVoiceRecordingAndSend(shouldSend = true) {
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (!userWantsRecording && !isRecording) return;

  const scope = voiceScope;
  console.log(`[VoiceEngine] stopVoiceRecordingAndSend 被调用, shouldSend = ${shouldSend}, scope = ${scope}`);
  userWantsRecording = false;
  isRecording = false;

  // 停止底层的语音识别与物理麦克风硬件
  if (recognition) {
    try { recognition.stop(); } catch (e) { recognition.abort(); }
  }
  stopVoiceHardware();
  updateAllMicButtons(false);
  hideVoiceToast();
  voiceScope = null;

  // 【作用域隔离铁律】只发送本次语音会话真实识别到的文本 voiceAccumulatedText。
  // 绝不回读 $("text") / $("mobSearchInput") / $("astInputText")：这些输入框可能残留主地图屏幕或其它端
  // 上一轮的旧问题，回读等于把旧问题冒充成用户刚说的话发出去（v81 及之前“手机助手说话却发送主屏旧问题”的根因）。
  const cleanSpoken = (voiceAccumulatedText || "").trim();
  voiceAccumulatedText = "";
  clearScopeInput(scope); // 本工作区的实时预览已完成使命（发送 / 作废），清空，防止残留成为下一轮污染源

  if (!shouldSend) return;

  if (cleanSpoken && !cleanSpoken.startsWith("🎙️")) {
    // 【回声防御核心 2】：语义回声拦截
    if (isEchoOfRecentModelSpeech(cleanSpoken)) {
      console.warn("[AntiEcho] 检测到外放回音被重新录入，已自动拦截过滤:", cleanSpoken);
      showVoiceToast("🔇 检测到扬声器外放回声，已自动拦截过滤", 3000);
      return;
    }

    console.log(`[VoiceEngine] 提交发送本次会话识别文本 (scope=${scope}):`, cleanSpoken);
    showVoiceToast("⏱️ 停顿已自动发送", 2000);
    sendQuery(cleanSpoken);
  } else {
    showVoiceToast("未检测到有效说话内容，已退出录音", 2000);
  }
}

// 激活并监测电脑物理麦克风硬件 (唤起浏览器麦克风授权弹窗并读取音量电平，启用最高级AEC回声消除)
async function startVoiceHardware(sid) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Chrome 声学回声消除与高通滤波优化
        googEchoCancellation: true,
        googAutoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: true
      }
    });
    // 等待授权期间会话已被取消或被另一端的新会话替换：立即释放这条流，不得覆盖当前会话的 voiceStream
    if (sid !== undefined && (sid !== voiceSessionId || !userWantsRecording)) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      return null;
    }
    voiceStream = stream;
    console.log("[VoiceEngine] 电脑物理麦克风硬件已成功唤醒并授权 (AEC硬件级回声消除已启用)");
    
    // 连接 Web Audio Analyser 实时读取说话音量
    try {
      if (!voiceAudioCtx) {
        voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (voiceAudioCtx.state === "suspended") {
        await voiceAudioCtx.resume();
      }
      const source = voiceAudioCtx.createMediaStreamSource(voiceStream);
      voiceAnalyser = voiceAudioCtx.createAnalyser();
      voiceAnalyser.fftSize = 64;
      source.connect(voiceAnalyser);
      voiceDataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);

      function checkVolume() {
        if (!userWantsRecording || !voiceAnalyser) return;
        voiceAnalyser.getByteFrequencyData(voiceDataArray);
        let sum = 0;
        for (let i = 0; i < voiceDataArray.length; i++) sum += voiceDataArray[i];
        const avg = sum / voiceDataArray.length;
        // 根据音量振幅微调【本工作区】麦克风按钮的动画强度
        const scale = 1 + Math.min(avg / 96, 0.35);
        const ownMics = (voiceScope && VOICE_SCOPES[voiceScope]) ? VOICE_SCOPES[voiceScope].mics : [];
        const micBtn = ownMics.length ? $(ownMics[0]) : null;
        if (micBtn && userWantsRecording) {
          micBtn.style.transform = `scale(${scale})`;
        }
        voiceAnimId = requestAnimationFrame(checkVolume);
      }
      checkVolume();
    } catch (e) {}
    return stream;
  } catch (err) {
    console.warn("[VoiceEngine] 电脑麦克风权限申请受阻:", err);
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      showVoiceToast("⚠️ 请允许浏览器访问您的电脑麦克风！", 4000);
    }
    return null;
  }
}

// 释放电脑物理麦克风硬件资源
function stopVoiceHardware() {
  if (voiceAnimId) {
    cancelAnimationFrame(voiceAnimId);
    voiceAnimId = null;
  }
  if (voiceStream) {
    voiceStream.getTracks().forEach(track => {
      try { track.stop(); } catch (e) {}
    });
    voiceStream = null;
  }
  voiceAnalyser = null;
  ALL_MIC_BUTTON_IDS.forEach(id => { const b = $(id); if (b) b.style.transform = ""; });
}

// 统一对外控制开关：点击启动收音，支持停顿 1.8s 自动发送，或在【同一工作区】再次点击提前提交！
// scope: "console" | "mobile" | "glasses" | "assistant"，由各端麦克风按钮显式传入；
//        无参（控制台 / 自动化脚本）或误传 Event 时，按当前可见视图推断。
async function toggleVoiceRecording(scope) {
  if (typeof scope !== "string" || !VOICE_SCOPES[scope]) scope = getActiveViewScope();
  // v90: 浏览器具备 getUserMedia + AudioWorklet 时由全双工引擎接管：点击 = 开麦常听（多轮不关），再点 = 关麦。
  //      下方 Web Speech 半双工流程只作为不支持 AudioWorklet 的老旧浏览器退路保留。
  if (typeof window !== "undefined" && window.DuplexVoice && typeof window.DuplexVoice.supported === "function" && window.DuplexVoice.supported()) {
    return window.DuplexVoice.toggle(scope);
  }
  resumeAudioIfNeeded();

  // 1. 【回声消除核心 1】：开麦前必须彻底掐断所有扬声器正在播放的声音，瞬间静音！
  stopAllAudioPlayback();

  // 2. 当前已有收音会话
  if (userWantsRecording || isRecording) {
    if (voiceScope === scope) {
      // 同一工作区再次点击 -> 用户要求提前提交，只发送本会话真实识别到的内容
      console.log(`[VoiceEngine] 用户在 ${scope} 端再次点击麦克风，提前发送！`);
      stopVoiceRecordingAndSend(true);
      return;
    }
    // 跨工作区点击：用户已经切到另一端并开麦。旧会话（很可能一个字都没听到）作废且【绝不发送】，
    // 否则就会出现“在手机助手说话，系统却把主地图屏幕里的旧问题发出去”的事故。
    console.warn(`[VoiceEngine] ${voiceScope} 端的收音会话仍在进行，用户已在 ${scope} 端开麦 -> 作废旧会话(不发送)，在新工作区重新收音`);
    stopVoiceRecordingAndSend(false);
  }

  // 3. 在指定工作区启动全新收音会话（领取新票据）
  stopAllAudioPlayback(); // 再次确保扬声器无任何排队声音
  const sid = ++voiceSessionId;
  voiceScope = scope;
  userWantsRecording = true;
  isRecording = true;
  voiceAccumulatedText = "";
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  clearScopeInput(scope); // 只清空本工作区自己的输入框，不触碰其它端

  updateAllMicButtons(true);
  showVoiceToast("🎙️ 正在收听… 说话停顿约2秒自动发送，也可点击麦克风提前发送", 4000);

  // 尝试激活真实物理麦克风硬件 (带 AEC 回声消除与降噪)
  await startVoiceHardware(sid);

  // 等待麦克风授权期间，会话可能已被取消或被另一端的新会话替换：过期票据不得再拉起识别引擎（否则产生无主的僵尸收音）
  if (sid !== voiceSessionId || !userWantsRecording) {
    console.log(`[VoiceEngine] 会话票据 #${sid} 已过期 (当前 #${voiceSessionId})，放弃拉起识别引擎`);
    return;
  }

  // 启动语音识别
  if (!recognition) {
    initVoiceEngine();
  }

  if (recognition) {
    try {
      recognition.start();
    } catch (err) {
      console.warn("[VoiceEngine] 启动异常，重置拉起:", err);
      try {
        recognition.abort();
        setTimeout(() => {
          if (sid === voiceSessionId && userWantsRecording && recognition) {
            try { recognition.start(); } catch (e) {}
          }
        }, 150);
      } catch (e) {}
    }
  }
}

// ========================================================
// Omni-Sync Core (全域多端强同步广播体系)
// 覆盖: 主页全景、手机端、AR智能眼镜 HUD、全屏语音助手
// ========================================================

// 只高亮【当前语音会话所属工作区】的麦克风按钮与提示文案；其它端保持空闲态，
// 这样用户在别的端看到的永远是“点击语音说话”，点下去就是一次全新的、属于该端的收音。
function updateAllMicButtons(recording) {
  // v90 全双工：麦克风是全局唯一资源，所有端的麦克风按钮同步高亮，文案由引擎按状态机刷新
  if (typeof window !== "undefined" && window.DuplexVoice && window.DuplexVoice.micOn) {
    ALL_MIC_BUTTON_IDS.forEach(id => { const b = $(id); if (b) b.classList.add("recording"); });
    try { window.DuplexVoice.refreshLabels(); } catch (e) {}
    return;
  }
  const scope = voiceScope;
  const ownMics = (recording && scope && VOICE_SCOPES[scope]) ? VOICE_SCOPES[scope].mics : [];
  ALL_MIC_BUTTON_IDS.forEach(id => {
    const b = $(id);
    if (!b) return;
    if (ownMics.indexOf(id) >= 0) {
      b.classList.add("recording");
    } else {
      b.classList.remove("recording");
    }
  });

  if ($("mobTalkLabel")) {
    $("mobTalkLabel").textContent = (recording && scope === "mobile") ? "正在收听… (停顿约2s自动发送)" : "点击语音说话";
  }
  if ($("mobAssistantState")) {
    const mObj = (typeof getActiveModelObj === "function") ? getActiveModelObj() : { shortName: "Gemini 3.8 Live" };
    $("mobAssistantState").textContent = (recording && scope === "mobile") ? "🎙️ 正在实时收听… (说话停顿约2秒自动发送)" : `${mObj.shortName} 待命中 · 点击下方按钮说话`;
  }
  if ($("astListeningText")) {
    $("astListeningText").textContent = (recording && scope === "assistant") ? "正在收听电脑麦克风 · 说话停顿约2秒自动发送" : "正在收听 · 随时与 Gemini 自然对话";
  }
  if ($("text")) {
    if (recording && scope === "console") {
      if (!$("text").getAttribute("data-old-placeholder")) {
        $("text").setAttribute("data-old-placeholder", $("text").placeholder);
      }
      $("text").placeholder = "🎙️ 正在收听… 说话停顿约2秒自动发送，也可点击麦克风提前发送";
    } else {
      const old = $("text").getAttribute("data-old-placeholder");
      if (old) $("text").placeholder = old;
    }
  }
}

// 1. 用户输入与语音提问全端同屏广播
function broadcastUserTranscript(userText) {
  if (!userText) return;
  currentUserTranscript = userText;

  // 1. 全景面板
  if ($("userBubble")) {
    $("userBubble").textContent = "“" + userText + "”";
    $("userBubble").classList.remove("hidden");
  }
  // 2. 手机端 (助手Tab气泡 + 地图视窗悬浮字幕卡片)
  if ($("mobUserBubble")) {
    $("mobUserBubble").textContent = "“" + userText + "”";
    $("mobUserBubble").classList.remove("hidden");
  }
  if ($("mobMapSubtitleCard")) {
    $("mobMapSubtitleCard").classList.remove("hidden");
  }
  if ($("mobMapUserSpeech")) {
    $("mobMapUserSpeech").textContent = "“" + userText + "”";
    $("mobMapUserSpeech").classList.remove("hidden");
  }
  if ($("mobMapSubtitleText")) {
    $("mobMapSubtitleText").textContent = "正在思考与实时检索中…";
  }
  // 3. AR 眼镜端 (HUD 字幕与对话流)
  if ($("hudUserLine")) {
    $("hudUserLine").textContent = "“" + userText + "”";
  }
  if ($("hudUserMsg")) {
    $("hudUserMsg").textContent = "“" + userText + "”";
  }
  // 4. 全屏专属纯语音助手
  if ($("astUserBubble")) {
    $("astUserBubble").textContent = "“" + userText + "”";
    $("astUserBubble").classList.remove("hidden");
  }

  // v82: 不再把提问反向写回任何输入框。输入框只属于“正在编辑的下一句话”，历史提问由各端气泡承载。
  // （此前每次 sendQuery / 切到手机视图都会把上一轮问题灌回 #text / #mobSearchInput / #astInputText，
  //   成为语音 fallback 误发旧问题的污染源。）
}

// 对话气泡展示专用清洗函数：剔除机械前缀与推荐选项技术标签，只展示自然亲切的口语
function sanitizeDisplayText(raw) {
  if (!raw) return "";
  let clean = raw;
  // 1. 清除“正在思考与实时检索中…”等临时等待前缀
  clean = clean.replace(/^(?:正在思考与实时检索中[…\.]*|思考中[…\.]*|正在收听[…\.]*)+/g, "");
  // 2. 清除用于系统算法生成按键的技术标记标签: 【推荐选项：A | B】
  //    原生音频模型的转写里通常没有【】和 |（语音念不出来），可能变成“推荐选项：A、B。”或“推荐选项，A，B”，一并清洗
  //    只在“【”开头或“选项”后紧跟冒号/逗号时清洗，避免误伤“推荐选项很多，比如…”这类自然句
  clean = clean.replace(/(?:【\s*(?:推荐|快捷|候选)选项\s*[：:，,]?|(?:推荐|快捷|候选)选项\s*[：:，,])[^】\n。！？!?]*】?[。！？!?]?/g, "");
  //    流式阶段标记只到了一半（“【推荐选” / “【推荐选项：滨海”），先藏起来，避免气泡里闪出半个标签
  clean = clean.replace(/【(?:推(?:荐(?:选(?:项)?)?)?|快(?:捷(?:选(?:项)?)?)?|候(?:选(?:选(?:项)?)?)?)?\s*$/, "");
  clean = clean.replace(/【\s*】/g, "").replace(/[ \t]{2,}/g, " ");
  return clean.trim();
}

// 2. 大模型流式回复实时全端字字同屏广播 (彻底消灭某端留在"思考中…")
function broadcastModelTranscript(modelText) {
  if (modelText === undefined || modelText === null) return;
  if (modelText === "正在思考与实时检索中…" || modelText === "思考中…") {
    currentModelTranscript = "";
    if ($("modelBubble")) $("modelBubble").textContent = modelText;
    if ($("mobModelBubble")) $("mobModelBubble").textContent = modelText;
    if ($("hudTranscript")) $("hudTranscript").textContent = modelText;
    if ($("hudModelLine")) $("hudModelLine").textContent = modelText;
    if ($("hudModelMsg")) $("hudModelMsg").textContent = modelText;
    if ($("astModelBubble")) $("astModelBubble").textContent = modelText;
    if ($("mobMapSubtitleCard")) $("mobMapSubtitleCard").classList.remove("hidden");
    if ($("mobMapSubtitleText")) $("mobMapSubtitleText").textContent = modelText;
    return;
  }

  currentModelTranscript = modelText;
  const displayText = sanitizeDisplayText(modelText) || modelText;

  // 1. 全景主页
  if ($("modelBubble")) {
    $("modelBubble").textContent = displayText;
  }
  // 2. 手机端 (助手Tab气泡 + 地图视窗悬浮字幕卡片)
  if ($("mobModelBubble")) {
    $("mobModelBubble").textContent = displayText;
  }
  if ($("mobMapSubtitleCard")) {
    $("mobMapSubtitleCard").classList.remove("hidden");
  }
  if ($("mobMapSubtitleText")) {
    $("mobMapSubtitleText").textContent = displayText;
    $("mobMapSubtitleText").scrollTop = $("mobMapSubtitleText").scrollHeight;
  }
  // 3. AR 智能眼镜双目 HUD (右目实景导航字幕 + AR 助手对话流)
  if ($("hudTranscript")) {
    $("hudTranscript").textContent = displayText;
  }
  if ($("hudModelLine")) {
    $("hudModelLine").textContent = displayText;
  }
  if ($("hudModelMsg")) {
    $("hudModelMsg").textContent = displayText;
  }
  // 4. 全屏专属纯语音助手
  if ($("astModelBubble")) {
    $("astModelBubble").textContent = displayText;
  }

  // 自动滚动各端对话流到底部
  const ab = document.querySelector(".assistant-body");
  if (ab) ab.scrollTop = ab.scrollHeight;
  const mobStream = $("mobChatStream");
  if (mobStream) mobStream.scrollTop = mobStream.scrollHeight;
  const astStage = $("astDialogueCard");
  if (astStage) astStage.scrollTop = astStage.scrollHeight;

  // 动态助手状态文字反馈
  if (displayText && displayText !== "思考中…" && displayText !== "正在思考与实时检索中…" &&
      !(typeof window !== "undefined" && window.DuplexVoice && window.DuplexVoice.micOn)) {   // 全双工时文案由 duplex.js 状态机接管（“播报中 · 开口即可打断”）
    if ($("astListeningText")) $("astListeningText").textContent = "正在播报 · 实时语音回复中…";
    if ($("mobAssistantState")) $("mobAssistantState").textContent = "正在播报 · 实时语音回复中…";
  }
}

// 兼容接口
function syncAllAssistantBubbles(userText, modelText) {
  if (userText) broadcastUserTranscript(userText);
  if (modelText) broadcastModelTranscript(modelText);
}

// 3. 出行方式全端双向互锁广播 (开/骑/步)
function broadcastTravelMode(mode) {
  selectedTravelMode = mode;
  const modeObj = MODE_CONFIG[mode] || MODE_CONFIG.DRIVING;

  // 1. 桌面端 .mode-tab 高亮
  document.querySelectorAll(".mode-tab").forEach(tab => {
    if (tab.dataset.mode === mode) tab.classList.add("active");
    else tab.classList.remove("active");
  });

  // 2. 手机端 .mob-mode-pill 高亮
  document.querySelectorAll(".mob-mode-pill").forEach(pill => {
    if (pill.dataset.mode === mode) pill.classList.add("active");
    else pill.classList.remove("active");
  });

  // 3. 桌面端路牌出行模式徽章
  if ($("navActiveModeBadge")) {
    $("navActiveModeBadge").textContent = modeObj.icon + " " + modeObj.name;
  }

  // 4. 手机端底栏出行模式徽章
  if ($("mobModeTag")) {
    $("mobModeTag").textContent = modeObj.icon + " " + modeObj.name;
  }

  // 5. AR 智能眼镜 HUD 模式徽章
  if ($("hudNavModeLabel")) {
    $("hudNavModeLabel").textContent = `${modeObj.icon} ${modeObj.name.toUpperCase()} HUD`;
  }
  if ($("hudModeIndicator")) {
    const isPaused = simState.paused;
    const mObj = (typeof getActiveModelObj === "function") ? getActiveModelObj() : { shortName: "Gemini 3.8 Live" };
    $("hudModeIndicator").textContent = isPaused 
      ? `${mObj.shortName.toUpperCase()} · ⏸️ ${modeObj.name.toUpperCase()} (PAUSED)`
      : `${mObj.shortName.toUpperCase()} · ${modeObj.icon} ${modeObj.name.toUpperCase()} HUD`;
  }
}

// 4. 多备选方案全端同步渲染与切换广播
function broadcastAltRoutes(routes, selectedIdx) {
  const container = $("altRoutesSelector");
  const list = $("altRoutesList");
  const mobContainer = $("mobAltRoutesSelector");
  const mobList = $("mobAltRoutesList");

  if (!routes || routes.length <= 1) {
    if (container) { container.classList.add("hidden"); if (list) list.innerHTML = ""; }
    if (mobContainer) { mobContainer.classList.add("hidden"); if (mobList) mobList.innerHTML = ""; }
    return;
  }

  // 1. 桌面端备选路线芯片
  if (container && list) {
    list.innerHTML = "";
    routes.forEach((r, idx) => {
      const leg = r.legs[0];
      const chip = document.createElement("button");
      chip.className = "alt-route-chip" + (idx === selectedIdx ? " active" : "");
      const isRecommended = idx === 0;
      const dur = leg.duration ? leg.duration.text : "";
      const dist = leg.distance ? leg.distance.text : "";
      chip.innerHTML = `<span>方案 ${idx + 1}</span> <b>${dur}</b> <small>(${dist})</small>${isRecommended ? " · 推荐" : ""}`;
      chip.onclick = (e) => {
        e.stopPropagation();
        switchSelectedRoute(idx);
      };
      list.appendChild(chip);
    });
    container.classList.remove("hidden");
  }

  // 2. 手机端备选路线芯片
  if (mobContainer && mobList) {
    mobList.innerHTML = "";
    routes.forEach((r, idx) => {
      const leg = r.legs[0];
      const chip = document.createElement("button");
      chip.className = "mob-alt-chip" + (idx === selectedIdx ? " active" : "");
      const isRecommended = idx === 0;
      const dur = leg.duration ? leg.duration.text : "";
      const dist = leg.distance ? leg.distance.text : "";
      chip.innerHTML = `<span>方案 ${idx + 1}</span> <b>${dur}</b> <small>(${dist})</small>${isRecommended ? " · 推荐" : ""}`;
      chip.onclick = (e) => {
        e.stopPropagation();
        switchSelectedRoute(idx);
      };
      mobList.appendChild(chip);
    });
    mobContainer.classList.remove("hidden");
  }
}

// 5. 导航暂停/继续状态全端同步
function broadcastSimPause(isPaused) {
  if ($("btnPauseNav")) {
    $("btnPauseNav").textContent = isPaused ? "▶️ 继续" : "⏸️ 暂停";
    $("btnPauseNav").title = isPaused ? "从当前位置继续巡航" : "暂停当前巡航";
  }
  if ($("btnMobPause")) {
    $("btnMobPause").textContent = isPaused ? "▶️ 继续" : "⏸️ 暂停";
    $("btnMobPause").title = isPaused ? "从当前位置继续巡航" : "暂停当前巡航";
  }
  if ($("navBanner")) {
    if (isPaused) $("navBanner").classList.add("is-paused");
    else $("navBanner").classList.remove("is-paused");
  }
  if ($("hudNavModeLabel")) {
    const modeObj = MODE_CONFIG[selectedTravelMode] || MODE_CONFIG.DRIVING;
    $("hudNavModeLabel").textContent = isPaused 
      ? `⏸️ ${modeObj.name.toUpperCase()} (PAUSED)`
      : `${modeObj.icon} ${modeObj.name.toUpperCase()} HUD`;
  }
  if ($("hudTurnInstruction") && isPaused) {
    $("hudTurnInstruction").textContent = "PAUSED";
  }
}

// 6. 导航倍速全端同步
function broadcastSimSpeed(speedVal) {
  if (speedVal === "instant") {
    if (!simState.active) {
      const startNavBtn = $("btnStartNavigation") || $("btnStartNav") || $("btnMobStartNav");
      if (startNavBtn) startNavBtn.click();
    }
    if (simState.paused) {
      resumeSimulation();
    }
    simSpeedFactor = 50;
    if (simState.totalDist > 0) {
      simState.distMeters = simState.totalDist;
    }
    if (typeof currentSimLoopFn === "function") {
      currentSimLoopFn(performance.now());
    }
  } else {
    simSpeedFactor = parseFloat(speedVal) || 1;
  }

  // 同步桌面端与手机端所有对应倍速按钮的高亮状态
  document.querySelectorAll("[data-speed]").forEach(btn => {
    if (btn.dataset.speed === String(speedVal)) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

// 同步手机端芯片推荐列表
function renderMobilePromptChips(city) {
  const container = $("mobPromptChips");
  if (!container) return;
  container.innerHTML = "";

  (city.chips || []).forEach(chip => {
    const btn = document.createElement("button");
    btn.className = "mob-chip";
    btn.textContent = chip.label;
    btn.onclick = () => {
      resumeAudioIfNeeded();
      if ($("mobSearchInput")) $("mobSearchInput").value = chip.prompt;
      sendQuery(chip.prompt);
    };
    container.appendChild(btn);
  });
}

// 手机端路线选择弹出卡片同步
function showMobileRoutePicker(dest, mode, etas) {
  const picker = $("mobRoutePickerSheet");
  if (!picker) return;
  picker.classList.remove("hidden");
  if ($("mobPickerTitle")) $("mobPickerTitle").textContent = "路线方案：" + dest;
  broadcastTravelMode(mode);
}

function updateMobileModePillsUI(mode) {
  broadcastTravelMode(mode);
}

// Gemini Live API 大模型配置与注册表 (支持 Gemini 3.8 Live、3.8 Live Extended Thinking 与 3.1 Flash Live)
const MODEL_38_LIVE = "models/gemini-3.8-live";
const MODEL_38_THINKING = "models/gemini-3.8-live-extended-thinking";
const MODEL_31_LIVE = "models/gemini-3.1-flash-live-preview";

const AVAILABLE_MODELS = [
  {
    id: MODEL_38_LIVE,
    name: "Gemini 3.8 Live (低延迟标准版)",
    shortName: "Gemini 3.8 Live",
    tag: "3.8 Live",
    supportsMapsTool: false,
    thinkingLevel: null
  },
  {
    id: MODEL_38_THINKING,
    name: "Gemini 3.8 Live Thinking (深度思考增强版)",
    shortName: "Gemini 3.8 Thinking",
    tag: "3.8 Thinking",
    supportsMapsTool: false,
    thinkingLevel: "LOW"
  },
  {
    id: MODEL_31_LIVE,
    name: "Gemini 3.1 Flash Live (经典版)",
    shortName: "Gemini 3.1 Live",
    tag: "3.1 Live",
    supportsMapsTool: true,
    thinkingLevel: null
  }
];

// 默认必须坚决优先采用全新的 Gemini 3.8 Live (低延迟标准版)
let activeModel = MODEL_38_LIVE;
try {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("mlActiveModel");
    // 若为空或为已过时的 3.1 经典版，直接升级重置为 3.8 Live；用户在当前会话明确切至 3.8 Thinking 则保留
    if (stored && stored !== MODEL_31_LIVE && AVAILABLE_MODELS.some(m => m.id === stored)) {
      activeModel = stored;
    } else {
      activeModel = MODEL_38_LIVE;
      localStorage.setItem("mlActiveModel", MODEL_38_LIVE);
    }
  }
} catch (e) {
  activeModel = MODEL_38_LIVE;
}

function getActiveModelObj(id) {
  const mid = id || activeModel;
  return AVAILABLE_MODELS.find(m => m.id === mid) || AVAILABLE_MODELS[0];
}

function syncModelSelectUI() {
  const cur = activeModel;
  const obj = getActiveModelObj(cur);

  // 1. 同步三端下拉选择框
  if ($("modelSelect") && $("modelSelect").value !== cur) $("modelSelect").value = cur;
  if ($("astModelSelect") && $("astModelSelect").value !== cur) $("astModelSelect").value = cur;
  if ($("mobModelSelect") && $("mobModelSelect").value !== cur) $("mobModelSelect").value = cur;

  // 2. 动态更新全界面各端大模型介绍与标题 (解决用户切模型后仍显示静态3.1的问题)
  if ($("astHeaderModelName")) $("astHeaderModelName").textContent = obj.shortName;
  if ($("astTelemetryHeader")) $("astTelemetryHeader").textContent = `⚡ ${obj.shortName} 动态按需调度遥测 (On-Demand Dispatch)：`;
  if ($("mobBrandBadge")) $("mobBrandBadge").textContent = obj.shortName;
  if ($("mobAssistantState") && !$("mobAssistantState").textContent.includes("正在实时收听")) {
    $("mobAssistantState").textContent = `${obj.shortName} 待命中 · 点击下方按钮说话`;
  }
  if ($("hudNavModelLabel")) {
    const navMode = $("hudNavModeLabel") ? $("hudNavModeLabel").outerHTML : "🚗 CAR HUD";
    $("hudNavModelLabel").innerHTML = `${obj.shortName.toUpperCase()} · ${navMode}`;
  }
  if ($("hudTranscript") && !$("hudTranscript").textContent.includes("正在收听") && !$("hudTranscript").textContent.includes("🎙️")) {
    $("hudTranscript").textContent = `${obj.shortName} 语音智能监听中…`;
  }
  if ($("hudHeaderModelLabel")) {
    $("hudHeaderModelLabel").textContent = `${obj.shortName.toUpperCase()} · AR VOICE ASSISTANT`;
  }

  // 3. 联动更新 duplex 全双工对讲组件状态文案
  if (typeof window !== "undefined" && window.DuplexVoice && typeof window.DuplexVoice.refreshLabels === "function") {
    try { window.DuplexVoice.refreshLabels(); } catch(e) {}
  }
}

function switchModel(newModelId) {
  if (!newModelId) return;
  activeModel = newModelId;
  try { localStorage.setItem("mlActiveModel", newModelId); } catch (e) {}
  syncModelSelectUI();
  const obj = getActiveModelObj(newModelId);
  console.log(`[Model] 切换大模型为: ${obj.name} (${newModelId})`);
  showVoiceToast(`已切换至大模型: ${obj.shortName}`);

  // 重置并重新建立 WebSocket 连接下发新模型的 setup 报文
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  connect();
}

let ws = null;
let ready = false;
let sceneLock = false;
let pending = null;

// 地图实例与折线/标记
let mainMap = null;
let mobileMap = null;
let glassesMap = null;

let routePolyline = null;
let mobPolyline = null;
let hudPolyline = null;

let originMarker = null;
let mobOriginMarker = null;
let hudOriginMarker = null;
let destMarker = null;
let mobDestMarker = null;
let hudDestMarker = null;

let carMarker = null;
let mobCarMarker = null;
let hudCarMarker = null;

// 导航与路线状态机
let activeDestination = "";
let resolvedDestTarget = null;
let selectedTravelMode = "DRIVING"; // "DRIVING", "BICYCLING", "WALKING"
let currentRouteData = null; // 当前选中的 DirectionsRoute
let hasHealed = false;
let lastRecommendedDestination = ""; // 最近一次模型推荐的具体实体地点 (供“导航过去/去那儿”多轮指代消解)

// 完整转录流式累加缓冲区 (彻底消灭流式 chunk 覆盖截断)
let currentModelTranscript = "";
let currentUserTranscript = "";

// 多路线备选方案状态机 (支持 provideRouteAlternatives)
let allAvailableRoutes = [];
let selectedRouteIndex = 0;
let altPolylines = [];
let mobAltPolylines = [];
let hudAltPolylines = [];
let currentSimLoopFn = null;

// 巡航速度与配置字典
const MODE_CONFIG = {
  DRIVING: {
    name: "开车",
    icon: "🚗",
    emoji: "🚗",
    modeClass: "driving",
    speedKmh: 48,
    color: "#1a73e8"
  },
  BICYCLING: {
    name: "骑行",
    icon: "🚲",
    emoji: "🚴",
    modeClass: "bicycling",
    speedKmh: 18,
    color: "#0f9d58"
  },
  WALKING: {
    name: "步行",
    icon: "🚶",
    emoji: "🚶",
    modeClass: "walking",
    speedKmh: 5,
    color: "#ea4335"
  }
};

// 城市元数据与动态提示词字典
const CITIES = {
  sg: {
    key: "sg",
    name: "新加坡 · 乌节地铁站 2号口 (ION Orchard)",
    shortName: "新加坡 · 乌节路",
    originLandmark: "乌节地铁站 2号口 (ION Orchard)",
    pickupLandmark: "乌节地铁站 2号口 (ION Orchard)",
    address: "2 Orchard Turn, Singapore 238801",
    coords: { lat: 1.30400, lng: 103.83190 },
    zoom: 15,
    region: "sg",
    promptContext: "新加坡乌节路核心商圈，具体出发地标为：乌节地铁站 (Orchard MRT NS22/TE14) 2号出口 (ION Orchard 正门，地址 2 Orchard Turn, Singapore 238801)，精确坐标 纬度1.30400、经度103.83190",
    fallbackMall: "ION Orchard",
    chips: [
      { label: "🌐 金沙水幕秀+路线", prompt: "搜索一下滨海湾金沙今晚水幕灯光秀几点开始，并规划路线带我去最佳观赏点。", search: true },
      { label: "🌳 滨海湾超级树", prompt: "我想去滨海湾花园看超级树擎天树丛，规划路线带我过去。", search: false },
      { label: "🦁 鱼尾狮公园地标", prompt: "帮我规划一条从乌节路前往滨海湾鱼尾狮公园的路线，并用一句话简短确认。", search: false },
      { label: "🍲 松发肉骨茶", prompt: "搜索乌节路附近评价最高的新加坡地道肉骨茶名店，规划路线带我过去。", search: true },
      { label: "🍗 天天海南鸡饭", prompt: "推荐麦士威熟食中心著名的天天海南鸡饭，规划路线带我过去。", search: false },
      { label: "🧋 武吉士蜜雪冰城", prompt: "推荐离乌节路最近的蜜雪冰城门店，规划路线带我过去。", search: true }
    ],
    assistantCapsules: [
      { icon: "🌐", name: "金沙水幕秀", tag: "Maps 接地", tagCls: "maps", prompt: "搜索一下滨海湾金沙今晚水幕灯光秀几点开始，并规划路线带我去最佳观赏点。" },
      { icon: "🌳", name: "滨海湾超级树", tag: "Maps 接地", tagCls: "maps", prompt: "我想去滨海湾花园看超级树擎天树丛，规划路线带我过去。" },
      { icon: "🦁", name: "鱼尾狮公园", tag: "Maps 接地", tagCls: "maps", prompt: "帮我规划一条从乌节路前往滨海湾鱼尾狮公园的路线，并用一句话简短确认。" },
      { icon: "🌦️", name: "新加坡实时天气", tag: "Search 接地", tagCls: "search", prompt: "今天新加坡天气怎么样？气温多高？适合在滨海湾户外游玩吗？" },
      { icon: "🌍", name: "口语实时翻译", tag: "原生推理", tagCls: "native", prompt: "帮我把'请问附近最近的地铁站在哪里？走路需要多久？'翻译成地道的马来语和英语" },
      { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: "带我去滨海湾花园，规划路线并开始导航" }
    ]
  },
  sf: {
    key: "sf",
    name: "旧金山 · 联合广场 Powell St 地铁站 (Westin)",
    shortName: "旧金山 · 联合广场",
    originLandmark: "联合广场 Powell St 地铁站 Exit B (Westin)",
    pickupLandmark: "联合广场 Powell St 地铁站 Exit B (Westin)",
    address: "335 Powell St, San Francisco, CA 94102",
    coords: { lat: 37.78760, lng: -122.40820 },
    zoom: 15,
    region: "us",
    promptContext: "美国旧金山联合广场，具体出发地标为：Powell St 地铁站 Exit B (The Westin St. Francis 酒店正门，地址 335 Powell St)，精确坐标 纬度37.78760、经度-122.40820",
    fallbackMall: "Westfield San Francisco Centre",
    chips: [
      { label: "🌉 金门大桥最佳视角", prompt: "帮我规划一条从联合广场去金门大桥最佳拍照打卡点的路线。", search: false },
      { label: "🦀 渔人码头酸面包汤", prompt: "搜索渔人码头最出名的海鲜餐厅，推荐一家酸面包蛤蜊浓汤并规划路线带我过去。", search: true },
      { label: "🌁 九曲花街打卡", prompt: "帮我规划去旧金山著名景点九曲花街 Lombard Street 的路线。", search: false },
      { label: "🏰 艺术宫建筑遗迹", prompt: "推荐旧金山艺术宫 Palace of Fine Arts 的游览路线，并规划路线带我过去。", search: false },
      { label: "☕ 渡轮大厦蓝瓶咖啡", prompt: "帮我规划一条从联合广场前往旧金山渡轮大厦 Ferry Building 蓝瓶咖啡的路线。", search: false },
      { label: "🚋 叮当车博物馆", prompt: "附近有没有旧金山特色的电缆车 Cable Car 博物馆？规划路线带我过去。", search: false }
    ],
    assistantCapsules: [
      { icon: "🌉", name: "金门大桥视角", tag: "Maps 接地", tagCls: "maps", prompt: "帮我规划一条从联合广场去金门大桥最佳拍照打卡点的路线。" },
      { icon: "🦀", name: "渔人码头海鲜", tag: "Maps 接地", tagCls: "maps", prompt: "搜索渔人码头最出名的海鲜餐厅，推荐一家酸面包蛤蜊浓汤并规划路线带我过去。" },
      { icon: "🏰", name: "艺术宫打卡", tag: "Maps 接地", tagCls: "maps", prompt: "推荐旧金山艺术宫 Palace of Fine Arts 的游览路线，并规划路线带我过去。" },
      { icon: "🌦️", name: "旧金山实时天气", tag: "Search 接地", tagCls: "search", prompt: "今天旧金山天气怎么样？气温多高？联合广场和金门大桥风大吗？" },
      { icon: "🌍", name: "口语实时翻译", tag: "原生推理", tagCls: "native", prompt: "帮我把'请问最近去金门大桥的观光巴士在哪里上车？'翻译成地道的美式英语" },
      { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: "带我去金门大桥最佳观景台，规划路线并开始导航" }
    ]
  },
  tyo: {
    key: "tyo",
    name: "东京 · 涉谷站 八公口 (Shibuya Hachiko)",
    shortName: "东京 · 涉谷",
    originLandmark: "涉谷站 八公口 (忠犬八公像)",
    pickupLandmark: "涉谷站 八公口 (忠犬八公像)",
    address: "1 Chome-2 Dogenzaka, Shibuya City, Tokyo 150-0043",
    coords: { lat: 35.65910, lng: 139.70060 },
    zoom: 15,
    region: "jp",
    promptContext: "日本东京涉谷核心区，具体出发地标为：涉谷站八公口 (Shibuya Station Hachiko Exit · 忠犬八公像旁十字路口)，精确坐标 纬度35.65910、经度139.70060",
    fallbackMall: "Shibuya Scramble Square",
    chips: [
      { label: "🗼 东京铁塔夜景", prompt: "搜索东京铁塔观景台今天的开放时间与门票，并规划路线带我过去。", search: true },
      { label: "⛩️ 浅草寺雷门打卡", prompt: "帮我规划一条从涉谷前往台东区浅草寺雷门的路线，并推荐周边亮点。", search: false },
      { label: "🌳 新宿御苑漫步", prompt: "推荐去新宿御苑散步的最佳出入口，并规划一条从涉谷出发的路线。", search: false },
      { label: "🍣 筑地海鲜与寿司", prompt: "搜索筑地场外市场营业状态，推荐一家高分海鲜丼名店并规划路线带我过去。", search: true },
      { label: "🏯 皇居千鸟之渊", prompt: "规划一条从涉谷前往皇居千鸟之渊的路线，并用一句话简短确认。", search: false },
      { label: "🛍️ 银座中央通逛街", prompt: "帮我规划去银座中央通 GINZA SIX 的路线，并介绍那里的特色。", search: false }
    ],
    assistantCapsules: [
      { icon: "🗼", name: "东京铁塔夜景", tag: "Maps 接地", tagCls: "maps", prompt: "搜索东京铁塔观景台今天的开放时间与门票，并规划路线带我过去。" },
      { icon: "🍣", name: "筑地海鲜市场", tag: "Maps 接地", tagCls: "maps", prompt: "搜索筑地场外市场营业状态，推荐一家高分海鲜丼名店并规划路线带我过去。" },
      { icon: "⛩️", name: "浅草寺雷门", tag: "Maps 接地", tagCls: "maps", prompt: "帮我规划一条从涉谷前往台东区浅草寺雷门的路线，并推荐周边亮点。" },
      { icon: "🌦️", name: "东京实时天气", tag: "Search 接地", tagCls: "search", prompt: "今天东京天气怎么样？气温多高？适合在新宿御苑或代代木公园户外散步吗？" },
      { icon: "🌍", name: "口语实时翻译", tag: "原生推理", tagCls: "native", prompt: "帮我把'请问最近去浅草寺的地铁在哪里换乘？'翻译成地道的日语发音和假名" },
      { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: "带我去东京铁塔，规划路线并开始导航" }
    ]
  },
  par: {
    key: "par",
    name: "巴黎 · 埃菲尔铁塔 战神广场 (Champ de Mars)",
    shortName: "巴黎 · 埃菲尔铁塔",
    originLandmark: "埃菲尔铁塔 战神广场",
    pickupLandmark: "埃菲尔铁塔 战神广场",
    address: "2 Allée Adrienne Lecouvreur, 75007 Paris, France",
    coords: { lat: 48.85840, lng: 2.29450 },
    zoom: 15,
    region: "fr",
    promptContext: "法国巴黎埃菲尔铁塔，具体出发地标为：战神广场北门，精确坐标 纬度48.85840、经度2.29450",
    fallbackMall: "Beaugrenelle Paris",
    chips: [
      { label: "🏛️ 卢浮宫金字塔", prompt: "帮我规划一条从战神广场沿着塞纳河到卢浮宫玻璃金字塔主入口的路线。", search: false },
      { label: "☕ 左岸花神咖啡馆", prompt: "帮我找巴黎左岸圣日耳曼大道最富盛名的花神咖啡馆，规划路线带我过去。", search: false },
      { label: "⛪ 西岱岛巴黎圣母院", prompt: "规划一条前往西岱岛巴黎圣母院的路线，并介绍周边的漫步看点。", search: false },
      { label: "🏛️ 凯旋门与香街", prompt: "帮我规划一条从战神广场前往巴黎凯旋门与香榭丽舍大道的路线。", search: false },
      { label: "🎨 蒙马特圣心大教堂", prompt: "搜索蒙马特高地圣心大教堂今天的开放时间，并规划一条前往山顶缆车站的路线。", search: true },
      { label: "🥐 玛黑区特色烘焙", prompt: "推荐玛黑区评价极高的传统法式手工烘焙名店，规划路线带我过去品尝可颂。", search: true }
    ],
    assistantCapsules: [
      { icon: "🏛️", name: "卢浮宫金字塔", tag: "Maps 接地", tagCls: "maps", prompt: "帮我规划一条从战神广场沿着塞纳河到卢浮宫玻璃金字塔主入口的路线。" },
      { icon: "☕", name: "左岸花神咖啡", tag: "Maps 接地", tagCls: "maps", prompt: "帮我找巴黎左岸圣日耳曼大道最富盛名的花神咖啡馆，规划路线带我过去。" },
      { icon: "⛪", name: "巴黎圣母院", tag: "Maps 接地", tagCls: "maps", prompt: "规划一条前往西岱岛巴黎圣母院的路线，并介绍周边的漫步看点。" },
      { icon: "🌦️", name: "巴黎实时天气", tag: "Search 接地", tagCls: "search", prompt: "今天巴黎天气怎么样？气温多高？适合在塞纳河畔漫步吗？" },
      { icon: "🌍", name: "口语实时翻译", tag: "原生推理", tagCls: "native", prompt: "帮我把'请问去卢浮宫方向的塞纳河观光游船在哪里登船？'翻译成地道优雅的法语" },
      { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: "带我去卢浮宫玻璃金字塔入口，规划路线并开始导航" }
    ]
  },
  gps: {
    key: "gps",
    name: "当前位置 (真实 GPS 定位)",
    shortName: "本地周边",
    originLandmark: "当前定位",
    pickupLandmark: "当前定位",
    address: "用户实时网络定位基准",
    coords: { lat: 1.30400, lng: 103.83190 }, // 默认 fallback 为新加坡乌节路
    zoom: 15,
    region: "sg",
    promptContext: "用户当前所在本地周边(经度约103.83, 纬度约1.30附近)",
    fallbackMall: "VivoCity",
    chips: [
      { label: "☕ 周边高分咖啡馆", prompt: "帮我找当前位置周边 5 公里内评价最高的精品咖啡馆，并规划路线带我过去。", search: false },
      { label: "🍽️ 本地特色人气美食", prompt: "搜索当前位置周边最受本地人欢迎的特色餐厅，推荐一家并规划路线带我过去。", search: true },
      { label: "🏞️ 附近热门打卡景点", prompt: "推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。", search: false },
      { label: "🛍️ 最近大型商场", prompt: "搜索我当前位置周边 10 公里内最近的大型商场或购物中心营业状态，并规划路线带我过去。", search: true }
    ],
    assistantCapsules: [
      { icon: "☕", name: "周边高分咖啡", tag: "Maps 接地", tagCls: "maps", prompt: "帮我找当前位置周边 5 公里内评价最高的精品咖啡馆，并规划路线带我过去。" },
      { icon: "🍽️", name: "本地特色美食", tag: "Maps 接地", tagCls: "maps", prompt: "推荐当前位置周边最受本地人欢迎的特色餐厅与招牌菜，并规划路线带我过去。" },
      { icon: "🌦️", name: "本地实时天气", tag: "Search 接地", tagCls: "search", prompt: "搜索我当前定位地区今天的天气状况、气温与空气质量。" },
      { icon: "🌍", name: "口语实时翻译", tag: "原生推理", tagCls: "native", prompt: "帮我把'请问附近最近的地铁站在哪里？走路需要多久？'翻译成地道的当地语言和英语" },
      { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: "推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。" }
    ]
  }
};

let currentCity = CITIES.sg;

// 动态巡航引擎
let simSpeedFactor = 1;
let simState = {
  active: false,
  paused: false,
  coords: [],
  steps: [],
  stepOffsets: [],
  speedKmh: 48,
  distMeters: 0,
  totalDist: 0,
  lastTime: 0,
  animId: null
};

// 转向动作图标匹配系统
function getManeuverIcon(step) {
  if (!step) return "⬆️";
  const m = (step.maneuver || "").toLowerCase();
  const text = (step.instructions || "").toLowerCase();

  if (m.includes("u-turn") || m.includes("uturn") || text.includes("调头") || text.includes("u-turn")) return "↩️";
  if (m.includes("sharp-left") || text.includes("急左转")) return "⮦";
  if (m.includes("sharp-right") || text.includes("急右转")) return "⮧";
  if (m.includes("slight-left") || text.includes("稍微向左") || text.includes("靠左") || text.includes("slight left")) return "↖️";
  if (m.includes("slight-right") || text.includes("稍微向右") || text.includes("靠右") || text.includes("slight right")) return "↗️";
  if (m.includes("left") || text.includes("左转") || text.includes("向左") || text.includes("turn left")) return "⬅️";
  if (m.includes("right") || text.includes("右转") || text.includes("向右") || text.includes("turn right")) return "➡️";
  if (m.includes("roundabout") || text.includes("环岛") || text.includes("rotary")) return "🔄";
  if (m.includes("ramp") || text.includes("匝道") || text.includes("ramp")) return "↗️";
  if (m.includes("fork") || text.includes("叉路")) return "🔀";
  return "⬆️";
}

const FC = {
  functionDeclarations: [{
    name: "start_navigation",
    description: "当用户有前往某地、路线规划、查找具体地点后希望规划路线时调用本函数",
    parameters: {
      type: "OBJECT",
      properties: {
        destination: {
          type: "STRING",
          description: "导航目的地真实完整名称(必须是用户当前坐标所在城市/周边的真实地点,绝对严禁跨国/跨大洋推荐异地场所)"
        },
        travel_mode: {
          type: "STRING",
          enum: ["DRIVING", "BICYCLING", "WALKING"],
          description: "用户偏好的出行方式(若用户明确提到了步行/走路请传 WALKING,若提到骑行/自行车请传 BICYCLING,若提到开车请传 DRIVING)"
        }
      },
      required: ["destination"]
    }
  }]
};

function $(id) { return document.getElementById(id); }

// ---------------- Google Maps 初始化 ----------------
window.initGoogleMaps = function() {
  const center = {lat: currentCity.coords.lat, lng: currentCity.coords.lng};

  mainMap = new google.maps.Map($("map"), {
    center: center,
    zoom: currentCity.zoom,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM }
  });

  originMarker = new google.maps.Marker({
    position: center,
    map: mainMap,
    title: currentCity.name,
    icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
  });

  renderPromptChips(currentCity);
  renderMobilePromptChips(currentCity);
  renderAssistantDemoCapsules(currentCity);
};

function initMobileMapIfNeeded() {
  const div = $("mapMobile");
  if (!div || mobileMap) return;
  const center = currentCity.coords || {lat: 1.3048, lng: 103.8318};
  mobileMap = new google.maps.Map(div, {
    center: center,
    zoom: 15,
    disableDefaultUI: true,
    mapTypeControl: false,
    streetViewControl: false
  });
}

function initGlassesMapIfNeeded() {
  const div = $("mapGlasses");
  if (!div || glassesMap) return;
  const center = currentCity.coords || {lat: 1.3048, lng: 103.8318};
  glassesMap = new google.maps.Map(div, {
    center: center,
    zoom: 16,
    disableDefaultUI: true,
    mapTypeControl: false,
    streetViewControl: false
  });
}

// ---------------- 城市切换与动态芯片 ----------------
function renderPromptChips(city) {
  const container = $("promptChips");
  if (!container) return;
  container.innerHTML = "";

  (city.chips || []).forEach((chip) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (chip.search ? " search" : "");
    btn.textContent = chip.label;
    btn.title = chip.prompt;
    btn.onclick = () => {
      resumeAudioIfNeeded();
      // v90: 不再在这里把 sceneLock 置回 false——sendQuery 内的 bargeIn 需要靠它判断“上一轮是否仍在进行”来布置迟到帧门
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("playing"));
      btn.classList.add("playing");
      $("text").value = chip.prompt;

      sendQuery(chip.prompt);
    };
    container.appendChild(btn);
  });
}

function renderAssistantDemoCapsules(city) {
  const container = $("astDemoCapsules");
  if (!container) return;
  const list = (city && city.assistantCapsules) || (CITIES.sg && CITIES.sg.assistantCapsules) || [];
  container.innerHTML = "";
  list.forEach(item => {
    const btn = document.createElement("button");
    btn.className = "ast-capsule" + (item.primary ? " primary" : "");
    btn.setAttribute("data-prompt", item.prompt);

    const iconSpan = document.createElement("span");
    iconSpan.className = "cap-icon";
    iconSpan.textContent = item.icon || "✨";

    const nameSpan = document.createElement("span");
    nameSpan.className = "cap-name";
    nameSpan.textContent = item.name || "快捷场景";

    const tagSpan = document.createElement("span");
    tagSpan.className = "cap-tag " + (item.tagCls || "native");
    tagSpan.textContent = item.tag || "智能推荐";

    btn.appendChild(iconSpan);
    btn.appendChild(nameSpan);
    btn.appendChild(tagSpan);

    btn.onclick = () => {
      resumeAudioIfNeeded();
      const prompt = item.prompt;
      if (prompt) {
        if ($("astInputText")) $("astInputText").value = prompt;
        sendQuery(prompt);
      }
    };
    container.appendChild(btn);
  });
}

function handleCityChange(cityKey) {
  console.log("[CityChange] Selected:", cityKey);
  if (!CITIES[cityKey]) return;

  if (cityKey === "gps") {
    showVoiceToast("🛰️ 正在探测您的真实位置 (GPS / 网络定位)…", 4500);

    const applyRealLocation = (lat, lng, cityName, sourceDesc, countryCode = "") => {
      console.log(`[RealLocation] 真实位置已生效: lat=${lat}, lng=${lng}, city=${cityName}, country=${countryCode}, source=${sourceDesc}`);
      const cleanCity = (cityName || "本地周边").trim();
      let shortName = "本地";
      if (/^[a-zA-Z\s\-]+$/.test(cleanCity)) {
        shortName = cleanCity.split(/[\s,]+/)[0];
      } else {
        shortName = cleanCity.replace(/市|区|特别行政区|省/g, "").slice(0, 6) || "本地";
      }

      // 必须为合法的 2 位 CLDR 代码，严禁出现 "auto"
      let safeRegion = "sg";
      if (countryCode && countryCode.length === 2 && countryCode !== "auto") {
        safeRegion = countryCode.toLowerCase();
      }

      currentCity = {
        key: "gps",
        name: `当前位置 (${cleanCity} · ${sourceDesc})`,
        shortName: shortName,
        coords: { lat, lng },
        zoom: 15,
        region: safeRegion,
        promptContext: `用户当前真实所在位置: ${cleanCity}, 坐标约为 纬度 ${lat.toFixed(4)}, 经度 ${lng.toFixed(4)}`,
        fallbackMall: `${cleanCity}中心商场`,
        chips: [
          { label: `☕ ${shortName}高分咖啡`, prompt: `帮我找${cleanCity}当前位置周边评价最高的精品咖啡馆，并规划路线带我过去。`, search: false },
          { label: `🍽️ ${shortName}特色美食`, prompt: `推荐${cleanCity}当前位置周边最受本地人欢迎的特色餐厅与招牌菜，并规划路线带我过去。`, search: true },
          { label: `🏞️ 附近热门打卡景点`, prompt: `推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。`, search: false },
          { label: `🛍️ 最近大型商场`, prompt: `搜索我当前位置周边最近的大型商场或购物中心营业状态，并规划路线带我过去。` }
        ],
        assistantCapsules: [
          { icon: "☕", name: `${shortName}高分咖啡`, tag: "Maps 接地", tagCls: "maps", prompt: `帮我找${cleanCity}当前位置周边评价最高的精品咖啡馆，并规划路线带我过去。` },
          { icon: "🍽️", name: `${shortName}特色美食`, tag: "Maps 接地", tagCls: "maps", prompt: `推荐${cleanCity}当前位置周边最受本地人欢迎的特色餐厅与招牌菜，并规划路线带我过去。` },
          { icon: "🗺️", name: "一键规划导航", tag: "Function Call", tagCls: "fc", primary: true, prompt: `推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。` }
        ]
      };

      showVoiceToast(`📍 已成功定位至真实所在地: ${cleanCity} (${sourceDesc})`, 4000);
      applyCityToMap();
    };

    const reverseGeocodeAndApply = (lat, lng, fallbackName, sourceDesc) => {
      if (window.google && window.google.maps && window.google.maps.Geocoder) {
        try {
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({ location: { lat, lng } }, (results, status) => {
            if (status === "OK" && results && results[0]) {
              let detectedCity = "";
              let detectedCountryCode = "";
              for (const comp of results[0].address_components) {
                if (comp.types.includes("locality") || comp.types.includes("administrative_area_level_2")) {
                  detectedCity = comp.long_name;
                }
                if (comp.types.includes("country")) {
                  detectedCountryCode = comp.short_name;
                }
              }
              const finalName = detectedCity || fallbackName || "本地周边";
              applyRealLocation(lat, lng, finalName, sourceDesc, detectedCountryCode);
            } else {
              applyRealLocation(lat, lng, fallbackName, sourceDesc);
            }
          });
          return;
        } catch (e) {}
      }
      applyRealLocation(lat, lng, fallbackName, sourceDesc);
    };

    const fallbackToIp = async () => {
      try {
        const resp = await fetch("/geo");
        if (resp.ok) {
          const data = await resp.json();
          if (data.is_real_ip && data.lat && data.lng) {
            console.log("[Geo] 成功通过服务端 IP 获取真实坐标:", data);
            reverseGeocodeAndApply(data.lat, data.lng, data.city, "网络IP定位");
            return;
          }
        }
      } catch (e) {
        console.warn("[Geo] 服务端 IP 定位出错:", e);
      }

      // 第三方 IP 定位备选
      try {
        const extResp = await fetch("https://ipapi.co/json/");
        if (extResp.ok) {
          const extData = await extResp.json();
          if (extData.latitude && extData.longitude) {
            console.log("[Geo] 成功通过外部 IP 获取真实坐标:", extData);
            reverseGeocodeAndApply(extData.latitude, extData.longitude, extData.city || extData.region, "网络IP定位");
            return;
          }
        }
      } catch (e) {}

      // 如果确实全部受阻，提示用户定位未授权并保持演示中心
      showVoiceToast("⚠️ 真实定位未授权，已切换至演示中心", 3500);
      applyRealLocation(1.3048, 103.8318, "新加坡 · 乌节路", "演示备用");
    };

    // 优先尝试真实 GPS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          console.log("[Geo] 浏览器硬件 GPS 定位成功:", lat, lng);
          reverseGeocodeAndApply(lat, lng, "真实GPS位置", "GPS卫星定位");
        },
        (err) => {
          console.warn("[Geo] 浏览器 GPS 未授权或超时，立即自动启用网络 IP 真实定位:", err);
          fallbackToIp();
        },
        { timeout: 5000, enableHighAccuracy: true }
      );
    } else {
      fallbackToIp();
    }
    return;
  }

  currentCity = CITIES[cityKey];
  applyCityToMap();
}

function applyCityToMap() {
  const coords = currentCity.coords;
  const zoom = currentCity.zoom || 15;
  if (!coords) return;

  // 1. 全景主地图同步
  if (mainMap) {
    mainMap.panTo(coords);
    mainMap.setZoom(zoom);
    if (originMarker) {
      originMarker.setPosition(coords);
      originMarker.setTitle(currentCity.name);
    }
  }

  // 2. 手机端地图同步 (保证手机端地图随下拉菜单切换真实移动)
  initMobileMapIfNeeded();
  if (mobileMap) {
    mobileMap.setCenter(coords);
    mobileMap.panTo(coords);
    mobileMap.setZoom(zoom);
    google.maps.event.trigger(mobileMap, "resize");
    if (!mobOriginMarker) {
      mobOriginMarker = new google.maps.Marker({
        position: coords,
        map: mobileMap,
        title: currentCity.name,
        icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
      });
    } else {
      mobOriginMarker.setPosition(coords);
      mobOriginMarker.setTitle(currentCity.name);
    }
  }

  // 3. AR 眼镜端画中画地图同步 (保证眼镜端地图随位置切换真实移动)
  initGlassesMapIfNeeded();
  if (glassesMap) {
    glassesMap.setCenter(coords);
    glassesMap.panTo(coords);
    glassesMap.setZoom(zoom + 1);
    google.maps.event.trigger(glassesMap, "resize");
    if (!hudOriginMarker) {
      hudOriginMarker = new google.maps.Marker({
        position: coords,
        map: glassesMap,
        title: currentCity.name,
        icon: "https://maps.google.com/mapfiles/ms/icons/green-dot.png"
      });
    } else {
      hudOriginMarker.setPosition(coords);
      hudOriginMarker.setTitle(currentCity.name);
    }
  }

  // 4. 同步各端城市下拉与按钮高亮状态
  if ($("citySelect") && $("citySelect").value !== currentCity.key) {
    $("citySelect").value = currentCity.key;
  }
  if ($("mobCitySelect") && $("mobCitySelect").value !== currentCity.key) {
    $("mobCitySelect").value = currentCity.key;
  }
  document.querySelectorAll(".g-city-pill").forEach(b => {
    if (b.getAttribute("data-city") === currentCity.key) b.classList.add("active");
    else b.classList.remove("active");
  });

  // 5. 更新各端搜索框占位符与眼镜 HUD 标签提示
  if ($("text")) {
    $("text").placeholder = `问 Gemini：${currentCity.shortName || "附近"}出行、查路线、找美食、日常闲聊…`;
  }
  if ($("mobSearchInput")) {
    $("mobSearchInput").placeholder = `搜索${currentCity.shortName || "附近"}地点、查路线、问天气…`;
  }
  if ($("astInputText")) {
    $("astInputText").placeholder = `问问${currentCity.shortName || "本地"}生活、实时路况、查路线或日常闲聊…`;
  }
  if ($("arTargetTitle")) {
    $("arTargetTitle").textContent = `[+] 当前位置: ${currentCity.shortName || "本地"}`;
  }

  exitNavigation();
  lastRecommendedDestination = "";
  if ($("text")) $("text").value = "";
  if ($("mobSearchInput")) $("mobSearchInput").value = "";
  if ($("astInputText")) $("astInputText").value = "";
  renderPromptChips(currentCity);
  renderMobilePromptChips(currentCity);
  renderAssistantDemoCapsules(currentCity);
  reconnectFresh();
}

// 权威地标消歧义词典 (精准锚定核心景点与打卡实体，彻底消灭 Places API 异地/机场同名漂移)
const CANONICAL_LANDMARKS = [
  {
    // 滨海湾金沙活动广场 (水幕灯光秀最佳观赏点)
    pattern: /(?:Marina Bay Sands.*(?:Event Plaza|Spectra|活动广场|水幕|灯光秀)|(?:滨海湾金沙|金沙).*(?:Event Plaza|活动广场|水幕|灯光秀)|Spectra)/i,
    name: "滨海湾金沙活动广场 (Event Plaza · 水幕灯光秀最佳观赏点)",
    target: { lat: 1.2844216, lng: 103.8582926 },
    address: "10 Bayfront Ave, Event Plaza Marina Bay Sands, Singapore 018972"
  },
  {
    // 滨海湾金沙酒店主体
    pattern: /(?:Marina Bay Sands|滨海湾金沙|金沙酒店)/i,
    name: "滨海湾金沙酒店 (Marina Bay Sands)",
    target: { lat: 1.2837575, lng: 103.8591065 },
    address: "10 Bayfront Ave, Singapore 018956"
  },
  {
    // 松发肉骨茶 (克拉码头总店)
    pattern: /(?:松发肉骨茶|Song Fa Bak Kut Teh|松发)/i,
    name: "松发肉骨茶 (克拉码头总店)",
    target: { lat: 1.2891, lng: 103.8477 },
    address: "11 New Bridge Rd, #01-01, Singapore 059383"
  },
  {
    // 乌节路 ION Orchard
    pattern: /(?:ION Orchard|爱雍·乌节|ION\s*商场)/i,
    name: "ION Orchard (乌节路)",
    target: { lat: 1.3040, lng: 103.8318 },
    address: "2 Orchard Turn, Singapore 238801"
  },
  {
    // 乌节路高岛屋 (Takashimaya / 义安城 Ngee Ann City)
    pattern: /(?:高岛屋|Takashimaya|义安城|Ngee Ann City)/i,
    name: "乌节路高岛屋 (Takashimaya · 义安城 Ngee Ann City)",
    target: { lat: 1.3023, lng: 103.8347 },
    address: "391 Orchard Rd, Singapore 238873"
  },
  {
    // 滨海湾花园超级树
    pattern: /(?:Gardens by the Bay|SuperTree|超级树|滨海湾花园)/i,
    name: "滨海湾花园 (Gardens by the Bay · Supertree Grove)",
    target: { lat: 1.2816, lng: 103.8636 },
    address: "18 Marina Gardens Dr, Singapore 018953"
  },
  {
    // 鱼尾狮公园 (Merlion Park)
    pattern: /(?:鱼尾狮|Merlion)/i,
    name: "鱼尾狮公园 (Merlion Park)",
    target: { lat: 1.2868, lng: 103.8545 },
    address: "1 Fullerton Rd, Singapore 049213"
  },
  {
    // 珍宝海鲜 (克拉码头店 / ION Orchard 店)
    pattern: /(?:珍宝海鲜|Jumbo Seafood)/i,
    name: "珍宝海鲜 (ION Orchard 乌节路店)",
    target: { lat: 1.3040, lng: 103.8318 },
    address: "2 Orchard Turn, #04-09/10 ION Orchard, Singapore 238801"
  },
  {
    // 御宝至尊烤鸭店 (百丽宫 Paragon)
    pattern: /(?:御宝至尊烤鸭店|御宝至尊烤鸭|Imperial Treasure Super Peking Duck)/i,
    name: "御宝至尊烤鸭店 (Imperial Treasure Super Peking Duck · 百丽宫)",
    target: { lat: 1.3039, lng: 103.8358 },
    address: "290 Orchard Rd, #05-42/45 Paragon, Singapore 238859"
  },
  {
    // 同乐经典 (义安城 Ngee Ann City)
    pattern: /(?:同乐经典|TungLok Signatures)/i,
    name: "同乐经典 (TungLok Signatures · 义安城)",
    target: { lat: 1.3023, lng: 103.8347 },
    address: "391 Orchard Rd, #04-05/06/07 Ngee Ann City, Singapore 238872"
  },
  {
    // 御宝轩 / 御宝阁 (ION Orchard)
    pattern: /(?:御宝轩|御宝阁|Imperial Treasure)/i,
    name: "御宝轩 (Imperial Treasure · ION Orchard)",
    target: { lat: 1.3040, lng: 103.8318 },
    address: "2 Orchard Turn, #03-05 ION Orchard, Singapore 238801"
  },
  {
    // 乐天味之楼 / 味之楼 (ION Orchard)
    pattern: /(?:乐天味之楼|味之楼|Taste Paradise)/i,
    name: "乐天味之楼 (Taste Paradise · ION Orchard)",
    target: { lat: 1.3040, lng: 103.8318 },
    address: "2 Orchard Turn, #04-07 ION Orchard, Singapore 238801"
  },
  {
    // 翡翠金阁 / 翡翠皇宫 (百丽宫 Paragon)
    pattern: /(?:翡翠金阁|翡翠皇宫|翡翠小厨|Crystal Jade)/i,
    name: "翡翠金阁 (Crystal Jade Golden Palace · 百丽宫)",
    target: { lat: 1.3039, lng: 103.8358 },
    address: "290 Orchard Rd, #05-22 Paragon, Singapore 238859"
  },
  {
    // 华厅餐厅 (乌节大酒店 Orchard Hotel)
    pattern: /(?:华厅餐厅|华厅|Hua Ting)/i,
    name: "华厅餐厅 (Hua Ting Restaurant · 乌节大酒店)",
    target: { lat: 1.3075, lng: 103.8286 },
    address: "442 Orchard Rd, Level 2 Orchard Hotel, Singapore 238879"
  },
  {
    // 夏宫 (康莱德酒店 Conrad Singapore Orchard)
    pattern: /(?:夏宫|Summer Palace)/i,
    name: "夏宫 (Summer Palace · 乌节康莱德酒店)",
    target: { lat: 1.3042, lng: 103.8247 },
    address: "1 Cuscaden Rd, Level 3, Singapore 249715"
  },
  {
    // 巴沙咖啡 (Bacha Coffee ION Orchard)
    pattern: /(?:巴沙咖啡|Bacha Coffee)/i,
    name: "巴沙咖啡 (Bacha Coffee · ION Orchard)",
    target: { lat: 1.3040, lng: 103.8318 },
    address: "2 Orchard Turn, #01-15/16 ION Orchard, Singapore 238801"
  },
  {
    // 亚坤咖椰吐司 (远东广场总店)
    pattern: /(?:亚坤|Ya Kun)/i,
    name: "亚坤咖椰吐司 (远东广场总店 Ya Kun Kaya Toast)",
    target: { lat: 1.2828, lng: 103.8485 },
    address: "18 China St, #01-01 Far East Square, Singapore 049560"
  },
  {
    // 阿泰海南鸡饭 (麦士威熟食中心)
    pattern: /(?:阿泰海南鸡饭|阿泰鸡饭|Ah Tai Hainanese Chicken Rice|Ah Tai)/i,
    name: "阿泰海南鸡饭 (麦士威熟食中心 Maxwell Food Centre)",
    target: { lat: 1.2804283, lng: 103.8447683 },
    address: "1 Kadayanallur St, #01-07 Maxwell Food Centre, Singapore 069184"
  },
  {
    // 天天海南鸡饭 (麦士威熟食中心)
    pattern: /(?:天天海南鸡饭|天天鸡饭|Tian Tian Hainanese Chicken Rice|Tian Tian)/i,
    name: "天天海南鸡饭 (麦士威熟食中心 Maxwell Food Centre)",
    target: { lat: 1.2804528, lng: 103.8447987 },
    address: "1 Kadayanallur St, #01-10/11 Maxwell Food Centre, Singapore 069184"
  },
  {
    // 麦士威熟食中心
    pattern: /(?:Maxwell Food Centre|麦士威熟食中心|麦士威熟食)/i,
    name: "麦士威熟食中心 (Maxwell Food Centre)",
    target: { lat: 1.2803, lng: 103.8447 },
    address: "1 Kadayanallur St, Singapore 069184"
  },
  {
    // 蜜雪冰城 (城联广场店 CityLink Mall - 距乌节路约3.0km)
    pattern: /(?:MIXUE.*(?:CityLink|City Link|城联|市政厅|City Hall)|(?:CityLink|城联).*MIXUE|蜜雪冰城.*(?:CityLink|城联))/i,
    name: "蜜雪冰城 (CityLink Mall 城联广场店)",
    target: { lat: 1.2928, lng: 103.8542 },
    address: "One Raffles Link, #B1-42A CityLink Mall, Singapore 039393"
  },
  {
    // 蜜雪冰城 (武吉士店 Bugis - 距乌节路约3.2km)
    pattern: /(?:MIXUE.*(?:Bugis|武吉士)|(?:Bugis|武吉士).*MIXUE|蜜雪冰城.*(?:Bugis|武吉士))/i,
    name: "蜜雪冰城 (MIXUE 武吉士店 Bugis Village)",
    target: { lat: 1.3005, lng: 103.8548 },
    address: "241 Victoria St, Bugis Village, Singapore 188030"
  },
  {
    // 蜜雪冰城 (牛车水珍珠坊店 Chinatown - 距乌节路约3.8km)
    pattern: /(?:MIXUE.*(?:Chinatown|牛车水|珍珠坊)|(?:Chinatown|牛车水|珍珠坊).*MIXUE|蜜雪冰城.*(?:Chinatown|牛车水|珍珠坊))/i,
    name: "蜜雪冰城 (牛车水珍珠坊店 People's Park Complex)",
    target: { lat: 1.2848, lng: 103.8427 },
    address: "1 Park Rd, #01-K99B People's Park Complex, Singapore 059108"
  },
  {
    // 蜜雪冰城 (通用就近默认：首选离乌节路最近的 Bugis/CityLink)
    pattern: /(?:蜜雪冰城|MIXUE)/i,
    name: "蜜雪冰城 (MIXUE 武吉士店 Bugis Village)",
    target: { lat: 1.3005, lng: 103.8548 },
    address: "241 Victoria St, Bugis Village, Singapore 188030"
  }
];

// ---------------- WebSocket 双向透传 ----------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");

  ws.onopen = () => {
    const lat = currentCity.coords.lat.toFixed(5);
    const lng = currentCity.coords.lng.toFixed(5);
    const landmark = currentCity.pickupLandmark || currentCity.name;
    const regionName = currentCity.name;
    const addr = currentCity.address || "";
    const sysPrompt = `你是亲切自然、熟悉本地美食与出行的中文智能语音助手。工具含 Google Search、Google Maps 及 start_navigation。
【一、仅限中英双语与纯正自然普通话发音铁律（彻底杜绝西语/德语等外语误回复）】
- 【100% 中文普通话回复铁律（严禁外语回复）】：用户母语为中文，全程只会说【中文普通话】（偶有少量英语单词），【绝对不会说西班牙语、德语、法语等小语种】！除非用户明确要求翻译句子，否则你的语音与文字回复【必须 100% 使用简体中文普通话】，【绝对禁止】输出任何西班牙语（如“Sí, en los centros comerciales...”、“No hay restaurantes...”、“¿Le gustaría...?”）、德语（“Ja”）或其他外语！
- 【字正腔圆、自然平实】：全程使用纯正、标准、温和自然的普通话（声调平稳清晰，像日常面对面朋友交谈一样自然顺耳），不加寒暄套话，每次控制在 2~3 句简短口语（约 40~70 字）。
- 【严禁怪异网络词与儿化腔】：【绝对禁止】使用“这片儿”、“口碑王”、“超绝”、“翻牌子”、“地道好味”、“宝藏店”、“前者…后者…”、“得嘞”等生硬怪异词汇或做作腔调！
- 【优先使用中文店名（严禁中英夹杂带偏普通话口音）】：
  1) 凡是有中文名或通用中文译名的餐厅、商场、地标（尤其是中餐厅、新加坡/华人名店、知名连锁），在语音播报中【必须一律使用纯中文名称】！例如：必须说“珍宝海鲜”（严禁说 Jumbo Seafood）、说“御宝轩”或“御宝至尊烤鸭店”（严禁说 Imperial Treasure）、说“同乐经典”（严禁说 TungLok Signatures）、说“乐天味之楼”（严禁说 Taste Paradise）、说“翡翠金阁”（严禁说 Crystal Jade）、说“鼎泰丰”、“莆田”、“华厅餐厅”、“夏宫”、“江南春”、“松发肉骨茶”、“亚华肉骨茶”、“发起人肉骨茶”、“巴沙咖啡”（严禁说 Bacha Coffee）、“义安城”、“百丽宫”。
  2) 即便是没有中文名的纯西餐厅（如法餐 Les Amis、Odette，西班牙菜 La Tapería），【绝对禁止】在店名后面连读英文路名或商圈后缀（例如只说“乌节路的 Merci Marcel”或“Les Amis”，严禁连读成“Merci Marcel Orchard”或“Bistro du Vin Singapore”），防止英文词汇带偏后续普通话发音！
- 【自然变换推荐句式（相邻两轮不重复同一种开头，同时保留清晰店名供界面生成按键）】：
  推荐 2 家地点时，在以下三种平实自然的日常口语中轮换使用：
  · 表达 1（一家是+另一家是）：“附近有两家很不错的[品类]，一家是[店名A]，[一句自然特色，如胡椒味汤头很浓郁]；另一家是[店名B]，[一句自然特色]，您想去哪家？”
  · 表达 2（推荐试试+或者去）：“如果想吃[品类]，推荐试试[店名A]，他家的[招牌菜]很出名；或者去[店名B]，[特色]也很棒，看您更喜欢哪家？”
  · 表达 3（可以先去+也可以去）：“离这儿不远有两家高分好店，可以先去[店名A]，尝尝[招牌]；也可以去[店名B]，[特色]很受欢迎，去哪家我帮您导航？”
  （注意：【绝对不要】在语音末尾朗读“推荐选项：A、B”标签，界面会自动从店名提取一键导航按钮）。

【二、美食/地点追问消歧、中文地方菜系覆盖与抗外语幻觉铁律】
- 【中文短句防外语谐音误听（“北京菜有吗”严禁当成西语“cajero”）】：
  1) 当用户问“北京菜有吗？”（或因短音频被误听为西班牙语谐音“¿Hay un cajero?”、“cajero”）：100% 是在问附近有没有【北京菜/京味菜/北京烤鸭】（【绝对禁止】当成西班牙语 ATM 取款机！），立即用中文推荐乌节路附近的京味名店，如百丽宫的“御宝至尊烤鸭店”（招牌正宗北京片皮鸭）和义安城的“同乐经典”（招牌北京烤鸭与传统京菜）。
  2) 当用户问“粤菜”、“那广东菜呢？”（或被误听为“Ja.”、“Hola, soy Guangdong”）：100% 是在问【粤菜/广东菜】，立即用中文推荐“御宝轩”、“华厅餐厅”、“翡翠金阁”或“夏宫”。
  3) 当用户问“我想吃湖北菜”、“川菜”、“湘菜”、“本帮菜”等中国地方菜系：优先用中文推荐附近对应的中餐厅或风味相近的川湘/江浙名店（如百丽宫的“翡翠金阁”或义安城的“御宝轩”、“同乐经典”），【绝对禁止】用西班牙语或外语回答！
- 【简短菜系追问 = 推荐餐厅】：在餐饮/地点探索语境下，当用户说“额，有中餐吗？”、“中餐”、“法餐吗？”、“额，有法餐吗？”、“日料呢？”，100% 是在问“附近有什么该菜系的餐厅推荐？”，必须立即检索并推荐 2 家附近该菜系高分餐厅，【严禁】当成百科名词解释！
- 【句首吞字还原（“没有法餐” = “有没有法餐”）】：句首轻读时若被转写为“没有法餐”、“没有西餐”、“福临有没有肉骨茶”，在美食上下文中【必须】还原为“附近有没有[该菜系/食物]推荐？”，立即推荐对应餐厅。
- 【播报打断首词抗噪与跨国菜系还原】：播报中打断若出现近音（如“芝麻油菜有吗”→“西班牙菜有吗”、“啊我在有吗”→“法国菜有吗”、“黑脸一点/和医院一点”→“可以远一点”），立即按真实意图检索推荐。
- 【当用户嫌慢或催促“快点/太慢了”】：直接干脆回应并承接上文（如：“好的，我加快语速！刚才说的两家店您看去哪家，还是换个口味？”）。

【三、用户当前精确出发点与就近检索铁律】
- 当前起点：${landmark}（${regionName}，${addr}，纬度 ${lat}, 经度 ${lng}）。
- 所有周边推荐【必须】以此坐标为中心，优先步行（500米~1.5公里）或短途车程（1~3.5公里）内的近店，【严禁】推荐 10 公里外郊区分店。

【四、工具极速按需调度与零延迟多轮衔接】
1) 闲聊、百科、翻译、数学推理、嫌语速慢催促：【严禁】调用任何工具，0 延迟原生直答。
2) 实时天气/新闻/门票、周边餐馆商铺查询：按需调用 Google Search / Google Maps。
3) 明确单一目的地导航（含复合提问如“查水幕秀时间并带我去最佳观赏点”）：立即在第一时间调用 start_navigation(destination="具体店名/地标", travel_mode="DRIVING")，口语一句话确认即可。
4) 多候选推荐（如“推荐附近好吃的 / 有中餐吗 / 有法餐吗 / 北京菜有吗”）：用平实自然的口语推荐 2 家高分近店并询问去哪家，【严禁】在用户选定前提前调用 start_navigation。
5) 【跟进选店零搜索秒回】：当用户说“去第一家/第二个/带我过去/走吧/直接导航”等指代上文已提过的地点时，【绝对禁止重复调用 Google Search】，直接从对话记忆锁定对应店名并在第一时间调用 start_navigation，用不超过 25 字自然确认（如“好的，马上为您规划去松发肉骨茶的路线！”）。`;

    // v90: 全双工引擎可用时启用服务端 VAD（开口即打断 START_OF_ACTIVITY_INTERRUPTS）+ 会话续接 + 上下文滑窗压缩；
    //      不支持 AudioWorklet 的浏览器沿用手动轮次（文字 / Web Speech 退路）
    const duplexOn = duplexReady();
    duplexSetupActive = duplexOn;
    const modelObj = getActiveModelObj(activeModel);
    const modelTools = modelObj.supportsMapsTool
      ? [{googleSearch: {}}, {googleMaps: {}}, FC]
      : [{googleSearch: {}}, FC];

    const genConfig = {
      responseModalities: ["AUDIO"],
      temperature: 0.25,
      speechConfig: { languageCode: "cmn-CN" }
    };
    if (modelObj.thinkingLevel) {
      genConfig.thinkingConfig = { thinkingLevel: modelObj.thinkingLevel };
    }

    const inputTranscriptionConfig = {
      languageCodes: ["cmn-Hans-CN", "zh-CN", "en-US"],
      customVocabulary: [
        "北京菜", "粤菜", "广东菜", "湖北菜", "川菜", "湘菜", "江浙菜",
        "本帮菜", "潮州菜", "东北菜", "福建菜", "徽菜", "鲁菜", "西北菜",
        "新疆菜", "云南菜", "贵州菜", "台湾菜", "客家菜", "海南鸡饭",
        "肉骨茶", "火锅", "中餐", "法餐", "西班牙菜", "意大利菜", "日料",
        "韩餐", "泰国菜", "越南菜", "印度菜", "西餐", "北京烤鸭"
      ]
    };

    ws.send(JSON.stringify({setup: {
      model: activeModel,
      generationConfig: genConfig,
      outputAudioTranscription: {},
      inputAudioTranscription: inputTranscriptionConfig,
      ...(duplexOn ? window.DuplexVoice.setupExtras() : {realtimeInputConfig: {automaticActivityDetection: {disabled: true}}}),
      systemInstruction: {parts: [{text: sysPrompt}]},
      tools: modelTools
    }}));
  };

  // isFinal=true：本轮 turnComplete，允许接受未被标点终止的尾段；流式阶段丢弃半截名字避免按键闪烁
  function tryRealtimeExtractAndRender(text, gm, isFinal) {
    if (dispatchState.hasFc || activeDestination) {
      if (lastRenderedOptionsKey) {
        renderRecommendationOptions([]);
        lastRenderedOptionsKey = "";
      }
      return;
    }
    if (gm) lastTurnGroundingMeta = gm;
    let detected = [];
    try {
      detected = extractRealtimeOptions(text, gm || lastTurnGroundingMeta, { final: !!isFinal });
    } catch (e) {
      console.warn("[QuickOption] extractRealtimeOptions error:", e);
    }
    if (detected && detected.length >= 2) {
      const key = detected.map(d => d.name).join("|");
      if (key !== lastRenderedOptionsKey) {
        lastRenderedOptionsKey = key;
        console.log("[QuickOption] " + (isFinal ? "turnComplete 终态" : "流式零延迟") + "命中推荐按键并渲染 [" + (detected.__rule || "?") + "]:", key);
        renderRecommendationOptions(detected);
      }
    }
  }

  // ---------------- 智能实时导航嗅探与安全网 (毫秒级弹出路线与出行方式) ----------------
  function checkAndTriggerSmartNavigation(userText, modelText, gm, isFinal) {
    if (dispatchState.hasFc || activeDestination) return;

    const uText = (userText || "").trim();
    const mText = (modelText || "").trim();
    const combined = uText + " " + mText;

    // 1. 判断是否包含出行规划与导航意图
    const userWantsNav = /(?:规划路线|带我(?:去|到|过去)|(?:帮我|开始|直接)?导航|导航(?:去|到|过去)|怎么去|路线带我|带我去最佳观赏点|去最佳观赏点|去那[儿里]|去第[一二三123][家个]|第[一二三123][家个]|走吧|去刚才说的)/.test(uText);
    const modelConfirmsNav = /(?:(?:现在就|这就|马上)?(?:为[您你])?规划(?:前往|去|到)?.*路线|(?:\b|为[您你])规划(?:前往|去|到)|带[您你]过去|想开车[、，\s]*走路还是骑车|想开车还是步行|开车还是骑车)/.test(mText);

    if (!userWantsNav && !modelConfirmsNav) return;

    // 关键防护 1：如果用户当前提问明确是要求推荐周边多个候选地点（如“推荐周边/推荐几个/热门打卡/特色美食/高分咖啡”），
    // 且用户尚未明确指明具体选哪一家（未说“去第一家/去A/走吧”），绝对严禁盲目抢跑单目的地导航，必须优先让多选推荐卡片弹出！
    const isRecommendationQuery = /(?:推荐周边|推荐几个|推荐几家|推荐一些|推荐热门|热门打卡|特色美食|高分咖啡|周边高分|有哪些|找几个|找几家|推荐[两二三四234]个|推荐[两二三四234]家)/.test(uText) && !/(?:去第[一二三123]|第[一二三123][家个]|去那|走吧)/.test(uText);
    if (isRecommendationQuery) {
      return;
    }

    // 关键防护 2：如果模型正在给出多个推荐候选（如“为您推荐两家”、“第一家是... 第二家是... 您想去哪一个”、“首推...另外推荐...去哪家”），
    // 且用户没有明确指定去哪一家，必须等待选项按键渲染交互，绝对严禁自动抢跑单目的地导航！
    const isModelMultiRec = /(?:(?:为您|给您)?(?:推荐|挑了|找了)[两二三四234几]\s*[家个间处]|第一家是|第二家是|一家是[\s\S]*另一家是|一个是[\s\S]*另一个是|首先[\s\S]*其次|首推[\s\S]*(?:另外|或者)|可以先去[\s\S]*或者去|您想去哪|想去哪|去哪家|选哪家|尝哪家|试哪家|挑哪家|看哪家|翻哪家|哪一个|哪一家|哪家)/.test(mText);
    if (isModelMultiRec && !/(?:去第[一二三123]|第[一二三123][家个]|去那|走吧)/.test(uText)) {
      return;
    }

    try {
      const opts = extractRealtimeOptions(mText, gm, { final: false });
      if (opts && opts.length >= 2 && !/(?:去第[一二三123]|第[一二三123][家个]|去那家|走吧)/.test(uText)) {
        return;
      }
    } catch(e) {}

    // 2. 智能消歧义与解析目标目的地
    let targetDest = "";

    // 策略 A：命中权威地标消歧义词典 (最高优先级，直接精准定位经纬度)
    for (const lm of CANONICAL_LANDMARKS) {
      if (lm.pattern.test(combined)) {
        targetDest = lm.name;
        break;
      }
    }

    // 策略 B：纯代词多轮上下文消解（仅当用户输入纯跟进代词如“带我过去/去那儿/第一家/第二家/走吧”时启用）
    const isPureFollowUpNav = /(?:带我(?:过去|走)|(?:帮我|直接)?导航(?:过去)?|去那[儿里]|去那家|去那|走吧|去刚才说的|去第[一二三123][家个]|第[一二三123][家个])/.test(uText);
    if (!targetDest && isPureFollowUpNav) {
      if (/(?:第[二2][家个])/.test(uText) && typeof lastRecommendedOptionsList !== "undefined" && lastRecommendedOptionsList && lastRecommendedOptionsList[1]) {
        targetDest = lastRecommendedOptionsList[1].destination || lastRecommendedOptionsList[1].name;
      } else if (/(?:第[三3][家个])/.test(uText) && typeof lastRecommendedOptionsList !== "undefined" && lastRecommendedOptionsList && lastRecommendedOptionsList[2]) {
        targetDest = lastRecommendedOptionsList[2].destination || lastRecommendedOptionsList[2].name;
      } else if (lastRecommendedDestination) {
        targetDest = lastRecommendedDestination;
      }
    }

    // 策略 C：从 Google Maps Grounding 实体提取
    if (!targetDest && gm && gm.groundingChunks) {
      const mapChunk = gm.groundingChunks.find(c => c.maps && c.maps.title);
      if (mapChunk && isValidDestinationName(mapChunk.maps.title)) {
        targetDest = mapChunk.maps.title;
      }
    }

    // 策略 D：从模型口语表达中动态提取明确的单一目的地（如“最佳观赏点在金沙酒店门口的活动广场 (Event Plaza)”、“为您规划前往松发肉骨茶”、“马上为您规划去 Bistro du Vin 的路线”）
    if (!targetDest && mText) {
      const matchSpot = mText.match(/最佳观赏点在\s*([^，。！？(（\n]+)/);
      if (matchSpot && matchSpot[1] && isValidDestinationName(matchSpot[1].trim())) {
        targetDest = matchSpot[1].trim();
      } else {
        const matchRec = mText.match(/(?:为[您你]规划(?:前往|去|到)|规划(?:前往|去|到)|这就带[您你](?:去|前往)|带[您你](?:前往|去)|导航(?:前往|去|到))\s*([^，。！？(（\n]+?)(?:的(?:出行|最佳)?路线|路线)?(?:[，。！？!?.]|$)/);
        if (matchRec && matchRec[1] && isValidDestinationName(matchRec[1].trim())) {
          targetDest = matchRec[1].trim();
        }
      }
    }

    // 目标目的地合法性硬校验 (拦截“两家”、“这几个”等非具体地点名词)
    if (targetDest && !isValidDestinationName(targetDest)) {
      console.warn("[SmartNav] ⚠️ 拦截非法/非实体目的地:", targetDest);
      remoteLog("WARN", "SMART_NAV_REJECT", `拦截非法目的地候选: '${targetDest}'`, { userText: uText, modelText: mText });
      targetDest = "";
    }

    // 3. 毫秒级执行路线规划与出行方式弹窗
    if (targetDest && isValidDestinationName(targetDest)) {
      console.log("[SmartNav] 🎯 " + (isFinal ? "turnComplete 安全网" : "实时流式") + "命中导航意图与目的地:", targetDest);
      remoteLog("INFO", "SMART_NAV_TRIGGER", `SmartNav 命中目的地: '${targetDest}' (isFinal=${!!isFinal})`);
      dispatchState.hasFc = true;
      dispatchState.fcArgs = `start_navigation("${targetDest}", travel_mode="DRIVING")`;
      updateDispatchUI();
      if ($("telFcText")) $("telFcText").textContent = dispatchState.fcArgs;
      lastRecommendedDestination = targetDest;
      prepareRouteAndModeSelection(targetDest, "DRIVING");
    }
  }

  ws.onmessage = async (ev) => {
    const data = ev.data instanceof Blob ? await ev.data.text() : ev.data;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    // v90: 全双工引擎先看一眼（续接句柄 / goAway / interrupted 确认 / 轮次状态），再走 app.js 自身处理
    if (window.DuplexVoice) { try { window.DuplexVoice.onServerMessage(m); } catch (e) { console.warn("[Duplex] onServerMessage error:", e); } }

    if (m.setupComplete) {
      ready = true;
      $("btnSend").disabled = false;
      if ($("stateDot")) $("stateDot").style.background = "#34a853";
      if ($("metaStateDot")) $("metaStateDot").style.background = "#34a853";
      if ($("metaStateText")) $("metaStateText").textContent = "Live 就绪";
      syncModelSelectUI();
      if (pending) { const p = pending; pending = null; dispatch(p); }
      return;
    }

    const sc = m.serverContent || {};
    if (sc.interrupted) {
      // 服务端确认打断（用户开口 / 新文字指令）：清空本地播放队列；从这一刻起到达的音频属于新一轮，必须放行
      stopAllAudioPlayback();
      clearLateAudioGate("interrupted");
      markModelBoundaryCleared();
      if (currentModelTranscript && !/（已打断）$/.test(currentModelTranscript)) {
        currentModelTranscript += "（已打断）";
        broadcastModelTranscript(currentModelTranscript);
      }
    }
    if (sc.inputTranscription && sc.inputTranscription.text) {
      window.__foreignRescueSent = false;
      if (duplexReady()) {
        // 全双工：交给引擎做语义回声侦测与短暂扣留，再由它清场 + 上屏（见 duplex.js acceptInputTranscription）。
        // 用 duplexReady 而不是 micOn：用户刚关麦时服务端仍会把已 flush 的最后一句转写下发，这一句也要按新一轮处理，
        // 不能拼接到上一条提问后面。
        window.DuplexVoice.acceptInputTranscription(sc.inputTranscription.text);
      } else {
        const rawUser = currentUserTranscript + sc.inputTranscription.text;
        const cleanUser = (window.DuplexVoice && typeof window.DuplexVoice.sanitizeAllowedLanguageAsr === "function")
          ? window.DuplexVoice.sanitizeAllowedLanguageAsr(rawUser)
          : rawUser;
        if (cleanUser) {
          currentUserTranscript = cleanUser;
          broadcastUserTranscript(currentUserTranscript);
        }
      }
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      prepareFreshModelTurnIfNeeded();
      if ($("modelBubble").textContent === "思考中…" || $("modelBubble").textContent === "正在收听…" || $("modelBubble").textContent === "正在思考与实时检索中…") {
        $("modelBubble").textContent = "";
      }
      currentModelTranscript += sc.outputTranscription.text;
      // 终极防外语自愈守卫：若主模型在非翻译场景下意外输出西班牙语/小语种，立即切断外语音频并用还原后的中文意图重发！
      if (window.DuplexVoice && typeof window.DuplexVoice.isForeignLanguageOutput === "function" &&
          window.DuplexVoice.isForeignLanguageOutput(currentModelTranscript) &&
          !/翻译|怎么说|西语|西班牙语|法语|德语|日语|马来语|英语/.test(currentUserTranscript || "")) {
        stopAllAudioPlayback();
        currentModelTranscript = "";
        broadcastModelTranscript("正在为您用中文检索附近餐厅…");
        if (!window.__foreignRescueSent) {
          window.__foreignRescueSent = true;
          const rescueText = (window.DuplexVoice && window.DuplexVoice.rescuedForeignQuery) || currentUserTranscript || "附近有什么推荐的中餐厅？";
          setTimeout(() => { try { sendQuery(rescueText); } catch (e) {} }, 30);
        }
        return;
      }
      if (window.DuplexVoice) window.DuplexVoice.noteModelText(currentModelTranscript);
      broadcastModelTranscript(currentModelTranscript);
      tryRealtimeExtractAndRender(currentModelTranscript, sc.groundingMetadata);
      checkAndTriggerSmartNavigation(currentUserTranscript, currentModelTranscript, sc.groundingMetadata, false);
    }

    if (sc.groundingMetadata) {
      prepareFreshModelTurnIfNeeded();
      const gm = sc.groundingMetadata;
      lastTurnGroundingMeta = gm;
      if (gm.webSearchQueries && gm.webSearchQueries.length) {
        dispatchState.hasSearch = true;
        dispatchState.searchQuery = gm.webSearchQueries.join(" | ");
        updateDispatchUI();
      }
      if (gm.groundingChunks && gm.groundingChunks.some(c => c.maps)) {
        dispatchState.hasMaps = true;
        const mapTitles = gm.groundingChunks.filter(c => c.maps).map(c => c.maps.title || "POI").slice(0, 3).join(", ");
        dispatchState.mapsPoi = mapTitles || "已精准对齐 Google Maps 地图位置实体";
        updateDispatchUI();
        tryRealtimeExtractAndRender(currentModelTranscript, gm);
        checkAndTriggerSmartNavigation(currentUserTranscript, currentModelTranscript, gm, false);
      }
    }

    (sc.modelTurn && sc.modelTurn.parts || []).forEach(p => {
      if (p.text && !currentModelTranscript.includes(p.text)) {
        prepareFreshModelTurnIfNeeded();
        if ($("modelBubble").textContent === "思考中…" || $("modelBubble").textContent === "正在收听…" || $("modelBubble").textContent === "正在思考与实时检索中…") {
          $("modelBubble").textContent = "";
        }
        currentModelTranscript += p.text;
        if (window.DuplexVoice) window.DuplexVoice.noteModelText(currentModelTranscript);
        broadcastModelTranscript(currentModelTranscript);
        tryRealtimeExtractAndRender(currentModelTranscript, sc.groundingMetadata);
        checkAndTriggerSmartNavigation(currentUserTranscript, currentModelTranscript, sc.groundingMetadata, false);
      }
      if (p.inlineData && p.inlineData.data) {
        prepareFreshModelTurnIfNeeded();
        playPcm(p.inlineData.data);
      }
    });

    if (sc.turnComplete) {
      clearLateAudioGate("turnComplete");
      markModelBoundaryCleared();
      sceneLock = false;
      updateDispatchUI();
      broadcastModelTranscript(currentModelTranscript);
      // 如果本轮已触发导航函数调用或已有明确活跃目的地，决不允许显示遗留推荐按键
      if (dispatchState.hasFc || activeDestination) {
        renderRecommendationOptions([]);
        lastRenderedOptionsKey = "";
      } else {
        // 终态抽取（final=true）：接受句尾未加标点的最后一个名字，并用本轮 grounding 标题对齐权威名
        tryRealtimeExtractAndRender(currentModelTranscript, lastTurnGroundingMeta, true);
        if (!lastRenderedOptionsKey) {
          // 本轮完全没有推荐多个候选项，彻底清空遗留旧按键
          renderRecommendationOptions([]);
        }
      }
      // 客户端智能安全兜底 (Final Turn SafetyNet)
      checkAndTriggerSmartNavigation(currentUserTranscript, currentModelTranscript, lastTurnGroundingMeta, true);

      $("btnSend").disabled = false;
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("playing"));
    }

    if (m.toolCall) {
      prepareFreshModelTurnIfNeeded();
      $("tagFunction").classList.remove("hidden");
      $("telemetryBox").classList.remove("hidden");
      $("telFcRow").classList.remove("hidden");
      renderRecommendationOptions([]); // 触发函数调用（如导航规划）时，立即清除候选推荐按键！
      (m.toolCall.functionCalls || []).forEach(fc => {
        let dest = (fc.args && fc.args.destination) || "";
        // 关键：智能代词消解与上下文目的地回退 (针对“导航过去/去那儿/第一家/第一个”)
        if (!dest || !isValidDestinationName(dest)) {
          dest = lastRecommendedDestination || activeDestination || (currentCity.shortName ? (currentCity.shortName + " 核心商圈") : "ION Orchard");
        }
        if (!isValidDestinationName(dest)) {
          console.warn("[ToolCall] 过滤非法目的地:", dest);
          remoteLog("WARN", "TOOL_CALL_REJECT", `过滤非法目的地: '${dest}'`);
          return;
        }
        if (dest) lastRecommendedDestination = dest;
        const preferredMode = (fc.args && fc.args.travel_mode) || "DRIVING";
        dispatchState.hasFc = true;
        dispatchState.fcArgs = `${fc.name}("${dest}", travel_mode="${preferredMode}")`;
        updateDispatchUI();
        if ($("telFcText")) $("telFcText").textContent = dispatchState.fcArgs;
        remoteLog("INFO", "TOOL_CALL", `接收大模型工具调用: ${fc.name}("${dest}", travel_mode="${preferredMode}")`);
        if (fc.name === "start_navigation" && dest) {
          if (activeDestination && isSameDestination(dest, activeDestination) && routeUiActive()) {
            // 界面已在为同一目的地展示路线（用户刚点了推荐选项 / 切了出行方式，我们已通知模型）：不重复规划，只同步出行方式
            console.log("[ToolCall] 同一目的地已在规划/导航中，去重跳过重复规划:", dest, "mode=", preferredMode,
              expectedUiFc ? "(界面操作预期回调)" : "");
            if (preferredMode !== selectedTravelMode && !(simState && simState.active)) calculateModeRoute(preferredMode, false);
          } else {
            prepareRouteAndModeSelection(dest, preferredMode);
          }
          expectedUiFc = null;
        }
        ws.send(JSON.stringify({toolResponse: {functionResponses: [
          {id: fc.id, name: fc.name, response: {result: {status: "ok"}}}]}}));
      });
    }
  };

  ws.onclose = () => {
    if (!ready && typeof window !== "undefined" && window.DuplexVoice) {
      try { window.DuplexVoice.clearResumeHandle(); } catch (e) {}
    }
    ready = false;
    // 连接已断：上一轮不可能再收到 turnComplete，复位轮次锁并解除迟到帧门，避免下一轮开头被误吞
    sceneLock = false;
    clearLateAudioGate("ws_close");
    if ($("stateDot")) $("stateDot").style.background = "#ea4335";
    if ($("metaStateDot")) $("metaStateDot").style.background = "#ea4335";
    if ($("metaStateText")) $("metaStateText").textContent = "重连中…";
    setTimeout(connect, 2000);
  };
}

function reconnectFresh(keepResumeHandle) {
  // 主动换会话（切城市）时丢弃续接句柄，避免把旧城市的上下文与系统提示恢复回来；
  // 服务端 goAway 轮换（duplex.js 传 true）与发送时连接已断的自愈路径带句柄续接，多轮上下文不丢
  if (!keepResumeHandle && typeof window !== "undefined" && window.DuplexVoice) {
    try { window.DuplexVoice.clearResumeHandle(); } catch (e) {}
  }
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) {}
    ws = null;
  }
  ready = false;
  sceneLock = false;
  clearLateAudioGate("reconnect");
  connect();
}

// ---------------- 第一阶段：路线方案与出行方式预览 ----------------
async function prepareRouteAndModeSelection(destination, preferredMode) {
  destination = sanitizeDestinationName(destination);
  if (!destination || !isValidDestinationName(destination)) {
    console.warn("[PrepareRoute] 拦截无效目的地请求:", destination);
    remoteLog("WARN", "ROUTE_REJECT", `拦截无效目的地请求: '${destination}'`);
    return;
  }

  const isDuplicateRoute = !!(activeDestination && isSameDestination(destination, activeDestination) && routeUiActive());
  if (isDuplicateRoute) {
    console.log("[PrepareRoute] 同一目的地路线已就绪，跳过重复重置与视图强跳:", destination);
    if (preferredMode && preferredMode !== selectedTravelMode && !(simState && simState.active)) {
      calculateModeRoute(preferredMode, false);
    }
    return;
  }

  const alreadyPreparedInThisTurn = !!(dispatchState && dispatchState.routePrepared);
  if (dispatchState) dispatchState.routePrepared = true;

  activeDestination = destination;
  selectedTravelMode = preferredMode || "DRIVING";
  hasHealed = false;
  lastRenderedOptionsKey = "";
  renderRecommendationOptions([]); // 正在为特定目的地规划路线，坚决清空旧的候选推荐按键！

  // 重置界面提示与多端 ETA
  const originName = currentCity.originLandmark || currentCity.pickupLandmark || currentCity.name;
  if ($("previewOriginName")) $("previewOriginName").textContent = originName;
  if ($("previewDestInline")) $("previewDestInline").textContent = destination;
  if ($("mobOriginTitle")) $("mobOriginTitle").textContent = originName;
  if ($("mobDestSubtitleInline")) $("mobDestSubtitleInline").textContent = destination;

  if ($("previewDestTitle")) $("previewDestTitle").textContent = destination;
  if ($("previewDestSubtitle")) $("previewDestSubtitle").textContent = "路线已就绪 · 从 " + originName + " 出发";
  if ($("etaDriving")) $("etaDriving").textContent = "计算中…";
  if ($("etaBicycling")) $("etaBicycling").textContent = "计算中…";
  if ($("etaWalking")) $("etaWalking").textContent = "计算中…";
  if ($("mobEtaDriving")) $("mobEtaDriving").textContent = "计算中…";
  if ($("mobEtaBicycling")) $("mobEtaBicycling").textContent = "计算中…";
  if ($("mobEtaWalking")) $("mobEtaWalking").textContent = "计算中…";
  if ($("previewStatText")) $("previewStatText").textContent = "正在规划最佳出行方案…";
  { const _b = $("btnStartNavigation") || $("btnStartNav"); if (_b) _b.disabled = true; }
  $("routePreviewCard").classList.remove("hidden");
  showMobileRoutePicker(activeDestination, selectedTravelMode);
  $("tagMaps").classList.remove("hidden");

  broadcastTravelMode(selectedTravelMode);

  // 仅在本轮首次弹出路线卡片时，如果在全屏语音助手视图中，平滑切回全景地图以便用户直观看到路线方案
  if (!alreadyPreparedInThisTurn) {
    if ($("btnTabConsole") && $("viewAssistantOverlay") && !$("viewAssistantOverlay").classList.contains("hidden")) {
      $("btnTabConsole").click();
    }
    // 如果在手机端助手 Tab，自动切回地图 Tab
    if ($("mobTabMap") && !$("mobTabMap").classList.contains("active")) {
      $("mobTabMap").click();
    }
  }

  // 严格在当前坐标周边解析地点，优先命中权威地标消歧义词典
  resolvedDestTarget = null;
  let landmarkHit = null;
  for (const lm of CANONICAL_LANDMARKS) {
    if (lm.pattern.test(destination)) {
      landmarkHit = lm;
      break;
    }
  }

  if (landmarkHit) {
    console.log("[Disambiguation] 权威地标消歧义命中:", landmarkHit.name, landmarkHit.target);
    resolvedDestTarget = landmarkHit.target;
    if ($("previewDestTitle")) $("previewDestTitle").textContent = landmarkHit.name;
    if ($("previewDestInline")) $("previewDestInline").textContent = landmarkHit.name;
    if ($("mobDestSubtitleInline")) $("mobDestSubtitleInline").textContent = landmarkHit.name;
  } else if (window.google && google.maps && google.maps.places && google.maps.places.Place) {
    try {
      let searchDest = destination;
      if (currentCity.key === "sg" && !/新加坡|singapore/i.test(destination)) {
        searchDest += ", Singapore";
      } else if (currentCity.key === "sf" && !/san francisco|旧金山/i.test(destination)) {
        searchDest += ", San Francisco";
      } else if (currentCity.key === "tyo" && !/tokyo|东京|涉谷/i.test(destination)) {
        searchDest += ", Tokyo";
      } else if (currentCity.key === "par" && !/paris|巴黎/i.test(destination)) {
        searchDest += ", Paris";
      }

      const searchReq = {
        textQuery: searchDest,
        fields: ["displayName", "location", "formattedAddress"],
        language: "zh-CN",
        maxResultCount: 1
      };
      if (currentCity.region && currentCity.region.length === 2 && currentCity.region.toLowerCase() !== "auto") {
        searchReq.region = currentCity.region.toLowerCase();
      }
      if (currentCity.coords) {
        searchReq.locationBias = {
          center: currentCity.coords,
          radius: 8000 // 严格限制在8公里核心市区范围，坚决防止漂移至20+公里外的边陲地带或国家地理中心
        };
      }
      const {places} = await google.maps.places.Place.searchByText(searchReq);
      if (places && places.length && places[0].location) {
        const loc = places[0].location;
        resolvedDestTarget = {
          lat: typeof loc.lat === "function" ? loc.lat() : loc.lat,
          lng: typeof loc.lng === "function" ? loc.lng() : loc.lng
        };
        if (places[0].displayName && $("previewDestTitle")) {
          $("previewDestTitle").textContent = places[0].displayName;
        }
      }
    } catch (e) {
      console.warn("Places searchByText warning:", e);
    }
  }

  // 二级保险：若 Place.searchByText 仍未解析出坐标，使用 PlacesService.textSearch 兜底
  if (!resolvedDestTarget && window.google && google.maps && google.maps.places && google.maps.places.PlacesService) {
    try {
      const ps = new google.maps.places.PlacesService(document.createElement("div"));
      const psItem = await new Promise((resolve) => {
        ps.textSearch({
          query: destination,
          location: currentCity.coords ? new google.maps.LatLng(currentCity.coords.lat, currentCity.coords.lng) : undefined,
          radius: 8000
        }, (res, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && res && res.length && res[0].geometry && res[0].geometry.location) {
            resolve(res[0]);
          } else {
            resolve(null);
          }
        });
      });
      if (psItem && psItem.geometry && psItem.geometry.location) {
        const loc = psItem.geometry.location;
        resolvedDestTarget = {
          lat: typeof loc.lat === "function" ? loc.lat() : loc.lat,
          lng: typeof loc.lng === "function" ? loc.lng() : loc.lng
        };
        if (psItem.name && $("previewDestTitle")) {
          $("previewDestTitle").textContent = psItem.name;
        }
      }
    } catch (e) {
      console.warn("PlacesService textSearch fallback warning:", e);
    }
  }

  // 启动计算主方式与其它方式耗时
  calculateModeRoute(selectedTravelMode, true);
  fetchOtherModeEtas();
}

function updateModeTabsUI(mode) {
  document.querySelectorAll(".mode-tab").forEach(tab => {
    if (tab.dataset.mode === mode) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });
}

function calculateModeRoute(mode, shouldFitBounds = true) {
  broadcastTravelMode(mode);

  const center = new google.maps.LatLng(currentCity.coords.lat, currentCity.coords.lng);
  const ds = new google.maps.DirectionsService();

  const gTravelMode = 
    mode === "WALKING" ? google.maps.TravelMode.WALKING :
    mode === "BICYCLING" ? google.maps.TravelMode.BICYCLING :
    google.maps.TravelMode.DRIVING;

  const modeName = mode === "WALKING" ? "步行" : mode === "BICYCLING" ? "骑行" : "开车";

  const target = resolvedDestTarget || activeDestination;
  const safeRegion = (currentCity.region && currentCity.region.length === 2 && currentCity.region.toLowerCase() !== "auto") ? currentCity.region.toLowerCase() : undefined;

  let queryTarget = target;
  if (typeof queryTarget === "string") {
    if (currentCity.key === "sg" && !/新加坡|singapore/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Singapore";
    } else if (currentCity.key === "sf" && !/san francisco|旧金山/i.test(queryTarget)) {
      queryTarget = queryTarget + ", San Francisco";
    } else if (currentCity.key === "tyo" && !/tokyo|东京|涉谷/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Tokyo";
    } else if (currentCity.key === "par" && !/paris|巴黎/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Paris";
    }
  }

  ds.route({
    origin: center,
    destination: queryTarget,
    travelMode: gTravelMode,
    provideRouteAlternatives: true,
    region: safeRegion
  }, (result, status) => {
    if (status === google.maps.DirectionsStatus.OK && result.routes.length) {
      allAvailableRoutes = result.routes;
      selectedRouteIndex = 0;
      currentRouteData = allAvailableRoutes[0];
      const leg = currentRouteData.legs[0];

      const distMeters = leg.distance ? leg.distance.value : 0;
      // 距离异常安全拦截 (新加坡全岛宽约50km，单城导航若超过50km判定为跨国误匹配)
      if (currentCity.key === "sg" && distMeters > 50000) {
        console.error(`[AntiDrift] ⚠️ 拦截跨国超远路线! 终点='${target}', 距离=${(distMeters/1000).toFixed(1)}km`);
        remoteLog("ERROR", "CROSS_BORDER_DRIFT", `拦截跨国超远路线: 终点='${target}', 规划距离=${(distMeters/1000).toFixed(1)}km`);
        if ($("previewDestSubtitle")) {
          $("previewDestSubtitle").textContent = `⚠️ 未在当前城市(${currentCity.shortName})找到“${activeDestination}”，请确认店名`;
        }
        if ($("previewStatText")) {
          $("previewStatText").textContent = `超出城市服务范围 (${(distMeters/1000).toFixed(1)} km)，已自动拦截跨国路线`;
        }
        return;
      }

      const etaText = leg.duration.text;
      const distText = leg.distance.text;
      const originName = currentCity.originLandmark || currentCity.pickupLandmark || currentCity.name;
      if ($("previewDestSubtitle")) {
        $("previewDestSubtitle").textContent = `预计 ${etaText} (${distText}) · 从 ${originName} 出发`;
      }
      remoteLog("INFO", "NAVIGATION", `路线规划成功: 起点='${originName}', 终点='${activeDestination}', 方式=${modeName}, 距离=${distText}, 耗时=${etaText}`);

      if (mode === "DRIVING") {
        if ($("etaDriving")) $("etaDriving").textContent = etaText;
        if ($("mobEtaDriving")) $("mobEtaDriving").textContent = etaText;
      }
      if (mode === "BICYCLING") {
        if ($("etaBicycling")) $("etaBicycling").textContent = etaText;
        if ($("mobEtaBicycling")) $("mobEtaBicycling").textContent = etaText;
      }
      if (mode === "WALKING") {
        if ($("etaWalking")) $("etaWalking").textContent = etaText;
        if ($("mobEtaWalking")) $("mobEtaWalking").textContent = etaText;
      }

      const altCount = allAvailableRoutes.length;
      if ($("previewStatText")) $("previewStatText").textContent = `${modeName}推荐 (共 ${altCount} 条路线) · 预计 ${etaText} (${distText})`;
      if ($("mobPickerTitle")) $("mobPickerTitle").textContent = `${modeName}路线 · ${etaText} (${distText})`;
      { const _b = $("btnStartNavigation") || $("btnStartNav"); if (_b) _b.disabled = false; }

      // 渲染多端备选路线芯片选择栏
      broadcastAltRoutes(allAvailableRoutes, selectedRouteIndex);

      // 渲染主地图与子地图多路线
      renderRoutePreview(allAvailableRoutes, selectedRouteIndex, shouldFitBounds);
    } else {
      console.warn("Directions calculation failed:", mode, status);
      if (mode === "DRIVING") {
        if ($("etaDriving")) $("etaDriving").textContent = "不可达";
        if ($("mobEtaDriving")) $("mobEtaDriving").textContent = "不可达";
      }
      if (mode === "BICYCLING") {
        if ($("etaBicycling")) $("etaBicycling").textContent = "无专用道";
        if ($("mobEtaBicycling")) $("mobEtaBicycling").textContent = "无专用道";
      }
      if (mode === "WALKING") {
        if ($("etaWalking")) $("etaWalking").textContent = "不可达";
        if ($("mobEtaWalking")) $("mobEtaWalking").textContent = "不可达";
      }

      // 智能自愈：若因异地目的地导致跨海 ZERO_RESULTS 或 NOT_FOUND，自动纠偏为本地知名核心商圈
      if (!hasHealed && (status === google.maps.DirectionsStatus.ZERO_RESULTS || status === google.maps.DirectionsStatus.NOT_FOUND)) {
        triggerNearbyMallHeal();
      } else {
        if ($("previewStatText")) $("previewStatText").textContent = `${modeName}暂无法直达，请选择其他出行方式`;
      }
    }
  });
}

// 智能自愈：如果由于异地名称导致跨海零结果，自动纠偏为本地知名商圈
function triggerNearbyMallHeal() {
  hasHealed = true;
  const fallback = currentCity.fallbackMall || "ION Orchard";
  console.log("触发智能自愈，切换至本地核心商圈:", fallback);
  $("previewDestTitle").textContent = `${fallback} (本地推荐)`;
  $("previewDestSubtitle").textContent = "原目的地超出陆路范围，已为您自动切换至周边商圈";
  activeDestination = fallback;
  resolvedDestTarget = null;
  calculateModeRoute(selectedTravelMode, true);
  fetchOtherModeEtas();
}

function fetchOtherModeEtas() {
  const modes = ["DRIVING", "BICYCLING", "WALKING"];
  const center = new google.maps.LatLng(currentCity.coords.lat, currentCity.coords.lng);
  const ds = new google.maps.DirectionsService();
  const target = resolvedDestTarget || activeDestination;
  const safeRegion = (currentCity.region && currentCity.region.length === 2 && currentCity.region.toLowerCase() !== "auto") ? currentCity.region.toLowerCase() : undefined;

  let queryTarget = target;
  if (typeof queryTarget === "string") {
    if (currentCity.key === "sg" && !/新加坡|singapore/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Singapore";
    } else if (currentCity.key === "sf" && !/san francisco|旧金山/i.test(queryTarget)) {
      queryTarget = queryTarget + ", San Francisco";
    } else if (currentCity.key === "tyo" && !/tokyo|东京|涉谷/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Tokyo";
    } else if (currentCity.key === "par" && !/paris|巴黎/i.test(queryTarget)) {
      queryTarget = queryTarget + ", Paris";
    }
  }

  modes.forEach(m => {
    if (m === selectedTravelMode) return;
    const gMode = 
      m === "WALKING" ? google.maps.TravelMode.WALKING :
      m === "BICYCLING" ? google.maps.TravelMode.BICYCLING :
      google.maps.TravelMode.DRIVING;

    ds.route({
      origin: center,
      destination: queryTarget,
      travelMode: gMode,
      region: safeRegion
    }, (result, status) => {
      if (status === google.maps.DirectionsStatus.OK && result.routes.length) {
        const d = result.routes[0].legs[0].duration.text;
        if (m === "DRIVING") {
          if ($("etaDriving")) $("etaDriving").textContent = d;
          if ($("mobEtaDriving")) $("mobEtaDriving").textContent = d;
        }
        if (m === "BICYCLING") {
          if ($("etaBicycling")) $("etaBicycling").textContent = d;
          if ($("mobEtaBicycling")) $("mobEtaBicycling").textContent = d;
        }
        if (m === "WALKING") {
          if ($("etaWalking")) $("etaWalking").textContent = d;
          if ($("mobEtaWalking")) $("mobEtaWalking").textContent = d;
        }
      } else {
        const msg = m === "BICYCLING" ? "无专用道" : "不可达";
        if (m === "DRIVING") {
          if ($("etaDriving")) $("etaDriving").textContent = msg;
          if ($("mobEtaDriving")) $("mobEtaDriving").textContent = msg;
        }
        if (m === "BICYCLING") {
          if ($("etaBicycling")) $("etaBicycling").textContent = msg;
          if ($("mobEtaBicycling")) $("mobEtaBicycling").textContent = msg;
        }
        if (m === "WALKING") {
          if ($("etaWalking")) $("etaWalking").textContent = msg;
          if ($("mobEtaWalking")) $("mobEtaWalking").textContent = msg;
        }
      }
    });
  });
}

// ---------------- 多路线备选方案选择与切换 ----------------
function renderAltRoutesChips(routes, selectedIdx) {
  const container = $("altRoutesSelector");
  const list = $("altRoutesList");
  if (!container || !list) return;

  if (!routes || routes.length <= 1) {
    container.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  list.innerHTML = "";
  routes.forEach((r, idx) => {
    const leg = r.legs[0];
    const chip = document.createElement("button");
    chip.className = "alt-route-chip" + (idx === selectedIdx ? " active" : "");
    const isRecommended = idx === 0;
    const dur = leg.duration ? leg.duration.text : "";
    const dist = leg.distance ? leg.distance.text : "";
    chip.innerHTML = `<span>方案 ${idx + 1}</span> <b>${dur}</b> <small>(${dist})</small>${isRecommended ? " · 推荐" : ""}`;
    chip.onclick = (e) => {
      e.stopPropagation();
      switchSelectedRoute(idx);
    };
    list.appendChild(chip);
  });
  container.classList.remove("hidden");
}

function switchSelectedRoute(newIdx) {
  if (!allAvailableRoutes || !allAvailableRoutes[newIdx]) return;
  selectedRouteIndex = newIdx;
  currentRouteData = allAvailableRoutes[newIdx];

  broadcastAltRoutes(allAvailableRoutes, selectedRouteIndex);

  const leg = currentRouteData.legs[0];
  const modeName = selectedTravelMode === "WALKING" ? "步行" : selectedTravelMode === "BICYCLING" ? "骑行" : "开车";
  if ($("previewStatText")) $("previewStatText").textContent = `方案 ${newIdx + 1} (${modeName}) · 预计 ${leg.duration.text} (${leg.distance.text})`;
  if ($("mobPickerTitle")) $("mobPickerTitle").textContent = `方案 ${newIdx + 1} (${modeName}) · ${leg.duration.text} (${leg.distance.text})`;

  renderRoutePreview(allAvailableRoutes, selectedRouteIndex, false);
}

// ---------------- 多视图路线与标记同步 ----------------
function renderRoutePreview(routesOrCoords, selectedIdx = 0, shouldFitBounds = true) {
  const strokeColor = 
    selectedTravelMode === "WALKING" ? "#ea4335" :
    selectedTravelMode === "BICYCLING" ? "#0f9d58" : "#1a73e8";

  // 1. 全景主地图：清理旧折线与备选折线
  if (routePolyline) { routePolyline.setMap(null); routePolyline = null; }
  altPolylines.forEach(p => p.setMap(null));
  altPolylines = [];

  let activeRoute = null;
  if (Array.isArray(routesOrCoords) && routesOrCoords.length && routesOrCoords[0].overview_path) {
    allAvailableRoutes = routesOrCoords;
    selectedRouteIndex = selectedIdx;
    activeRoute = allAvailableRoutes[selectedIdx] || allAvailableRoutes[0];

    // 绘制灰色备选折线 (可直接在地图上点击切换)
    allAvailableRoutes.forEach((r, idx) => {
      if (idx === selectedIdx) return;
      const altPoly = new google.maps.Polyline({
        path: r.overview_path,
        geodesic: true,
        strokeColor: "#9aa0a6",
        strokeOpacity: 0.65,
        strokeWeight: 5,
        zIndex: 5,
        map: mainMap
      });
      google.maps.event.addListener(altPoly, 'click', () => {
        switchSelectedRoute(idx);
      });
      altPolylines.push(altPoly);
    });
  } else {
    activeRoute = currentRouteData;
  }

  const pathCoords = activeRoute ? activeRoute.overview_path : (Array.isArray(routesOrCoords) ? routesOrCoords : []);
  const leg = activeRoute ? activeRoute.legs[0] : null;
  const endLocation = leg ? leg.end_location : (pathCoords.length ? pathCoords[pathCoords.length - 1] : null);

  if (pathCoords && pathCoords.length) {
    routePolyline = new google.maps.Polyline({
      path: pathCoords,
      geodesic: true,
      strokeColor: strokeColor,
      strokeOpacity: 0.95,
      strokeWeight: 6,
      zIndex: 10,
      map: mainMap
    });
  }

  if (destMarker) destMarker.setMap(null);
  if (endLocation) {
    destMarker = new google.maps.Marker({
      position: endLocation,
      map: mainMap,
      icon: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
      title: activeDestination
    });
  }

  if (shouldFitBounds && mainMap && pathCoords && pathCoords.length) {
    const bounds = new google.maps.LatLngBounds();
    pathCoords.forEach(p => bounds.extend(p));
    mainMap.fitBounds(bounds, {top: 100, bottom: 60, left: 100, right: 60});
  }

  // 2. 无条件同步手机与眼镜子地图，保证用户无论何时切换视图，航线与折线均已即时就绪
  initMobileMapIfNeeded();
  syncSubMapView("mobile", shouldFitBounds);
  initGlassesMapIfNeeded();
  syncSubMapView("glasses", shouldFitBounds);
}

// 切换或打开子视图(手机 / 眼镜)时调用
function syncSubMapView(viewType, shouldFit = true) {
  const isMobile = (viewType === "mobile");
  if (isMobile) {
    initMobileMapIfNeeded();
  } else {
    initGlassesMapIfNeeded();
  }
  const subMap = isMobile ? mobileMap : glassesMap;
  if (!subMap) return;

  google.maps.event.trigger(subMap, "resize");

  if (currentRouteData) {
    const pathCoords = currentRouteData.overview_path;
    const leg = currentRouteData.legs[0];
    const strokeColor = 
      selectedTravelMode === "WALKING" ? "#ea4335" :
      selectedTravelMode === "BICYCLING" ? "#0f9d58" : "#1a73e8";

    if (isMobile) {
      if (mobPolyline) mobPolyline.setMap(null);
      mobAltPolylines.forEach(p => p.setMap(null));
      mobAltPolylines = [];

      mobPolyline = new google.maps.Polyline({
        path: pathCoords,
        geodesic: true,
        strokeColor: strokeColor,
        strokeOpacity: 0.95,
        strokeWeight: 6,
        map: mobileMap
      });

      // 绘制手机端备选路线折线
      if (allAvailableRoutes && allAvailableRoutes.length > 1) {
        allAvailableRoutes.forEach((r, idx) => {
          if (idx === selectedRouteIndex) return;
          const altPoly = new google.maps.Polyline({
            path: r.overview_path,
            geodesic: true,
            strokeColor: "#9aa0a6",
            strokeOpacity: 0.65,
            strokeWeight: 4,
            zIndex: 5,
            map: mobileMap
          });
          google.maps.event.addListener(altPoly, 'click', () => {
            switchSelectedRoute(idx);
          });
          mobAltPolylines.push(altPoly);
        });
      }

      if (mobDestMarker) mobDestMarker.setMap(null);
      mobDestMarker = new google.maps.Marker({
        position: leg.end_location,
        map: mobileMap,
        icon: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
        title: activeDestination
      });
    } else {
      if (hudPolyline) hudPolyline.setMap(null);
      hudAltPolylines.forEach(p => p.setMap(null));
      hudAltPolylines = [];

      hudPolyline = new google.maps.Polyline({
        path: pathCoords,
        geodesic: true,
        strokeColor: "#10b981",
        strokeOpacity: 0.95,
        strokeWeight: 5,
        map: glassesMap
      });

      if (hudDestMarker) hudDestMarker.setMap(null);
      hudDestMarker = new google.maps.Marker({
        position: leg.end_location,
        map: glassesMap,
        icon: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
        title: activeDestination
      });
    }

    if (shouldFit) {
      const bounds = new google.maps.LatLngBounds();
      pathCoords.forEach(p => bounds.extend(p));
      subMap.fitBounds(bounds);
      setTimeout(() => {
        if (subMap && currentRouteData) {
          google.maps.event.trigger(subMap, "resize");
          subMap.fitBounds(bounds);
        }
      }, 150);
    }

    // 若巡航正在进行中，立即为该子地图补齐光标位置
    if (simState.active && simState.coords.length) {
      const progress = simState.totalDist > 0 ? simState.distMeters / simState.totalDist : 0;
      const idx = Math.min(
        simState.coords.length - 1,
        Math.floor(progress * (simState.coords.length - 1))
      );
      const currPos = simState.coords[idx];
      updateAllCarMarkers(currPos);
    }
  } else {
    subMap.setCenter(currentCity.coords);
    subMap.setZoom(currentCity.zoom || 15);
  }
}


// 基于 Google Maps OverlayView 的动态 Emoji 交通工具光标 (小汽车 🚗 / 骑行人 🚴 / 步行人 🚶)
let EmojiOverlayClass = null;

function getEmojiMarkerClass() {
  if (EmojiOverlayClass) return EmojiOverlayClass;
  if (!window.google || !google.maps || !google.maps.OverlayView) return null;

  EmojiOverlayClass = class extends google.maps.OverlayView {
    constructor(position, emoji, modeClass, map) {
      super();
      this.position = position;
      this.emoji = emoji;
      this.modeClass = modeClass; // "driving", "bicycling", "walking"
      this.div = null;
      if (map) {
        this.setMap(map);
      }
    }

    onAdd() {
      this.div = document.createElement("div");
      this.div.className = `nav-emoji-marker mode-${this.modeClass}`;
      this.div.innerHTML = `
        <div class="marker-ripple"></div>
        <div class="marker-avatar-box">
          <span class="marker-emoji">${this.emoji}</span>
        </div>
      `;
      const panes = this.getPanes();
      if (panes && panes.overlayMouseTarget) {
        panes.overlayMouseTarget.appendChild(this.div);
      }
    }

    draw() {
      if (!this.div || !this.position) return;
      const projection = this.getProjection();
      if (!projection) return;
      const latLng = (this.position instanceof google.maps.LatLng) 
        ? this.position 
        : new google.maps.LatLng(this.position.lat, this.position.lng);
      const pixel = projection.fromLatLngToDivPixel(latLng);
      if (pixel) {
        this.div.style.left = pixel.x + "px";
        this.div.style.top = pixel.y + "px";
      }
    }

    setPosition(newPos) {
      this.position = newPos;
      this.draw();
    }

    onRemove() {
      if (this.div && this.div.parentNode) {
        this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
    }
  };
  window.EmojiMarker = EmojiOverlayClass;
  return EmojiOverlayClass;
}

function createEmojiMarker(position, emoji, modeClass, map) {
  const Cls = getEmojiMarkerClass();
  if (Cls && map) {
    return new Cls(position, emoji, modeClass, map);
  }
  return null;
}

function initAllCarMarkers(initialPos, modeObj) {
  const emoji = modeObj.emoji || "🚗";
  const modeClass = modeObj.modeClass || "driving";

  if (carMarker) { carMarker.setMap(null); carMarker = null; }
  if (mainMap) {
    carMarker = createEmojiMarker(initialPos, emoji, modeClass, mainMap);
  }

  if (mobCarMarker) { mobCarMarker.setMap(null); mobCarMarker = null; }
  if (mobileMap) {
    mobCarMarker = createEmojiMarker(initialPos, emoji, modeClass, mobileMap);
  }

  if (hudCarMarker) { hudCarMarker.setMap(null); hudCarMarker = null; }
  if (glassesMap) {
    hudCarMarker = createEmojiMarker(initialPos, emoji, modeClass, glassesMap);
  }
}

function updateAllCarMarkers(currPos) {
  if (!currPos) return;
  const modeObj = MODE_CONFIG[selectedTravelMode] || MODE_CONFIG.DRIVING;
  const emoji = modeObj.emoji || "🚗";
  const modeClass = modeObj.modeClass || "driving";

  if (mainMap) {
    if (!carMarker) {
      carMarker = createEmojiMarker(currPos, emoji, modeClass, mainMap);
    } else {
      carMarker.setPosition(currPos);
    }
  }

  if (mobileMap) {
    if (!mobCarMarker) {
      mobCarMarker = createEmojiMarker(currPos, emoji, modeClass, mobileMap);
    } else {
      mobCarMarker.setPosition(currPos);
    }
  }

  if (glassesMap) {
    if (!hudCarMarker) {
      hudCarMarker = createEmojiMarker(currPos, emoji, modeClass, glassesMap);
    } else {
      hudCarMarker.setPosition(currPos);
    }
  }
}

// ---------------- 导航巡航【暂停 / 继续 / 退出】状态控制 ----------------

function setSimSpeed(speedVal) {
  broadcastSimSpeed(speedVal);
  console.log(`[SimSpeed] Set to ${speedVal}, factor=${simSpeedFactor}`);
}
window.setSimSpeed = setSimSpeed;

function pauseSimulation() {
  if (!simState.active || simState.paused) return;
  simState.paused = true;
  if (simState.animId) {
    cancelAnimationFrame(simState.animId);
    simState.animId = null;
  }
  updateNavPauseUI(true);
}

function resumeSimulation() {
  if (!simState.active || !simState.paused) return;
  simState.paused = false;
  simState.lastTime = performance.now();
  updateNavPauseUI(false);
  if (currentSimLoopFn) {
    simState.animId = requestAnimationFrame(currentSimLoopFn);
  }
}

function togglePauseResume() {
  if (simState.paused) {
    resumeSimulation();
  } else {
    pauseSimulation();
  }
}

function updateNavPauseUI(isPaused) {
  broadcastSimPause(isPaused);
}

// ---------------- 第二阶段：正式开启实时导航 ----------------
function startActiveNavigation() {
  if (!currentRouteData) return;

  // 隐藏方案选择面板，展示真实导航卡片与底部控制栏
  if ($("routePreviewCard")) $("routePreviewCard").classList.add("hidden");
  if ($("mobRoutePickerSheet")) $("mobRoutePickerSheet").classList.add("hidden");
  if ($("mobTurnCard")) $("mobTurnCard").classList.remove("hidden");
  const mobMapBox = document.querySelector(".mobile-map-box");
  if (mobMapBox) mobMapBox.classList.add("has-turn-card");
  if ($("mobNavBottomBar")) $("mobNavBottomBar").classList.remove("hidden");

  const leg = currentRouteData.legs[0];
  const modeObj = MODE_CONFIG[selectedTravelMode] || MODE_CONFIG.DRIVING;

  const firstStep = leg.steps && leg.steps.length ? leg.steps[0] : null;
  const initialIcon = getManeuverIcon(firstStep);
  const turnDist = firstStep ? firstStep.distance.text : leg.distance.text;
  const cleanInstr = (firstStep ? firstStep.instructions : "").replace(/<[^>]*>?/gm, '');
  const turnRoad = cleanInstr || ("前往 " + activeDestination);
  const metaTimeMin = Math.round(leg.duration.value / 60);
  const metaDistKm = (leg.distance.value / 1000).toFixed(1);

  // 1. 更新主全景路牌
  if ($("navTurnIcon")) $("navTurnIcon").textContent = initialIcon;
  if ($("navTurnDist")) $("navTurnDist").textContent = turnDist;
  if ($("navTurnRoad")) $("navTurnRoad").textContent = turnRoad;
  if ($("navActiveModeBadge")) $("navActiveModeBadge").textContent = modeObj.icon + " " + modeObj.name;
  if ($("navMetaTime")) $("navMetaTime").textContent = metaTimeMin;
  if ($("navMetaDist")) $("navMetaDist").textContent = metaDistKm;
  if ($("navBanner")) $("navBanner").classList.remove("hidden");

  // 2. 更新手机端路牌与底部信息栏
  if ($("mobTurnIcon")) $("mobTurnIcon").textContent = initialIcon;
  if ($("mobTurnDist")) $("mobTurnDist").textContent = turnDist;
  if ($("mobTurnRoad")) $("mobTurnRoad").textContent = turnRoad;
  if ($("mobEtaTime")) $("mobEtaTime").textContent = metaTimeMin;
  if ($("mobDistVal")) $("mobDistVal").textContent = metaDistKm;
  if ($("mobDestTitle")) $("mobDestTitle").textContent = activeDestination;
  if ($("mobModeTag")) $("mobModeTag").textContent = modeObj.icon + " " + modeObj.name;

  // 3. 更新 AR 眼镜 HUD 真实元素 (严格匹配 HTML ID，杜绝 null 异常)
  if ($("hudTurnIcon")) $("hudTurnIcon").textContent = initialIcon;
  if ($("hudTurnInstruction")) $("hudTurnInstruction").textContent = turnDist;
  if ($("hudTurnSub")) $("hudTurnSub").textContent = turnRoad;
  if ($("hudRemainDist")) $("hudRemainDist").textContent = metaDistKm;
  if ($("hudEta")) $("hudEta").textContent = metaTimeMin;
  if ($("hudSpeed")) $("hudSpeed").textContent = Math.round(modeObj.speedKmh);
  if ($("hudNavModeLabel")) $("hudNavModeLabel").textContent = `${modeObj.icon} ${modeObj.name.toUpperCase()} HUD`;

  // 4. 启动动态巡航仿真引擎并同步三端视图
  startSimulation(leg, currentRouteData.overview_path, modeObj);
}

function exitNavigation() {
  if (simState.animId) cancelAnimationFrame(simState.animId);
  simState.active = false;
  simState.paused = false;

  if (routePolyline) { routePolyline.setMap(null); routePolyline = null; }
  altPolylines.forEach(p => p.setMap(null));
  altPolylines = [];

  if (mobPolyline) { mobPolyline.setMap(null); mobPolyline = null; }
  mobAltPolylines.forEach(p => p.setMap(null));
  mobAltPolylines = [];

  if (hudPolyline) { hudPolyline.setMap(null); hudPolyline = null; }
  hudAltPolylines.forEach(p => p.setMap(null));
  hudAltPolylines = [];

  if (destMarker) { destMarker.setMap(null); destMarker = null; }
  if (mobDestMarker) { mobDestMarker.setMap(null); mobDestMarker = null; }
  if (hudDestMarker) { hudDestMarker.setMap(null); hudDestMarker = null; }

  if (carMarker) { carMarker.setMap(null); carMarker = null; }
  if (mobCarMarker) { mobCarMarker.setMap(null); mobCarMarker = null; }
  if (hudCarMarker) { hudCarMarker.setMap(null); hudCarMarker = null; }

  currentRouteData = null;
  allAvailableRoutes = [];
  selectedRouteIndex = 0;
  activeDestination = "";
  resolvedDestTarget = null;
  hasHealed = false;
  renderRecommendationOptions([]);

  updateNavPauseUI(false);
  if ($("navBanner")) $("navBanner").classList.add("hidden");
  if ($("routePreviewCard")) $("routePreviewCard").classList.add("hidden");
  if ($("mobRoutePickerSheet")) $("mobRoutePickerSheet").classList.add("hidden");
  if ($("mobTurnCard")) $("mobTurnCard").classList.add("hidden");
  const mobMapBox = document.querySelector(".mobile-map-box");
  if (mobMapBox) mobMapBox.classList.remove("has-turn-card");
  if ($("mobNavBottomBar")) $("mobNavBottomBar").classList.add("hidden");
  if ($("altRoutesSelector")) $("altRoutesSelector").classList.add("hidden");
  if ($("mobAltRoutesSelector")) $("mobAltRoutesSelector").classList.add("hidden");
  if ($("hudTurnInstruction")) $("hudTurnInstruction").textContent = "READY";
  if ($("hudTurnSub")) $("hudTurnSub").textContent = "等待导航规划…";
  if ($("hudRemainDist")) $("hudRemainDist").textContent = "--";
  if ($("hudEta")) $("hudEta").textContent = "--";
  if ($("hudSpeed")) $("hudSpeed").textContent = "0";
  broadcastSimSpeed(1);
  $("tagMaps").classList.add("hidden");
  $("tagSearch").classList.add("hidden");
  $("tagFunction").classList.add("hidden");
  $("telemetryBox").classList.add("hidden");
  $("userBubble").classList.add("hidden");
  $("modelBubble").textContent = "正在收听…";
}

// ---------------- 动态巡航引擎与 60FPS 亚米级测地线平滑插值 (v63) ----------------
function startSimulation(leg, overviewPath, modeObj) {
  if (simState.animId) cancelAnimationFrame(simState.animId);

  simState.active = true;
  simState.paused = false;
  updateNavPauseUI(false);
  simState.steps = leg.steps || [];
  simState.totalDist = leg.distance.value;
  simState.distMeters = 0;
  simState.speedKmh = modeObj.speedKmh;
  simState.lastTime = performance.now();

  // 1. 抽取整条路线的高精度细分点阵 (优先从 steps.flatMap 获取所有精细转弯几何点)
  let densePoints = [];
  if (leg.steps && leg.steps.length) {
    leg.steps.forEach(s => {
      const pList = s.path || s.lat_lngs;
      if (pList && pList.length) {
        pList.forEach(p => densePoints.push(p));
      }
    });
  }
  if (!densePoints.length && overviewPath && overviewPath.length) {
    densePoints = overviewPath;
  }

  // 2. 标准化坐标格式为 {lat, lng} 并过滤相邻极近重复点
  const rawCoords = densePoints.map(p => {
    const lat = typeof p.lat === "function" ? p.lat() : Number(p.lat);
    const lng = typeof p.lng === "function" ? p.lng() : Number(p.lng);
    return { lat, lng };
  }).filter((p, i, arr) => {
    if (i === 0) return true;
    const prev = arr[i - 1];
    return Math.abs(p.lat - prev.lat) > 1e-7 || Math.abs(p.lng - prev.lng) > 1e-7;
  });

  // 3. 计算大地测地线累计距离累积数组 (Haversine 亚米级精度)
  function haversineMeters(p1, p2) {
    const R = 6371000;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const cumDists = [0];
  let totalGeodesicDist = 0;
  for (let i = 1; i < rawCoords.length; i++) {
    const d = haversineMeters(rawCoords[i - 1], rawCoords[i]);
    totalGeodesicDist += d;
    cumDists.push(totalGeodesicDist);
  }

  simState.denseCoords = rawCoords;
  simState.cumDists = cumDists;
  simState.totalGeodesicDist = totalGeodesicDist > 0 ? totalGeodesicDist : simState.totalDist;
  simState.currentSegIdx = 0;

  // 4. 计算每个 step 在整条路线中的累计米数区间
  let cum = 0;
  simState.stepOffsets = simState.steps.map(s => {
    const start = cum;
    cum += (s.distance ? s.distance.value : 0);
    return { start: start, end: cum, step: s };
  });

  const initialPos = rawCoords[0] || (overviewPath && overviewPath[0]) || { lat: 1.3048, lng: 103.8318 };
  initAllCarMarkers(initialPos, modeObj);

  currentSimLoopFn = stepSim;

  function stepSim(now) {
    if (!simState.active) return;
    // 平滑限制 dt 避免后台切屏切回时发生瞬移
    const dt = Math.min(0.1, Math.max(0.001, (now - simState.lastTime) / 1000));
    simState.lastTime = now;

    const baseMultiplier = selectedTravelMode === "WALKING" ? 18 : (selectedTravelMode === "BICYCLING" ? 12 : 8);
    const speedMultiplier = baseMultiplier * simSpeedFactor;
    const deltaMeters = (simState.speedKmh * 1000 / 3600) * dt * speedMultiplier;
    simState.distMeters = Math.min(simState.totalDist, simState.distMeters + deltaMeters);

    const progress = simState.totalDist > 0 ? simState.distMeters / simState.totalDist : 0;

    // --- 60FPS 亚米级连续线性测地线插值 ---
    const coords = simState.denseCoords;
    const cum = simState.cumDists;
    const numSegs = coords.length - 1;
    const targetDist = progress * simState.totalGeodesicDist;

    let segIdx = simState.currentSegIdx || 0;
    while (segIdx < numSegs - 1 && cum[segIdx + 1] < targetDist) {
      segIdx++;
    }
    while (segIdx > 0 && cum[segIdx] > targetDist) {
      segIdx--;
    }
    simState.currentSegIdx = segIdx;

    let currPos;
    if (numSegs <= 0) {
      currPos = coords[0] || initialPos;
    } else {
      const p1 = coords[segIdx];
      const p2 = coords[Math.min(segIdx + 1, numSegs)];
      const segLen = cum[segIdx + 1] - cum[segIdx];
      let u = 0;
      if (segLen > 0) {
        u = Math.max(0, Math.min(1, (targetDist - cum[segIdx]) / segLen));
      }
      currPos = {
        lat: p1.lat + u * (p2.lat - p1.lat),
        lng: p1.lng + u * (p2.lng - p1.lng)
      };
    }

    updateAllCarMarkers(currPos);

    // 动态路口与转向指示更新
    const currentStepObj = simState.stepOffsets.find(item => simState.distMeters >= item.start && simState.distMeters <= item.end);
    if (currentStepObj && currentStepObj.step) {
      const step = currentStepObj.step;
      const stepIcon = getManeuverIcon(step);
      const stepRemain = Math.max(0, currentStepObj.end - simState.distMeters);
      const stepDistStr = stepRemain > 1000 ? (stepRemain / 1000).toFixed(1) + " km" : Math.round(stepRemain) + " m";
      const cleanStepText = (step.instructions || "").replace(/<[^>]*>?/gm, '');

      if ($("navTurnIcon")) $("navTurnIcon").textContent = stepIcon;
      if ($("navTurnDist")) $("navTurnDist").textContent = stepDistStr;
      if ($("navTurnRoad")) $("navTurnRoad").textContent = cleanStepText;

      if ($("mobTurnIcon")) $("mobTurnIcon").textContent = stepIcon;
      if ($("mobTurnDist")) $("mobTurnDist").textContent = stepDistStr;
      if ($("mobTurnRoad")) $("mobTurnRoad").textContent = cleanStepText;

      if ($("hudTurnIcon")) $("hudTurnIcon").textContent = stepIcon;
      if ($("hudTurnInstruction")) $("hudTurnInstruction").textContent = stepDistStr;
      if ($("hudTurnSub")) $("hudTurnSub").textContent = cleanStepText;

      // 动态同步 AR 眼镜左目 3D 悬浮路牌与空间锚点
      if ($("hudArSignArrow")) $("hudArSignArrow").textContent = stepIcon;
      if ($("hudArSignRoad")) $("hudArSignRoad").textContent = cleanStepText;
      if ($("hudAnchorDist")) $("hudAnchorDist").textContent = stepDistStr;
      if ($("hudAnchorDest") && $("previewDestTitle")) $("hudAnchorDest").textContent = $("previewDestTitle").textContent;
      if ($("hudAnchorOrigin") && currentCity) $("hudAnchorOrigin").textContent = currentCity.name;
    }

    const remainMeters = Math.max(0, simState.totalDist - simState.distMeters);
    const remainKm = (remainMeters / 1000).toFixed(1);
    const remainMin = Math.max(1, Math.round(remainMeters / (simState.speedKmh * 1000 / 60)));

    if ($("navMetaDist")) $("navMetaDist").textContent = remainKm;
    if ($("navMetaTime")) $("navMetaTime").textContent = remainMin;
    if ($("mobDistVal")) $("mobDistVal").textContent = remainKm;
    if ($("mobEtaTime")) $("mobEtaTime").textContent = remainMin;
    if ($("hudRemainDist")) $("hudRemainDist").textContent = remainKm;
    if ($("hudEta")) $("hudEta").textContent = remainMin;
    if ($("hudSpeed")) $("hudSpeed").textContent = Math.round(simState.speedKmh);

    if (progress < 1) {
      simState.animId = requestAnimationFrame(stepSim);
    } else {
      if ($("navTurnDist")) $("navTurnDist").textContent = "已到达目的地附近";
      if ($("navTurnRoad")) $("navTurnRoad").textContent = "本次导航已圆满结束";
      if ($("mobTurnDist")) $("mobTurnDist").textContent = "已到达目的地";
      if ($("mobTurnRoad")) $("mobTurnRoad").textContent = "感谢使用 Google Maps 旅行伴侣";
      if ($("hudTurnInstruction")) $("hudTurnInstruction").textContent = "ARRIVED";
      if ($("hudTurnSub")) $("hudTurnSub").textContent = "已顺利抵达目的地附近";
      if ($("hudDistBig")) $("hudDistBig").textContent = "ARRIVED";
      if ($("hudRoadName")) $("hudRoadName").textContent = "已顺利抵达目的地附近";
      if ($("hudArSignRoad")) $("hudArSignRoad").textContent = "已顺利到达";
      if ($("hudAnchorDist")) $("hudAnchorDist").textContent = "已到达";
      if ($("hudVisionStatus")) $("hudVisionStatus").textContent = "● DESTINATION REACHED";
      if ($("hudTranscript")) $("hudTranscript").textContent = "Gemini: 您已顺利抵达目的地附近，祝您行程愉快！";
    }
  }

  simState.animId = requestAnimationFrame(stepSim);
}

// ---------------- 音频输出 (Web Audio API) ----------------
function resumeAudioIfNeeded() {
  try {
    if (!playCtx) {
      getMasterGain();
    }
    if (playCtx && playCtx.state === "suspended") {
      playCtx.resume().then(() => {
        console.log("[Audio] playCtx resumed successfully, state =", playCtx.state);
      }).catch(err => {
        console.warn("[Audio] playCtx resume failed:", err);
      });
    }
    window.playCtx = playCtx;
  } catch (e) {
    console.warn("[Audio] resumeAudioIfNeeded exception:", e);
  }
}

function playPcm(b64) {
  try {
    resumeAudioIfNeeded();
    getMasterGain();

    // v90: 打断后的迟到尾包（服务端管道里上一轮残留的音频分片）一律丢弃，杜绝“被打断后还自言自语”
    if (typeof shouldDropLateAudio === "function" && shouldDropLateAudio()) return;

    // Web Speech 半双工退路保护：仅在非全双工（原生语音对讲关闭）且旧录音活跃时才丢弃
    // 全双工模式下麦克风常开对讲，这是模型正常下发的语音，决不能丢弃！
    if (!duplexMicOn() && (userWantsRecording || isRecording)) {
      console.log(`[AntiEcho] ${voiceScope} 端正在收音，丢弃上一轮迟到的模型音频分片`);
      return;
    }

    const raw = atob(b64);
    const len = raw.length;
    const safeLen = len - (len % 2);
    const bytes = new Uint8Array(safeLen);
    for (let i = 0; i < safeLen; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const gain = (typeof getMasterGain === "function") ? getMasterGain() : (playCtx ? playCtx.destination : null);
    const buf = playCtx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(gain || playCtx.destination);

    // 加入活跃音频源队列，支持瞬间彻底掐灭打断
    activeAudioSources.add(src);
    isModelSpeaking = true;
    if ($("mobMapSoundWave")) $("mobMapSoundWave").classList.add("speaking");
    src.onended = () => {
      activeAudioSources.delete(src);
      if (activeAudioSources.size === 0) {
        isModelSpeaking = false;
        if ($("mobMapSoundWave")) $("mobMapSoundWave").classList.remove("speaking");
        console.log("[Audio] 模型语音完整播放结束");
      }
    };

    const startAt = Math.max(playCtx.currentTime, playTime);
    src.start(startAt);
    playTime = startAt + buf.duration;
  } catch (e) {
    console.warn("[playPcm error]:", e);
  }
}

// ---------------- 交互调度与发送 (持久多轮会话 · 保持全上下文记忆) ----------------
function sendQuery(text) {
  resumeAudioIfNeeded();
  if (!duplexMicOn()) {
    // Web Speech 半双工退路：文字发送时收掉旧的收音会话。
    // 全双工模式下麦克风常开，绝不因为文字发送而关麦（“只有我自己点停止”）。
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    userWantsRecording = false;
    isRecording = false;
    if (recognition) {
      try { recognition.stop(); } catch(e) { recognition.abort(); }
    }
    stopVoiceHardware();
    updateAllMicButtons(false);
    hideVoiceToast();
    voiceScope = null;
  }

  exitNavigation();
  lastRenderedOptionsKey = "";
  renderRecommendationOptions([]); // 发起新一轮查询，立即清空旧推荐按钮
  currentModelTranscript = "";
  currentUserTranscript = text;

  // 若用户开启全新推荐查询，彻底重置上一轮遗留的历史目的地缓存，防止串轮误触发
  if (/(?:推荐|找几个|找几家|有哪些|热门打卡|特色美食|周边)/.test(text) && !/(?:去第|导航过去|去那|走吧)/.test(text)) {
    lastRecommendedDestination = "";
  }

  // 1. 全域多端同屏广播用户提问与等待状态
  broadcastUserTranscript(text);
  broadcastModelTranscript("正在思考与实时检索中…");
  resetDispatchState();

  // 2. 文字打断 (Text Barge-in)：瞬间掐灭正在播放与排队的全部音频；若模型仍处于上一轮，布置迟到尾包丢弃门
  bargeIn("text");

  sceneLock = true;
  // v90: 发送按钮在思考 / 播报期间保持可用——用户随时可以再发一句文字打断当前播报

  // 3. 核心机制：复用当前活跃 WebSocket 长连接，严禁无故重连保留多轮上下文；若连接异常则安全自愈
  if (ws && ws.readyState === WebSocket.OPEN && ready) {
    console.log("[sendQuery] Using persistent session with full multi-turn context");
    dispatch({ kind: "text", text: text });
  } else {
    console.log("[sendQuery] Session not ready or disconnected, queueing and reconnecting fresh...");
    pending = { kind: "text", text: text };
    reconnectFresh(true);
  }
}

function dispatch(item) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frames = buildUserTextFrames(item.text);
  console.log(`[ws] dispatching user text via ${TEXT_INPUT_MODE} (multi-turn):`, item.text);
  frames.forEach(f => ws.send(JSON.stringify(f)));
}

async function initApp() {
  const citySelect = $("citySelect");
  if (citySelect) {
    citySelect.onchange = (e) => {
      resumeAudioIfNeeded();
      handleCityChange(e.target.value);
    };
  }

  // 模型切换选择器联动绑定 (桌面全景、语音助手工作台、手机端三端同步)
  const bindModelSelector = (id) => {
    const el = $(id);
    if (!el) return;
    el.value = activeModel;
    el.onchange = (e) => {
      resumeAudioIfNeeded();
      switchModel(e.target.value);
    };
  };
  bindModelSelector("modelSelect");
  bindModelSelector("astModelSelect");
  bindModelSelector("mobModelSelect");
  syncModelSelectUI();

  if ($("btnSend")) {
    $("btnSend").onclick = () => {
      resumeAudioIfNeeded();
      const txt = $("text").value.trim();
      if (txt) {
        $("text").value = "";
        sendQuery(txt);
      }
    };
  }

  // 主桌面全景搜索框电脑麦克风按钮绑定（作用域：console）
  if ($("btnMainMic")) {
    $("btnMainMic").onclick = () => {
      resumeAudioIfNeeded();
      toggleVoiceRecording("console");
    };
  }

  // 立即初始化电脑麦克风与语音识别引擎
  initVoiceEngine();

  if ($("text")) {
    $("text").onkeydown = (e) => {
      if (e.key === "Enter") {
        resumeAudioIfNeeded();
        const txt = $("text").value.trim();
        if (txt) {
          $("text").value = "";
          sendQuery(txt);
        }
      }
    };
  }

  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.onclick = () => {
      resumeAudioIfNeeded();
      const mode = tab.dataset.mode;
      if (mode && activeDestination) {
        onTravelModeSwitched(mode);   // v90: 掐断播报 + 本地重算 + 告知模型
      }
    };
  });

  const startNavBtn = $("btnStartNavigation") || $("btnStartNav");
  if (startNavBtn) {
    startNavBtn.onclick = () => {
      resumeAudioIfNeeded();
      startActiveNavigation();
    };
  }

  if ($("btnClosePreview")) {
    $("btnClosePreview").onclick = () => {
      exitNavigation();
    };
  }

  if ($("btnExitNav")) {
    $("btnExitNav").onclick = () => {
      exitNavigation();
    };
  }

  // 演示倍速控制绑定
  document.querySelectorAll("[data-speed]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      resumeAudioIfNeeded();
      const speed = btn.dataset.speed;
      setSimSpeed(speed);
    };
  });

  // 暂停与退出控制绑定
  if ($("btnPauseNav")) {
    $("btnPauseNav").onclick = () => {
      resumeAudioIfNeeded();
      togglePauseResume();
    };
  }
  if ($("btnMobPause")) {
    $("btnMobPause").onclick = () => {
      resumeAudioIfNeeded();
      togglePauseResume();
    };
  }
  if ($("btnMobCancel")) {
    $("btnMobCancel").onclick = () => {
      resumeAudioIfNeeded();
      exitNavigation();
    };
  }

  const tabs = document.querySelectorAll(".view-btn");
  tabs.forEach(btn => {
    btn.onclick = () => {
      resumeAudioIfNeeded();
      tabs.forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      const v = btn.dataset.view;

      $("viewMobileOverlay").classList.add("hidden");
      $("viewGlassesOverlay").classList.add("hidden");
      if ($("viewAssistantOverlay")) $("viewAssistantOverlay").classList.add("hidden");

      if (v === "assistant") {
        $("viewAssistantOverlay").classList.remove("hidden");
      } else if (v === "mobile") {
        $("viewMobileOverlay").classList.remove("hidden");
        initMobileMapIfNeeded();
        syncSubMapView("mobile", true);
        if (currentUserTranscript) {
          broadcastUserTranscript(currentUserTranscript);
        }
        if (currentModelTranscript) {
          broadcastModelTranscript(currentModelTranscript);
        }
        if (isModelSpeaking && $("mobMapSoundWave")) {
          $("mobMapSoundWave").classList.add("speaking");
        }
        setTimeout(() => {
          if (mobileMap) google.maps.event.trigger(mobileMap, "resize");
          syncSubMapView("mobile", true);
        }, 120);
        setTimeout(() => {
          if (mobileMap) google.maps.event.trigger(mobileMap, "resize");
          syncSubMapView("mobile", true);
        }, 300);
      } else if (v === "glasses") {
        $("viewGlassesOverlay").classList.remove("hidden");
        initGlassesMapIfNeeded();
        syncSubMapView("glasses", true);
        setTimeout(() => {
          if (glassesMap) google.maps.event.trigger(glassesMap, "resize");
          syncSubMapView("glasses", true);
        }, 120);
        setTimeout(() => {
          if (glassesMap) google.maps.event.trigger(glassesMap, "resize");
          syncSubMapView("glasses", true);
        }, 300);
      }
    };
  });

  $("viewMobileOverlay").onclick = (e) => {
    if (e.target === $("viewMobileOverlay")) {
      $("viewMobileOverlay").classList.add("hidden");
      $("btnTabConsole").click();
    }
  };
  $("viewGlassesOverlay").onclick = (e) => {
    if (e.target === $("viewGlassesOverlay")) {
      $("viewGlassesOverlay").classList.add("hidden");
      $("btnTabConsole").click();
    }
  };
  if ($("viewAssistantOverlay")) {
    $("viewAssistantOverlay").onclick = (e) => {
      if (e.target === $("viewAssistantOverlay")) {
        $("viewAssistantOverlay").classList.add("hidden");
        $("btnTabConsole").click();
      }
    };
  }

  initAllDeviceEventBindings();

  try {
    const res = await fetch("/config");
    const cfg = await res.json();
    const key = cfg.mapsKey || "";
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,geometry&callback=initGoogleMaps`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  } catch (e) {}

  connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}


// 全局方法安全挂载 (支持控制台交互、自动化验证与三端切换)
window.pauseSimulation = pauseSimulation;
window.resumeSimulation = resumeSimulation;
window.togglePauseResume = togglePauseResume;
window.exitNavigation = exitNavigation;
window.switchSelectedRoute = switchSelectedRoute;
window.confirmStartNavigation = startActiveNavigation;
window.startActiveNavigation = startActiveNavigation;
window.prepareRouteAndModeSelection = prepareRouteAndModeSelection;
window.simState = simState;
window.getSimPaused = () => simState.paused;
window.getSelectedTravelMode = () => selectedTravelMode;
window.toggleVoiceRecording = toggleVoiceRecording;
window.startVoiceRecording = toggleVoiceRecording;
window.initVoiceEngine = initVoiceEngine;
window.getVoiceState = () => ({
  activeModel: activeModel,
  modelName: getActiveModelObj(activeModel).name,
  isRecording: isRecording,
  userWantsRecording: userWantsRecording,
  hasRecognition: !!recognition,
  hasStream: !!voiceStream,
  accumulatedText: voiceAccumulatedText,
  scope: voiceScope,
  sessionId: voiceSessionId,
  activeAudioSourcesCount: activeAudioSources ? activeAudioSources.size : 0,
  isModelSpeaking: isModelSpeaking,
  hasSilenceTimer: !!voiceSilenceTimer,
  duplex: (typeof window !== "undefined" && window.DuplexVoice) ? window.DuplexVoice.stats() : null,
  lateAudioGate: Object.assign({}, lateAudioGate),
  textInputMode: TEXT_INPUT_MODE,
  audioSink: audioSinkMode
});
window.getActiveModel = () => activeModel;
window.getActiveModelObj = getActiveModelObj;
window.switchModel = switchModel;
window.AVAILABLE_MODELS = AVAILABLE_MODELS;
window.getAudioSinkMode = getAudioSinkMode;
window.setAudioSinkMode = setAudioSinkMode;
window.bargeIn = bargeIn;
window.stopAllAudioPlayback = stopAllAudioPlayback;
window.isEchoOfRecentModelSpeech = isEchoOfRecentModelSpeech;
window.simulateVoiceInput = function(text, isFinal = true) {
  if (!userWantsRecording && !isRecording) {
    console.warn("[VoiceEngine] 模拟输入被忽略：当前未处于录音状态");
    return false;
  }
  const item = [{ transcript: text }];
  item.isFinal = !!isFinal;
  if (recognition && recognition.onresult) {
    recognition.onresult({ results: [item] });
    return true;
  }
  voiceAccumulatedText = text;
  const ownInput = scopeInput(voiceScope);
  if (ownInput) ownInput.value = text;
  return true;
};
window.stopVoiceRecordingAndSend = stopVoiceRecordingAndSend;
window.switchView = function(viewName) {
  resumeAudioIfNeeded();
  const btn = document.querySelector(`.view-btn[data-view="${viewName}"]`);
  if (btn) btn.click();
};


// ---------------- 初始化绑定多端事件 (v54) ----------------
function initAllDeviceEventBindings() {
  // 手机端城市选择
  if ($("mobCitySelect")) {
    $("mobCitySelect").onchange = (e) => {
      handleCityChange(e.target.value);
    };
  }

  // 手机端视窗切换: 🗺️ 地图 vs 🎙️ 助手
  if ($("mobTabMap") && $("mobTabChat")) {
    $("mobTabMap").onclick = () => {
      $("mobTabMap").classList.add("active");
      $("mobTabChat").classList.remove("active");
      if ($("mobMapContainer")) $("mobMapContainer").classList.remove("hidden");
      if ($("mobAssistantContainer")) $("mobAssistantContainer").classList.add("hidden");
      if (mobileMap) {
        google.maps.event.trigger(mobileMap, "resize");
        if (currentCity.coords) mobileMap.setCenter(currentCity.coords);
      }
    };
    $("mobTabChat").onclick = () => {
      $("mobTabChat").classList.add("active");
      $("mobTabMap").classList.remove("active");
      if ($("mobMapContainer")) $("mobMapContainer").classList.add("hidden");
      if ($("mobAssistantContainer")) $("mobAssistantContainer").classList.remove("hidden");
    };
  }

  // 手机端地图悬浮字幕关闭/收起
  if ($("btnMobCloseSub")) {
    $("btnMobCloseSub").onclick = (e) => {
      e.stopPropagation();
      if ($("mobMapSubtitleCard")) $("mobMapSubtitleCard").classList.add("hidden");
    };
  }

  // 手机端搜索与发送
  if ($("mobBtnSend") && $("mobSearchInput")) {
    $("mobBtnSend").onclick = () => {
      const val = $("mobSearchInput").value.trim();
      if (val) {
        sendQuery(val);
      }
    };
    $("mobSearchInput").onkeydown = (e) => {
      if (e.key === "Enter") {
        const val = $("mobSearchInput").value.trim();
        if (val) {
          sendQuery(val);
        }
      }
    };
  }

  // 手机端路线选择器出行方式与开始导航
  document.querySelectorAll(".mob-mode-pill").forEach(p => {
    p.onclick = () => {
      document.querySelectorAll(".mob-mode-pill").forEach(btn => btn.classList.remove("active"));
      p.classList.add("active");
      const m = p.getAttribute("data-mode");
      if (m) onTravelModeSwitched(m);   // v90: 掐断播报 + 本地重算 + 告知模型
    };
  });
  if ($("btnMobStartNav")) {
    $("btnMobStartNav").onclick = () => {
      startActiveNavigation();
    };
  }
  if ($("btnMobClosePicker")) {
    $("btnMobClosePicker").onclick = () => {
      if ($("mobRoutePickerSheet")) $("mobRoutePickerSheet").classList.add("hidden");
    };
  }

  // 手机端快捷问答芯片
  document.querySelectorAll(".suggest-pill").forEach(sp => {
    sp.onclick = () => {
      const q = sp.getAttribute("data-q");
      if (q) {
        sendQuery(q);
      }
    };
  });

  // 全端麦克风与语音对讲大按钮绑定 (电脑全景、手机端、眼镜端、助手端) —— 每个按钮显式声明自己所属的工作区
  if ($("btnMainMic")) $("btnMainMic").onclick = () => toggleVoiceRecording("console");
  if ($("mobBtnMic")) $("mobBtnMic").onclick = () => toggleVoiceRecording("mobile");
  if ($("btnMobTalk")) $("btnMobTalk").onclick = () => toggleVoiceRecording("mobile");

  // 眼镜端顶部城市按钮
  document.querySelectorAll(".g-city-pill").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".g-city-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      handleCityChange(btn.getAttribute("data-city"));
    };
  });

  // 眼镜端模式切换
  if ($("gTabNav") && $("gTabVoice")) {
    $("gTabNav").onclick = () => {
      $("gTabNav").classList.add("active");
      $("gTabVoice").classList.remove("active");
      if ($("hudNavRightContent")) $("hudNavRightContent").classList.remove("hidden");
      if ($("hudChatRightContent")) $("hudChatRightContent").classList.add("hidden");
    };
    $("gTabVoice").onclick = () => {
      $("gTabVoice").classList.add("active");
      $("gTabNav").classList.remove("active");
      if ($("hudNavRightContent")) $("hudNavRightContent").classList.add("hidden");
      if ($("hudChatRightContent")) $("hudChatRightContent").classList.remove("hidden");
    };
  }

  // 眼镜端快捷语音芯片
  document.querySelectorAll(".hud-assistant-chip").forEach(chip => {
    chip.onclick = () => {
      const q = chip.getAttribute("data-q");
      if (q) {
        sendQuery(q);
      }
    };
  });
  if ($("gBtnMic")) $("gBtnMic").onclick = () => toggleVoiceRecording("glasses");

  // 全屏语音助手工作台 6 大卡片
  document.querySelectorAll(".ast-card").forEach(card => {
    card.onclick = () => {
      const q = card.getAttribute("data-prompt");
      if (q) {
        sendQuery(q);
      }
    };
  });

  // 全屏语音助手输入与麦克风
  if ($("astBtnSend") && $("astInputText")) {
    $("astBtnSend").onclick = () => {
      const t = $("astInputText").value.trim();
      if (t) {
        sendQuery(t);
        $("astInputText").value = "";
      }
    };
    $("astInputText").onkeydown = (e) => {
      if (e.key === "Enter") {
        const t = $("astInputText").value.trim();
        if (t) {
          sendQuery(t);
          $("astInputText").value = "";
        }
      }
    };
  }
  if ($("astBtnMic")) $("astBtnMic").onclick = () => toggleVoiceRecording("assistant");
}

// 页面加载完成后统一初始化
window.addEventListener("DOMContentLoaded", () => {
  initAllDeviceEventBindings();
});
setTimeout(initAllDeviceEventBindings, 1000);


// ========================================================
// v56: 推荐选项按键引擎 (免输入 · 一键直达路线规划)
// ========================================================


function renderRecommendationOptions(optionsList) {
  const containerIds = ["recOptionsConsole", "recOptionsMobile", "recOptionsMapMobile", "recOptionsGlasses", "recOptionsAssistant"];
  if (!optionsList || !optionsList.length) {
    containerIds.forEach(id => {
      const el = $(id);
      if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
    });
    return;
  }

  // 手机地图视窗字幕卡片展示推荐按键时，确保卡片可见
  if ($("mobMapSubtitleCard")) $("mobMapSubtitleCard").classList.remove("hidden");

  // 记录最近一次推荐的目的地首选实体与完整列表，供用户说“导航过去/第一家/第二家”等后续省略句时精准命中
  lastRecommendedDestination = optionsList[0].destination || optionsList[0].name;
  window.lastRecommendedOptionsList = optionsList.slice();

  containerIds.forEach(id => {
    const container = $(id);
    if (!container) return;
    container.innerHTML = `
      <div class="rec-options-header">
        <span>📍 推荐目的地（免输入 · 点击直达路线规划）：</span>
      </div>
      <div class="rec-options-list"></div>
    `;
    const list = container.querySelector(".rec-options-list");
    optionsList.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.className = "rec-opt-btn" + (idx === 1 ? " secondary" : idx > 1 ? " purple" : "");
      btn.innerHTML = `<span>${opt.icon || "📍"} ${opt.name}</span><span class="opt-arrow">➔</span>`;
      btn.title = `点击一键选择 ${opt.name} 并规划路线`;
      btn.onclick = (e) => {
        e.stopPropagation();
        handleSelectRecommendationOption(opt);
      };
      list.appendChild(btn);
    });
    container.classList.remove("hidden");
  });
}

function handleSelectRecommendationOption(opt) {
  console.log("[QuickOption] Selected destination:", opt);

  // 1. 如果在全屏语音助手视图中，平滑切回全景地图以便客户直观看到路线方案
  if ($("btnTabConsole") && !$("viewAssistantOverlay").classList.contains("hidden")) {
    $("btnTabConsole").click();
  }

  // 2. 如果在手机端助手 Tab，自动切回地图 Tab
  if ($("mobTabMap") && !$("mobTabMap").classList.contains("active")) {
    $("mobTabMap").click();
  }

  // 3. 文字打断：瞬间掐灭正在播放 / 排队的播报（模型可能还在念第二、第三个候选），并布置迟到尾包丢弃门
  const dest = opt.destination || opt.name;
  bargeIn("option");

  // 4. 更新输入框与气泡展示
  const promptText = `前往 ${opt.name}`;
  syncAllAssistantBubbles(promptText, `正在为您规划前往【${opt.name}】的最佳出行路线，并提供开车、骑行、步行多方案对比…`);

  // 5. 立即启动路线规划与出行方式选择并清除推荐按键（本地秒开，不等模型）
  lastRenderedOptionsKey = "";
  renderRecommendationOptions([]);
  prepareRouteAndModeSelection(dest, "DRIVING");

  // 6. 向服务端发起新指令：让模型知道用户已选定目的地（多轮上下文一致 + 语音确认）。
  //    模型随后回调的 start_navigation 会被 toolCall 去重逻辑识别为同一目的地，不会重复规划。
  notifyModelOfUiAction(`我选择前往「${dest}」，请为我规划路线，并用一句话简短确认。`, { always: true, expectDest: dest, expectMode: "DRIVING" });
}


// ========================================================
// v78: 纯实时动态推荐选项抽取引擎 2.0 (ZERO HARDCODING)
// 输入 rawText 是 Gemini Live 原生音频模型的 ASR 转写（不是模型写的文本），因此必须容忍：
//   · 没有【】、没有 |（语音里念不出来），标点漂移（：→，）
//   · 中英双语括注：滨海湾花园 (Gardens by the Bay)
//   · 评分/修饰语粘连：…，评分4.7分，巨大的超级树…
//   · 流式截断：句子只到了半个名字（非 final 模式下丢弃未闭合片段，避免按键闪烁出错名）
// 抽取优先级：显式标记 → 序数口语(第一家是/首先是/一是/一个是…另一个是/1. 2.) → 成对连词(A 或者 B / 包括 A 和 B)
//            → Google Maps grounding 实体兜底；grounding 标题同时用于把口语名对齐为权威名。
// ========================================================
const OPT_MAX_ITEMS = 3;

// 候选名称绝不跨越的硬分隔符（括号内除外）
const OPT_HARD_DELIM_RE = /[，,。；;！!？?：:、\n\r]/;

// 名称字符类：中/英/数字/常见连接符/空格（不含任何标点分隔符）
const OPT_NAME_SRC = "[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7afA-Za-z0-9&'’\\.\\-·\\s]";

// 序数/排序口语标记 → 排名（左侧优先匹配，"另一个是" 会先于其中的 "一个是" 命中）
const OPT_ORDINAL_MARKERS = [
  { src: "第\\s*[一1１]\\s*[家个处座点站间位所名]?\\s*(?:推荐|选择|候选)?\\s*(?:就是|则是|是|为|叫做|叫|名为|当属|要数)?", rank: 1 },
  { src: "第\\s*[二2２]\\s*[家个处座点站间位所名]?\\s*(?:推荐|选择|候选)?\\s*(?:就是|则是|是|为|叫做|叫|名为|当属|要数)?", rank: 2 },
  { src: "第\\s*[三3３]\\s*[家个处座点站间位所名]?\\s*(?:推荐|选择|候选)?\\s*(?:就是|则是|是|为|叫做|叫|名为|当属|要数)?", rank: 3 },
  { src: "首先\\s*(?:推荐的是|推荐|是|为)?", rank: 1 },
  { src: "其次\\s*(?:推荐的是|推荐|是|为)?", rank: 2 },
  { src: "(?:首推|先推|可以先去|可以先看|不妨先去|推荐试试|可以先试试|建议试试)\\s*(?:的是|是|为)?", rank: 1 },
  { src: "(?:或者可以去|或者去|另外可以去|也可以去|也可以试试)\\s*(?:的是|是|为)?", rank: 2 },
  { src: "(?:再次|再者|最后|然后|接着|另外)\\s*(?:推荐的是|推荐|是|为)", rank: 3 },
  { src: "其一\\s*(?:是|为)?", rank: 1 },
  { src: "其二\\s*(?:是|为)?", rank: 2 },
  { src: "其三\\s*(?:是|为)?", rank: 3 },
  { src: "(?:另一|另外一|还有一|再有一|另有一)\\s*[个家处座点站间位所]\\s*(?:就是|则是|是|为|叫做|叫)", rank: 2 },
  { src: "(?:一|头一)\\s*[个家处座点站间位所]\\s*(?:就是|是|为|叫做|叫)", rank: 1 },
  { src: "(?<![一二三四五六七八九十第唯之])一是", rank: 1 },
  { src: "(?<![一二三四五六七八九十第])二是", rank: 2 },
  { src: "(?<![一二三四五六七八九十第])三是", rank: 3 },
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n])[一]\\s*[、.．]\\s*(?![、.．])", rank: 1 },
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n])[二]\\s*[、.．]\\s*(?![、.．])", rank: 2 },
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n])[三]\\s*[、.．]\\s*(?![、.．])", rank: 3 },
  // 英文序数口语：First, … Second, … / The first one is …
  { src: "(?:^|[\\s，,。；;：:！!？?\\n])(?:First(?:ly)?|The first (?:one|option|place|spot|choice)(?: is| would be)?)\\s*[,:：]?\\s*", rank: 1 },
  { src: "(?:^|[\\s，,。；;：:！!？?\\n])(?:Second(?:ly)?|Next(?: up)?|The second (?:one|option|place|spot|choice)(?: is| would be)?)\\s*[,:：]?\\s*", rank: 2 },
  { src: "(?:^|[\\s，,。；;：:！!？?\\n])(?:Third(?:ly)?|Finally|Lastly|The third (?:one|option|place|spot|choice)(?: is| would be)?)\\s*[,:：]?\\s*", rank: 3 },
  // 阿拉伯数字编号：1. / 1、/ 1) / ①；(?!\d) 防止把 1.5公里 / 2.3km 当作编号
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n(（])(?:[1１]\\s*[、.．:：)）]|①)\\s*(?!\\d)", rank: 1 },
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n(（])(?:[2２]\\s*[、.．:：)）]|②)\\s*(?!\\d)", rank: 2 },
  { src: "(?:^|[\\s，,。；;：:！!？?、\\n(（])(?:[3３]\\s*[、.．:：)）]|③)\\s*(?!\\d)", rank: 3 }
];
const OPT_ORDINAL_RE = new RegExp(OPT_ORDINAL_MARKERS.map(m => "(" + m.src + ")").join("|"), "gi");

// 成对/列表连词
const OPT_CONJ_SRC = "(?:或者|或是|或|还是|以及|和|与|跟|及|、|\\s+(?:or|and)\\s+)";
// 推荐语境提示词（成对抽取必须有语境，防止把“超级树和温室非常震撼”误当两个地点）
const OPT_CUE_SRC = "(?:强烈推荐|特别推荐|首推|力荐|推荐|建议|可以选择|可以去|可以到|可以考虑|不妨去|不妨|值得一去的有|值得去的有|值得打卡的有|" +
  "试试|尝尝|看看|逛逛|前往|选择|考虑|打卡|包括|包含|分别是|分别为|想去|要去|去|挑了|找了|选了|" +
  "(?:景点|地点|地方|餐厅|咖啡馆|咖啡店|店|选择|选项|候选|去处|打卡点|公园|商场|目的地)\\s*(?:分别)?\\s*(?:有|是|为|包括)|" +
  "(?:附近|周边|旁边|这里|那里|还)有|例如|比如|像|如|" +
  "(?:I(?:'d| would)?\\s+)?(?:recommend(?:ing)?|suggest|try|visit|check out|head to|go to|options? (?:are|include)|either)\\s+)";
const OPT_PAIR_RE = new RegExp(
  OPT_CUE_SRC + "\\s*(?:两个|三个|两家|三家|两处|三处|几个|几家|几处|以下|如下|这两个|这几个)?\\s*[：:]?\\s*(?:你|您)?\\s*(?:去|试试|尝尝|打卡|看看|选择|考虑|逛逛)?\\s*" +
  "(" + OPT_NAME_SRC + "{2,40}?)" +
  "(?:\\s*[（(][^()（）]{1,40}[)）])?" +
  "\\s*" + OPT_CONJ_SRC + "\\s*" +
  "(" + OPT_NAME_SRC + "{2,40}?)" +
  "(?:\\s*[（(][^()（）]{1,40}[)）])?" +
  "(?:\\s*" + OPT_CONJ_SRC + "\\s*(" + OPT_NAME_SRC + "{2,40}?)(?:\\s*[（(][^()（）]{1,40}[)）])?)?" +
  "(?=[，,。；;！!？?：:\\n]|$)", "gi");
// 无语境提示词时，仅接受“A 还是 B？”疑问句或两端都带 POI 类型后缀的成对表达
const OPT_PAIR_BARE_RE = new RegExp(
  "(?:^|[，,。；;！!？?：:\\n])\\s*(?:你|您)?\\s*(?:想|要|打算|准备)?\\s*(?:去|选)?\\s*" +
  "(" + OPT_NAME_SRC + "{2,40}?)(?:\\s*[（(][^()（）]{1,40}[)）])?" +
  "\\s*(?:或者|或是|或|还是|和|与|跟|及)\\s*" +
  "(" + OPT_NAME_SRC + "{2,40}?)(?:\\s*[（(][^()（）]{1,40}[)）])?" +
  "(?:\\s*(?:或者|或是|或|还是|和|与|跟|及)\\s*(" + OPT_NAME_SRC + "{2,40}?)(?:\\s*[（(][^()（）]{1,40}[)）])?)?" +
  "\\s*(?:呢|吧)?\\s*(?=[？?]|[，,。；;！!：:\\n]|$)", "g");
const OPT_POI_SUFFIX_RE = /(?:公园|花园|植物园|动物园|水族馆|海洋馆|广场|博物馆|美术馆|艺术馆|纪念馆|科学馆|图书馆|展览馆|体育馆|中心|大厦|大楼|塔|寺|庙|宫|教堂|清真寺|神社|海滩|沙滩|岛|码头|港|湾|市场|巴刹|商场|购物中心|百货|老街|步行街|街|路|酒店|餐厅|餐馆|酒楼|食阁|熟食中心|咖啡|馆|园|桥|站|机场|乐园|世界|城|寨|村|古镇|山|湖|河|瀑布|观景台|天台|夜市|Park|Gardens?|Museum|Bay|Mall|Tower|Temple|Beach|Quay|Street|Hotel|Caf[eé]|Cent(?:er|re)|Square|Market|Bridge|Island|Zoo|Aquarium|Gallery|Plaza|Station|Airport|Harbou?r|Pier|Hill|Lake|River|Falls?|Palace|Castle|Shrine|Church|Cathedral|Mosque|Library|Stadium|Arena|Studio|Roasters|Bakery|Kitchen|Bar|Club|Lounge)$/i;

// 语义过滤：像句子/描述而非地名的候选一律拒绝
const OPT_SENTENCE_LIKE_RE = /(?:很|非常|特别|十分|挺|真的|超级|评分|评价|得分|营业|开放|距离|\d\s*(?:公里|千米|km|米|m|分钟|min)|步行|开车|骑行|驾车|路线|规划|导航|这里|那里|这个|那个|哪个|哪一|哪家|您|你|我|可以|都很|都是|也很|也是|不错|震撼|值得|适合|推荐|建议|想去|要去|带我|带您|带你|过去|一下|什么|怎么|如何|为什么|因为|所以|但是|不过|而且|然后|特色|主打|提供|供应|擅长|品质|出品|风味|口感|氛围|装修|人均|消费|采用|选用|吗|呢|吧|呀|哦|啦|嘛|了$)/;
const OPT_GENERIC_WORDS = new Set(["第一家", "第二家", "第一个", "第二个", "第一处", "第二处", "这里", "那里", "附近", "周边", "目的地", "地点", "景点", "地方", "餐厅", "咖啡馆", "咖啡店", "公园", "商场", "打卡点", "打卡景点", "热门景点", "推荐", "选项", "其他", "别的", "以上", "如下", "以下", "两个", "两家", "三个", "三家"]);

// 前置垃圾（循环剥离）：为您推荐 / 您可以去 / 建议 / 位于市中心的 / 热门的 ……
const OPT_LEAD_JUNK_RE = /^(?:(?:为|给)?(?:您|你|我们|大家|咱们)?\s*(?:强烈|特别|首先|其次|最后|另外|还|也|再|就|都|则)?\s*(?:[一-龥]{0,4}?(?:景点|地点|地方|餐厅|咖啡馆|咖啡店|选择|选项|候选|去处|打卡点|目的地|店)\s*(?:分别)?\s*(?:有|是|为|包括|包含)|推荐的是|推荐|建议|首推|力荐|可以选择|可以去|可以到|可以考虑|不妨去|不妨|值得一去的|值得去的|值得打卡的|建议去|推荐去|试试|尝尝|看看|逛逛|前往|选择|考虑|打卡|就是|则是|是|为|叫做|名为|当属|要数|包括|包含|例如|比如|去|到|(?:I(?:'d| would)?\s+)?(?:recommend(?:ing)?|suggest|try|visit|check out|head to|go to|either)\s+)\s*)+/i;
const OPT_LEAD_MOD_RE = /^(?:(?:位于|在|坐落于|坐落在)[^一-龥A-Za-z]*[一-龥A-Za-z0-9\s]{1,12}?的|(?:乌节路|克拉码头|滨海湾|百丽宫|高岛屋|义安城|牛车水|武吉士|麦士威|圣淘沙|登布西山|爱雍·?乌节|ION(?:\s*Orchard)?|联合广场|渔人码头|涉谷|银座|新宿|浅草|左岸|玛黑区|香榭丽舍)[一-龥A-Za-z0-9\s]*?的|(?:附近|周边|这片儿|这边)\s*(?:的)?\s*|(?:著名|知名|热门|人气|网红|经典|必去|必打卡|评分(?:最高|很高|极高|不错|排名靠前)|口碑(?:最好|很好|极佳)|离(?:您|你)?最近|最近|本地|当地|这里|那里|新开|老牌|标志性|地标性|超人气|超火|很火|非常火|历史悠久|风景优美|环境优美|超级|巨大|漂亮|美丽|壮观|有名|出名|最热门|最有名|最受欢迎|最经典|最值得去)的)\s*/;
// 后置垃圾：…都很不错 / …是新加坡的标志 / …尝尝经典粤菜 / …打卡海派本帮菜 / …了 / …这家 / …等
const OPT_TAIL_JUNK_RE = /(?:\s*(?:都很|都是|都不错|都值得|也很|也是|非常|特别|十分|真的|可以|值得|适合|评分|距离|离你|离您|位于|坐落|以其|凭借|因其|因为|作为|有着|拥有|是一|是个|是这|是您|是你|是我|是新|是本|是当|是当地|是全|是世界|是亚洲|是当之无愧|被誉为|号称|则是|就是|这家|这个|这座|这处|那家|那个|这两|这三|两家|两个|两处|三家|三个|三处|尝尝|试试|打卡|品尝|体验|感受|享用|(?:很|挺|也|太|超)(?:值得|不错|棒|好|美|漂亮|壮观|震撼|方便|近|远|有名|出名|热门|火|适合|推荐|建议|赞|可以|像|有|是|受欢迎))[\s\S]*|\s*(?:等等|等|之类|之一|了|吧|呢|哦|啦|呀|哈|嘛|吗))$/;

function optCityName() {
  try {
    if (typeof currentCity !== "undefined" && currentCity && currentCity.shortName) return String(currentCity.shortName);
  } catch (e) {}
  return "";
}

function optEscapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function optNormKey(s) { return String(s || "").toLowerCase().replace(/[\s\-·'’&\.]/g, ""); }
function optCharLen(s) { return Array.from(s || "").length; }

// 从 start 位置起截取到硬分隔符（括号内的分隔符忽略）/ stopAt / 文本末尾；返回是否被分隔符正常终止
function optTakeSegment(text, start, stopAt) {
  const end = Math.min(stopAt == null ? text.length : stopAt, text.length);
  let i = start, depth = 0;
  while (i < end) {
    const ch = text[i];
    if (ch === "(" || ch === "（") depth++;
    else if (ch === ")" || ch === "）") depth = Math.max(0, depth - 1);
    else if (depth === 0 && OPT_HARD_DELIM_RE.test(ch)) break;
    i++;
  }
  const terminated = i < end || (stopAt != null && end < text.length);
  return { seg: text.slice(start, i), terminated: terminated };
}

// 净化目的地实体名称 (剔除 markdown 加粗、代码、引号及两端标点)
function sanitizeDestinationName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/[*_~`"“”'‘’#]/g, " ")
    .replace(/^[^一-龥぀-ヿ가-힯A-Za-z0-9]+/, "")
    .replace(/[\s，。！？；、,.!?;:：]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 把口语片段清洗成 { name, destination } 或 null
function cleanPoiCandidate(rawSeg) {
  if (!rawSeg) return null;
  // 1) 彻底清洗 markdown 加粗、斜体、代码、引号符号
  let s = String(rawSeg).replace(/[​﻿]/g, "").replace(/[*_~`"“”'‘’#]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // 1) 评分/距离等粘连尾巴：滨海湾花园评分4.7分 / (4.7分) / 4.7分
  s = s.replace(/\s*(?:评分|评价|得分|好评率|星级)\s*[:：]?\s*\d[\d.]*.*$/, "");
  s = s.replace(/\s*[（(]\s*\d[\d.]*\s*(?:分|星)?\s*[)）]\s*$/, "");
  s = s.replace(/\s*\d\.\d+\s*(?:分|星).*$/, "");
  s = s.replace(/\s*\d+(?:\.\d+)?\s*(?:公里|千米|km|米|m|分钟|min)\b.*$/i, "");
  // 破折号式描述：滨海湾花园 - 超级树很震撼
  s = s.replace(/\s+[-—–]\s+.*$/, "");
  // 英文句号后接新句：Merlion Park. Both are great → Merlion Park
  s = s.replace(/\.\s+[A-Z][a-z].*$/, "");
  // 未闭合括号（流式截断或 ASR 漏掉右括号）
  s = s.replace(/\s*[（(][^)）]*$/, "");

  // 2) 中英双语括注拆分
  let cn = s, en = "";
  const bi = s.match(/^(.+?)\s*[（(]\s*([^()（）]+?)\s*[)）]\s*(.*)$/);
  if (bi) {
    const a = bi[1].trim(), b = bi[2].trim();
    const aCjk = /[一-龥]/.test(a), bCjk = /[一-龥]/.test(b);
    if (aCjk && !bCjk) { cn = a; en = b; }
    else if (!aCjk && bCjk) { cn = b; en = a; }
    else { cn = a; en = ""; }
  }

  // 3) 前置垃圾循环剥离（最多 4 轮，避免死循环）
  const city = optCityName();
  // 城市名只在后接“的/市区的/市中心的”时剥离；“新加坡摩天观景轮”“东京塔”这类专名保留城市前缀
  const cityRe = city ? new RegExp("^(?:" + optEscapeRe(city) + ")(?:市|市区|市中心|本地|当地)?的\\s*") : null;
  for (let k = 0; k < 4; k++) {
    const before = cn;
    cn = cn.replace(/^[^一-龥぀-ヿ가-힯A-Za-z0-9]+/, "");
    cn = cn.replace(OPT_LEAD_JUNK_RE, "");
    cn = cn.replace(OPT_LEAD_MOD_RE, "");
    if (cityRe) cn = cn.replace(cityRe, "");
    cn = cn.replace(/^的\s*/, "");
    if (cn === before) break;
  }
  // 4) 后置垃圾剥离（保证剥离后仍 ≥2 字，防止把“京都塔”切成“京”）
  for (let k = 0; k < 3; k++) {
    const before = cn;
    const m = cn.match(OPT_TAIL_JUNK_RE);
    if (m && m.index >= 2) cn = cn.slice(0, m.index);
    cn = cn.replace(/[\s，。！？；、,.!?;:：]+$/, "");
    if (cn === before) break;
  }
  cn = sanitizeDestinationName(cn);
  en = sanitizeDestinationName(en);

  // 5) 合法性校验
  const name = cn || en;
  if (!optIsValidPoiName(name)) return null;
  if (en && !optIsValidPoiName(en)) en = "";
  const destination = (cn && en) ? (cn + " " + en) : name;
  return { name: name, destination: destination, cn: cn, en: en };
}

function optIsValidPoiName(n) {
  if (!n) return false;
  const len = optCharLen(n);
  if (len < 2 || len > 30) return false;
  if (!/[一-龥぀-ヿ가-힯A-Za-z]/.test(n)) return false;
  if (OPT_GENERIC_WORDS.has(n)) return false;
  if (OPT_SENTENCE_LIKE_RE.test(n)) return false;
  if (/^(?:第[一二三123]|另一|另外|其次|首先|最后)/.test(n)) return false;
  // 情态/动词/形容词开头（“要开心”“保持健康”“多喝水”）：是建议句不是地名
  if (/^(?:要|得|应该|应当|需要|必须|不要|别|多|少|先|尽量|保持|注意|记得|学会|坚持|开心|健康|快乐|努力|好好|认真|早点|按时|避免|减少|增加|学习|工作|休息|睡觉|吃饭|喝水|运动|锻炼)/.test(n)) return false;
  // 拒绝纯品类词/描述性饮品美食词（如“意式咖啡”“单品咖啡”“手冲咖啡”“高品质的单品咖啡”）
  if (/^(?:(?:高品质|优质|精品|特色|招牌|传统|正宗|手工|现磨|纯正)的?)?(?:单品|意式|手冲|美式|拿铁|摩卡|卡布奇诺|冷萃|冰滴|特调|浓缩|黑|冰|热|速溶)?(?:咖啡|茶|奶茶|饮品|甜点|甜品|小吃|美食|料理|菜品|风味)$/.test(n)) return false;
  return true;
}

// 地点语境闸门：闲聊句“第一是要开心，第二是要健康”不应产出按键
const OPT_PLACE_CONTEXT_RE = /(?:推荐|建议|地点|景点|地方|去处|餐厅|餐馆|咖啡|馆|店|附近|周边|公里|千米|米外|打卡|评分|位于|路线|导航|前往|出发|地图|公园|花园|广场|博物馆|寺|庙|教堂|塔|街|路|湾|岛|海滩|码头|市场|商场|酒店|乐园|山|湖|Park|Garden|Museum|Bay|Mall|Tower|Temple|Beach|Quay|Street|Hotel|Caf[eé]|Cent(?:er|re)|Square|Market|recommend|suggest|visit|nearby|place|spot|restaurant|route|navigate)/i;
function optHasPlaceContext(text, cands) {
  if (OPT_PLACE_CONTEXT_RE.test(text)) return true;
  return (cands || []).some(c => OPT_POI_SUFFIX_RE.test(c.cn || c.name) || (c.en && OPT_POI_SUFFIX_RE.test(c.en)));
}

function optPickIcon(name, rawText) {
  const n = (name || "") + " " + (rawText || "").slice(0, 0);
  const t = name || "";
  if (/咖啡|Caf[eé]|Coffee|Roasters/i.test(t)) return "☕";
  if (/肉骨茶|鸡饭|海鲜|火锅|小吃|食阁|熟食中心|餐厅|餐馆|酒楼|料理|寿司|拉面|面馆|烧烤|美食|大排档|Kitchen|Restaurant|Bistro|Bak Kut Teh|Hawker/i.test(t)) return "🍲";
  if (/吐司|面包|烘焙|Toast|Bakery|Bread/i.test(t)) return "🥐";
  if (/酒吧|夜店|Bar$|Club|Lounge/i.test(t)) return "🍸";
  if (/公园|花园|植物园|湿地|Park|Gardens?/i.test(t)) return "🌳";
  if (/博物馆|美术馆|艺术馆|纪念馆|科学馆|展览|Museum|Gallery/i.test(t)) return "🏛️";
  if (/寺|庙|宫|教堂|清真寺|神社|Temple|Church|Cathedral|Mosque|Shrine/i.test(t)) return "⛩️";
  if (/塔|大厦|大楼|摩天|观景台|天台|Tower|Skyscraper|Observation/i.test(t)) return "🏙️";
  if (/海滩|沙滩|海边|岛|Beach|Island/i.test(t)) return "🏖️";
  if (/商场|购物中心|百货|市场|巴刹|Mall|Market|Plaza|Shopping/i.test(t)) return "🛍️";
  if (/酒店|Hotel|Resort/i.test(t)) return "🏨";
  if (/动物园|水族馆|海洋馆|Zoo|Aquarium/i.test(t)) return "🐾";
  if (/乐园|环球影城|Universal|Disney|Studios?/i.test(t)) return "🎢";
  if (/机场|Airport/i.test(t)) return "✈️";
  if (/车站|地铁站|Station/i.test(t)) return "🚉";
  if (rawText && /咖啡/.test(rawText) && !/公园|花园|博物馆|寺|塔/.test(t)) return "☕";
  return "📍";
}

// 把候选加入结果（去重 + 包含关系去重 + 上限）
function optPush(opts, cand, rawText) {
  if (!cand || opts.length >= OPT_MAX_ITEMS) return false;
  const key = optNormKey(cand.name);
  const keyEn = optNormKey(cand.en);
  for (const o of opts) {
    const ok = optNormKey(o.name), oe = optNormKey(o.en);
    if (key === ok || (keyEn && keyEn === oe) || ok.includes(key) || key.includes(ok) || (keyEn && oe && (oe.includes(keyEn) || keyEn.includes(oe)))) return false;
  }
  opts.push({ name: cand.name, destination: cand.destination, cn: cand.cn, en: cand.en, icon: optPickIcon(cand.name, rawText) });
  return true;
}

// Google Maps grounding 标题列表
function optMapsTitles(groundingMetadata) {
  const out = [];
  try {
    const chunks = (groundingMetadata && groundingMetadata.groundingChunks) || [];
    chunks.forEach(c => {
      const t = c && c.maps && c.maps.title ? String(c.maps.title).trim() : "";
      if (t && !out.includes(t)) out.push(t);
    });
  } catch (e) {}
  return out;
}

// 用 grounding 权威标题对齐口语名：口语名（中或英）被标题包含或包含标题 → destination 采用权威标题
function optAlignWithMaps(opts, titles) {
  if (!titles || !titles.length) return opts;
  return opts.map(o => {
    const kc = optNormKey(o.cn || o.name), ke = optNormKey(o.en);
    const hit = titles.find(t => {
      const kt = optNormKey(t);
      return kt && (kt === kc || kt === ke || (kc.length >= 2 && kt.includes(kc)) || (ke.length >= 3 && kt.includes(ke)) || (kt.length >= 3 && (kc.includes(kt) || ke.includes(kt))));
    });
    return hit ? Object.assign({}, o, { destination: hit, mapsTitle: hit }) : o;
  });
}

// ---- 规则 1：显式标记 【推荐选项：A | B】（容忍 ASR 变体：推荐选项：A、B / 推荐选项，A，B）----
function optExtractByTag(text, rawText, isFinal) {
  const opts = [];
  const re = /(?:【\s*)?(?:推荐|快捷|候选)选项\s*[：:，,]?\s*([^】\n。！？!?]+)(】)?/g;
  let m;
  while ((m = re.exec(text)) && opts.length < OPT_MAX_ITEMS) {
    const body = m[1] || "";
    const closed = !!m[2] || (m.index + m[0].length < text.length);
    if (!isFinal && !closed) break;               // 流式：标记尚未闭合，等下一帧
    let parts = body.split(/\s*[|｜/／、]\s*|\s*[,，；;]\s*/).filter(Boolean);
    if (parts.length < 2) parts = body.split(/\s*(?:或者|或是|或|还是|和|以及|与|跟|及)\s*/).filter(Boolean);
    parts.forEach(p => optPush(opts, cleanPoiCandidate(p), rawText));
  }
  return opts;
}

// ---- 规则 2：序数口语 第一家是…第二家是… / 首先…其次… / 一是…二是… / 一个是…另一个是… / 1. 2. ----
function optExtractByOrdinal(text, rawText, isFinal) {
  const markers = [];
  OPT_ORDINAL_RE.lastIndex = 0;
  let m;
  while ((m = OPT_ORDINAL_RE.exec(text))) {
    let rank = 0;
    for (let g = 1; g < m.length; g++) { if (m[g] !== undefined) { rank = OPT_ORDINAL_MARKERS[g - 1].rank; break; } }
    if (!rank) continue;
    markers.push({ rank: rank, start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) OPT_ORDINAL_RE.lastIndex++;
  }
  if (markers.length < 2) return [];

  const byRank = {};
  markers.forEach((mk, i) => {
    // 跳过标记后紧跟的空白/冒号/逗号（“首先，滨海湾花园”）
    let s = mk.end;
    while (s < text.length && /[\s，,：:]/.test(text[s])) s++;
    const nextStart = i + 1 < markers.length ? markers[i + 1].start : null;
    const { seg, terminated } = optTakeSegment(text, s, nextStart);
    if (!isFinal && !terminated) return;           // 流式：半个名字，等下一帧
    const cand = cleanPoiCandidate(seg);
    if (cand && !byRank[mk.rank]) byRank[mk.rank] = cand;
  });
  const opts = [];
  [1, 2, 3].forEach(r => { if (byRank[r]) optPush(opts, byRank[r], rawText); });
  if (opts.length >= 2 && !optHasPlaceContext(text, opts)) return [];
  return opts;
}

// ---- 规则 3：成对/列表连词  推荐 A 或者 B / 包括 A、B 和 C / 您想去 A 还是 B？ ----
function optExtractByPair(text, rawText, isFinal) {
  if (!isFinal && /(?:第[一二12][家个处]|首先|第一点)/.test(text)) return [];
  const opts = [];
  const tryRe = (re, bare) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && opts.length < OPT_MAX_ITEMS) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const endsAtEof = m.index + m[0].length >= text.length;
      if (!isFinal && endsAtEof) continue;         // 流式：最后一个名字可能还没说完
      const cands = [m[1], m[2], m[3]].filter(Boolean).map(cleanPoiCandidate).filter(Boolean);
      if (cands.length < 2) continue;
      if (bare) {
        const nextCh = text[m.index + m[0].length] || "";
        const isQuestion = /[？?]/.test(nextCh);
        const allPoiLike = cands.every(c => OPT_POI_SUFFIX_RE.test(c.cn || c.name) || (c.en && OPT_POI_SUFFIX_RE.test(c.en)));
        if (!isQuestion && !allPoiLike) continue;
      }
      const tmp = [];
      cands.forEach(c => optPush(tmp, c, rawText));
      if (tmp.length >= 2) { tmp.forEach(c => optPush(opts, c, rawText)); }
    }
  };
  tryRe(OPT_PAIR_RE, false);
  if (opts.length < 2) { opts.length = 0; tryRe(OPT_PAIR_BARE_RE, true); }
  if (opts.length >= 2 && !optHasPlaceContext(text, opts)) return [];
  return opts;
}

/**
 * 从 Gemini Live 实时转写文本 + Google Maps grounding 中抽取 2~3 个候选目的地。
 * @param {string} rawText
 * @param {object|null} groundingMetadata
 * @param {{final?: boolean}} [options]  final=true 表示本轮已 turnComplete，允许接受未被标点终止的尾段
 * @returns {Array<{name:string, destination:string, icon:string}>}
 */
function extractRealtimeOptions(rawText, groundingMetadata, options) {
  const isFinal = !!(options && options.final);
  if (!rawText || typeof rawText !== "string") return [];
  // 预清洗：去掉“正在思考…”前缀、（已打断）尾巴、全角空格
  const text = rawText
    .replace(/^(?:正在思考与实时检索中[…\.]*|思考中[…\.]*|正在收听[…\.]*)+/g, "")
    .replace(/（已打断）$/g, "")
    .replace(/　/g, " ");
  if (!text.trim()) return [];

  const titles = optMapsTitles(groundingMetadata);
  const rules = [optExtractByTag, optExtractByOrdinal, optExtractByPair];
  for (const rule of rules) {
    let opts = [];
    try { opts = rule(text, rawText, isFinal); } catch (e) { console.warn("[QuickOption] rule error:", rule.name, e); }
    if (opts.length >= 2) {
      opts = optAlignWithMaps(opts, titles).slice(0, OPT_MAX_ITEMS);
      opts.__rule = rule.name;
      return opts;
    }
  }

  // ---- 规则 4：Google Maps grounding 实体兜底（文本规则全部失败时才用，避免把模型没提到的地点也列出来）----
  if (titles.length >= 2) {
    const opts = [];
    titles.forEach(t => {
      // 只保留模型确实提到过的实体（中英任一片段出现在转写里）；若一个都对不上，则退化为全部标题
      opts.push({ name: t, destination: t, cn: /[一-龥]/.test(t) ? t : "", en: /[一-龥]/.test(t) ? "" : t, icon: optPickIcon(t, rawText) });
    });
    const mentioned = opts.filter(o => {
      const k = optNormKey(o.name);
      const tokens = o.name.split(/[\s\-·]+/).filter(w => w.length >= 4);
      return optNormKey(text).includes(k) || tokens.some(w => new RegExp(optEscapeRe(w), "i").test(text));
    });
    const chosen = (mentioned.length >= 2 ? mentioned : opts).slice(0, OPT_MAX_ITEMS);
    chosen.__rule = "maps";
    return chosen;
  }
  return [];
}


// 绑定全新全屏语音助手交互 (微型胶囊点击 / 关闭按钮 / 输入对讲)
function initV56AssistantEvents() {
  // 1. 关闭按钮 -> 切回地图
  if ($("btnAstClose")) {
    $("btnAstClose").onclick = () => {
      if ($("btnTabConsole")) $("btnTabConsole").click();
    };
  }

  // 2. 动态渲染当前城市专属快捷演示胶囊并绑定事件
  renderAssistantDemoCapsules(currentCity);

  // 3. 全屏助手底部文字与麦克风输入
  if ($("astBtnSend") && $("astInputText")) {
    $("astBtnSend").onclick = () => {
      resumeAudioIfNeeded();
      const val = $("astInputText").value.trim();
      if (val) {
        sendQuery(val);
        $("astInputText").value = "";
      }
    };
    $("astInputText").onkeydown = (e) => {
      if (e.key === "Enter") {
        resumeAudioIfNeeded();
        const val = $("astInputText").value.trim();
        if (val) {
          sendQuery(val);
          $("astInputText").value = "";
        }
      }
    };
  }

  if ($("astBtnMic")) {
    $("astBtnMic").onclick = () => {
      resumeAudioIfNeeded();
      toggleVoiceRecording("assistant");
    };
  }
}

// 全局手势前置唤醒 Web Audio（只要用户在页面上有任意点击/触摸/按键，立即解除浏览器 suspended 限制）
if (typeof window !== "undefined") {
  ["pointerdown", "touchstart", "keydown"].forEach(evt => {
    window.addEventListener(evt, () => {
      try { resumeAudioIfNeeded(); } catch (e) {}
    }, { passive: true });
  });
}

// 页面加载完成后初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initV56AssistantEvents);
} else {
  initV56AssistantEvents();
}
