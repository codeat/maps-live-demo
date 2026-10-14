/* static/pcm-capture-worklet.js
 * AudioWorklet 处理器：把麦克风 Float32 采样流转换成 16 kHz / 16-bit / 单声道 PCM 帧，
 * 每帧同时携带 RMS 能量，供主线程的残余回声门限使用。
 *
 * - 若 AudioContext 已经是 16 kHz（Chrome/Firefox/Safari 均支持 new AudioContext({sampleRate:16000})），
 *   则直接透传；否则用带跨块相位累加器的线性插值重采样（48k→16k 质量对语音识别完全够用）。
 * - 输出通过 postMessage 转移所有权（零拷贝）。
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    const frameMs = o.frameMs || 40;
    this.frameSamples = Math.round(this.targetRate * frameMs / 1000);
    this.ratio = sampleRate / this.targetRate; // sampleRate 为 worklet 全局量（上下文采样率）
    this.pos = 0;    // 重采样读指针（相对当前输入块的小数索引，允许落在 [-1, 0)）
    this.prev = 0;   // 上一块的最后一个采样，用于跨块插值
    this._newFrame();
  }

  _newFrame() {
    this.buf = new Int16Array(this.frameSamples);
    this.n = 0;
    this.sumSq = 0;
  }

  _push(s) {
    if (s > 1) s = 1; else if (s < -1) s = -1;
    this.sumSq += s * s;
    this.buf[this.n++] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
    if (this.n >= this.frameSamples) {
      const rms = Math.sqrt(this.sumSq / this.frameSamples);
      const pcm = this.buf.buffer;
      this.port.postMessage({ pcm, rms }, [pcm]);
      this._newFrame();
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    const n = ch.length;
    if (!n) return true;

    if (this.ratio === 1) {
      for (let i = 0; i < n; i++) this._push(ch[i]);
      return true;
    }

    // 线性插值重采样：需要 ch[i0] 与 ch[i0+1]，因此 pos < n-1；剩余相位带入下一块
    let pos = this.pos;
    while (pos + 1 < n) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? this.prev : ch[i0];
      const s1 = ch[i0 + 1];
      this._push(s0 + (s1 - s0) * frac);
      pos += this.ratio;
    }
    this.pos = pos - n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
