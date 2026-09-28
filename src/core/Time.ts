import { PHYSICS_CONFIG } from '../config';

/**
 * 时间控制 + 固定步长累加器。
 *
 * 设计要点（后续里程碑直接受益）：
 * - 物理/模拟走固定步长（1/60 s），渲染走真实帧率，两者分离；
 * - 暂停时仍允许"单步"推进 N 个固定步；
 * - 单帧最多追赶 maxSubSteps 步，避免切后台回来时爆炸；
 * - `alpha` 是剩余插值系数，M3 接入 Rapier 后可做渲染插值。
 */
export class Time {
  /** 固定步长（秒） */
  readonly fixedStep = PHYSICS_CONFIG.fixedTimeStep;
  /** 单帧最大追赶步数 */
  readonly maxSubSteps = PHYSICS_CONFIG.maxSubSteps;

  /** 模拟世界已流逝的时间（秒）—— 只被固定步推进 */
  elapsed = 0;
  /** 已执行的固定步总数 */
  stepCount = 0;
  /** 上一帧执行了多少个固定步 */
  lastStepBatch = 0;
  /** 插值系数 0~1（accumulator / fixedStep） */
  alpha = 0;

  private accumulator = 0;
  private scaleValue = 1;
  private pausedValue = false;
  private pendingSteps = 0;

  /** 时间倍速：1 / 2 / 4 */
  get scale(): number {
    return this.scaleValue;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  setScale(scale: number): void {
    this.scaleValue = Math.max(0, scale);
  }

  setPaused(paused: boolean): void {
    if (this.pausedValue === paused) return;
    this.pausedValue = paused;
    // 暂停时清空累计，避免恢复瞬间补跑一大段
    this.accumulator = 0;
    this.pendingSteps = 0;
  }

  togglePause(): void {
    this.setPaused(!this.pausedValue);
  }

  /** 请求在暂停状态下单步推进 count 个固定步 */
  requestStep(count = 1): void {
    this.pendingSteps += Math.max(1, Math.floor(count));
  }

  /**
   * 用真实帧间隔推进时间。
   * @param realDelta 真实帧间隔（秒）
   * @param onFixedStep 每个固定步的回调（物理/水/沙模拟挂在这里）
   * @returns 本帧执行的固定步数
   */
  advance(realDelta: number, onFixedStep: (dt: number) => void): number {
    let steps = 0;

    if (this.pausedValue) {
      // 暂停：只消费显式请求的单步
      while (this.pendingSteps > 0) {
        this.pendingSteps--;
        onFixedStep(this.fixedStep);
        this.elapsed += this.fixedStep;
        this.stepCount++;
        steps++;
        // 单步一次最多追 8 步，防止连点后长时间卡住
        if (steps >= 8) break;
      }
      this.accumulator = 0;
      this.alpha = 0;
      this.lastStepBatch = steps;
      return steps;
    }

    const scaled = realDelta * this.scaleValue;
    // 限制单帧可累计的真实时间，避免浏览器切回前台时"时间跳跃"
    this.accumulator += Math.min(scaled, this.fixedStep * this.maxSubSteps * 4);

    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.accumulator -= this.fixedStep;
      onFixedStep(this.fixedStep);
      this.elapsed += this.fixedStep;
      this.stepCount++;
      steps++;
    }

    // 追赶不上时丢弃多余累计时间（宁可慢放，也不要无限堆积）
    if (this.accumulator > this.fixedStep * this.maxSubSteps) {
      this.accumulator = 0;
    }

    this.alpha = this.accumulator / this.fixedStep;
    this.lastStepBatch = steps;
    return steps;
  }

  reset(): void {
    this.elapsed = 0;
    this.stepCount = 0;
    this.lastStepBatch = 0;
    this.accumulator = 0;
    this.alpha = 0;
    this.pendingSteps = 0;
  }
}
