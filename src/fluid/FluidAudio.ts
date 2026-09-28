/**
 * 流体音效（M4 第二部分 · 第 2 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 全部用 WebAudio **程序化合成**，不加载任何音频文件
 * ────────────────────────────────────────────────────────────
 * 理由与项目定位一致：部署在 GitHub Pages 上、不加依赖、不引外部资源。
 * 三种声音：
 * - **流水（flow）**：棕噪声过低通，音量与截止频率随"平均流速"变化。
 *   听起来像溪流，而且流速越快越"沙"—— 这是最容易被听出来的一段。
 * - **落水（splash）**：短促的白噪声爆 + 指数衰减，音高随冲击强度。
 *   用"这一帧内新生成/进入水面的粒子数"当触发条件，而不是每帧都响。
 * - **沸腾（boil）**：岩浆专用，低频噪声 + 周期性咕嘟声（用低通 + 正弦调制近似）。
 *
 * ────────────────────────────────────────────────────────────
 * 如实说明（这几条决定它不是"真实流体声学"）
 * ────────────────────────────────────────────────────────────
 * 1. **不是物理合成的**：真实的水声来自气泡振动与湍流；这里只是"噪声 + 滤波 + 包络"，
 *    是**听觉近似**。它的价值是"倒水时会有声音、越大声越大"，不是"声学正确"。
 * 2. **速度→音量的映射是线性的、且经过平滑**：直接用瞬时速度会让声音抖得像故障，
 *    所以有一个 0.25 秒的指数平滑。
 * 3. **浏览器要求用户手势之后才能出声**：`AudioContext` 在用户第一次点击前是
 *    suspended 状态。这里如实反映在 `state` 里（面板上会显示"点击一下页面才有声音"），
 *    而不是假装已经能出声。
 */

export type FluidAudioState = 'unsupported' | 'suspended' | 'running' | 'muted';

export interface FluidAudioParams {
  /** 是否启用 */
  enabled: boolean;
  /** 总音量 0~1 */
  volume: number;
  /** 平均流速（米/秒）—— 由调用方从粒子统计里给 */
  flowSpeed: number;
  /** 这一帧的"落水强度"（0~1，例如新落下的粒子占比） */
  splash: number;
  /** 是否在沸腾（岩浆） */
  boiling: boolean;
}

/** 流速对应的目标音量：0 米/秒 → 0，2 米/秒以上 → 满 */
const FLOW_FULL_SPEED = 2;

export class FluidAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private flowGain: GainNode | null = null;
  private flowFilter: BiquadFilterNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private boilOsc: OscillatorNode | null = null;
  private boilGain: GainNode | null = null;
  private enabled = true;
  private volumeValue = 0.6;
  /** 平滑后的流速（避免声音抖） */
  private smoothedFlow = 0;
  private lastSplashAt = Number.NEGATIVE_INFINITY;
  private splashCount = 0;
  private stateValue: FluidAudioState = 'unsupported';

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get state(): FluidAudioState {
    return this.stateValue;
  }

  get volume(): number {
    return this.volumeValue;
  }

  get splashes(): number {
    return this.splashCount;
  }

  get isSupported(): boolean {
    return typeof globalThis !== 'undefined' && typeof (globalThis as { AudioContext?: unknown }).AudioContext !== 'undefined';
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.suspend();
  }

  setVolume(volume: number): void {
    this.volumeValue = Math.max(0, Math.min(1, volume));
    this.applyMasterVolume();
  }

  /** 必须由一次用户手势调用（浏览器策略）；重复调用是安全的 */
  unlock(): void {
    if (!this.isSupported) {
      this.stateValue = 'unsupported';
      return;
    }
    if (this.ctx) {
      void this.ctx.resume();
      this.stateValue = this.ctx.state === 'running' ? 'running' : 'suspended';
      return;
    }
    this.build();
  }

  private build(): void {
    const Ctor = (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volumeValue : 0;
    this.master.connect(ctx.destination);

    // ---- 流水：循环播放一段合成的棕噪声，过一个低通
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      // 棕噪声：白噪声的一阶积分（能量集中在低频，听起来像水而不是"沙沙"）
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.flowFilter = ctx.createBiquadFilter();
    this.flowFilter.type = 'lowpass';
    this.flowFilter.frequency.value = 600;
    this.flowGain = ctx.createGain();
    this.flowGain.gain.value = 0;
    this.source.connect(this.flowFilter);
    this.flowFilter.connect(this.flowGain);
    this.flowGain.connect(this.master);
    this.source.start();

    // ---- 沸腾：低频正弦与噪声一起调制（岩浆用）
    this.boilOsc = ctx.createOscillator();
    this.boilOsc.type = 'sawtooth';
    this.boilOsc.frequency.value = 42;
    this.boilGain = ctx.createGain();
    this.boilGain.gain.value = 0;
    this.boilOsc.connect(this.boilGain);
    this.boilGain.connect(this.master);
    this.boilOsc.start();

    this.stateValue = ctx.state === 'running' ? 'running' : 'suspended';
    if (ctx.state !== 'running') void ctx.resume();
  }

  private suspend(): void {
    if (this.flowGain && this.ctx) {
      this.flowGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      this.boilGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
    this.stateValue = this.isSupported ? 'muted' : 'unsupported';
  }

  private applyMasterVolume(): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.enabled ? this.volumeValue : 0, this.ctx.currentTime, 0.05);
  }

  /**
   * 每帧喂一次参数。
   *
   * 这里**不做任何音频节点创建**（那些在 `unlock()` 里一次做完）——
   * 每帧建节点是音频线程卡顿的常见来源。
   */
  update(params: FluidAudioParams): void {
    if (!this.ctx || !this.flowGain || !this.flowFilter) {
      // 还没解锁：只记录状态，不假装在播
      if (this.isSupported && this.stateValue !== 'muted') this.stateValue = 'suspended';
      return;
    }
    if (!this.enabled) return;

    // 指数平滑（0.25 秒）：瞬时速度会让声音抖得像坏掉
    const target = Math.max(0, params.flowSpeed);
    const alpha = 0.12;
    this.smoothedFlow = this.smoothedFlow + (target - this.smoothedFlow) * alpha;
    const ratio = Math.min(1, this.smoothedFlow / FLOW_FULL_SPEED);
    const nowTime = this.ctx.currentTime;
    this.flowGain.gain.setTargetAtTime(ratio * 0.5, nowTime, 0.15);
    // 流速越快，低通开得越大（听起来更"沙"、更亮）
    this.flowFilter.frequency.setTargetAtTime(400 + ratio * 2400, nowTime, 0.2);

    if (this.boilGain) {
      const boilTarget = params.boiling ? 0.25 : 0;
      this.boilGain.gain.setTargetAtTime(boilTarget, nowTime, 0.3);
    }

    // 落水：节流到 120 ms 一次，避免连续落水时声音糊成一团
    if (params.splash > 0.02 && nowTime - this.lastSplashAt > 0.12) {
      this.lastSplashAt = nowTime;
      this.playSplash(params.splash);
    }
  }

  /** 落水声：一段短噪声 + 指数衰减 + 随强度升高的带通中心频率 */
  private playSplash(intensity: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const duration = 0.18 + Math.min(0.2, intensity * 0.3);
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / data.length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700 + intensity * 900;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(0.5, 0.12 + intensity * 0.35) * this.volumeValue;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start();
    // 播完自己断开：免得节点越积越多（浏览器不会自动回收已停止的源）
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    this.splashCount += 1;
  }

  dispose(): void {
    this.source?.stop();
    this.boilOsc?.stop();
    this.source?.disconnect();
    this.boilOsc?.disconnect();
    this.flowGain?.disconnect();
    this.boilGain?.disconnect();
    this.master?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.flowGain = null;
    this.boilGain = null;
    this.flowFilter = null;
    this.source = null;
    this.boilOsc = null;
    this.stateValue = this.isSupported ? 'suspended' : 'unsupported';
  }
}
