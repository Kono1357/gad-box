/**
 * 智能放置时的「相机平滑跟随」（纯逻辑，**不依赖 Three.js / DOM / Engine**）。
 *
 * 解决的问题：
 * 智能放置会给出一串候选点，光标一动候选点就会跳。如果每帧把相机注视点直接设成
 * 候选点，画面会"啪"地跳过去；完全不跟又得让玩家自己把镜头挪过去。
 * 这里把"相机该怎么动"抽成一段纯数学：
 *   - `track(point, nowMs)` 告诉它"从现在起跟这个点"；
 *   - `update(nowMs)` 每帧给出"这一帧应该写给相机的注视点"，
 *     到达后返回 `null` —— 返回 null 表示**不再干预相机**，玩家可以自由操作；
 *   - 玩家一拖鼠标 / 按 WASD，Engine 调 `cancel('manual')` 立刻撒手，
 *     绝不在玩家操作时抢镜头，这是"跟随"能不能用的关键。
 *
 * 设计要点：
 * 1. **时间完全由传入的 `nowMs` 驱动**（不用 setTimeout / requestAnimationFrame），
 *    所以可以在 Node 里用假时钟做单元测试，也不受物理暂停 / 掉帧影响；
 * 2. 缓动是**指数收敛**（临界阻尼一阶平滑 `1 - exp(-dt / smoothSeconds * k)`），
 *    与帧率无关：60 Hz 与 30 Hz 的收敛曲线一致，掉帧不会"少走一段"；
 * 3. 首帧 `dt` 夹到 0.1 s：切后台 / 断点调试回来时不至于一帧飞到位；
 * 4. 起点是"上一次写出的注视点"，所以候选点连续切换时镜头是连贯的；
 *    第一次跟随没有历史起点，直接以目标为起点（否则相机会从世界原点飞过来）。
 */

/** 跟随目标点（刻意不用 Three.js 的 Vector3，便于 Node 单测） */
export interface TrackPoint {
  x: number;
  y: number;
  z: number;
}

export interface CameraTrackerOptions {
  /** 平滑时间（秒），默认 0.3 —— 用户要求「0.3 秒平滑」 */
  smoothSeconds?: number;
  /** 死区：目标移动小于该距离（米）就不重新跟随，默认 0.5 */
  deadZone?: number;
  /** 跟随期间相机到目标的水平距离上限（米），超过就不再靠近，默认 60 */
  maxFollowDistance?: number;
}

/** 跟随被中断的原因（最后一次） */
export type TrackCancelReason = 'manual' | 'disabled' | 'target-missing' | 'replaced' | 'finished';

const DEFAULT_SMOOTH_SECONDS = 0.3;
const DEFAULT_DEAD_ZONE = 0.5;
const DEFAULT_MAX_FOLLOW_DISTANCE = 60;

/**
 * 平滑系数。指数收敛的剩余量是 `exp(-t / smoothSeconds * SMOOTH_K)`：
 * 取 4.5 时，`smoothSeconds`（默认 0.3 s）过去后只剩 1.1% —— 手感上就是"0.3 秒到位"。
 */
const SMOOTH_K = 4.5;

/** 单帧最大时间步（秒）：防止切后台回来后一帧跳到位 */
const MAX_FRAME_DT = 0.1;

/** 到位阈值（米）：小于它就认为已经贴上目标 */
const ARRIVE_EPSILON = 0.02;

export class CameraTracker {
  private readonly smoothSeconds: number;
  private readonly deadZone: number;
  private readonly maxFollowDistance: number;

  /** 总开关：关掉后 track / update 都不做事 */
  private enabledFlag = true;
  private tracking = false;
  private targetPoint: TrackPoint | null = null;
  /** 上一次写出的注视点（下一次跟随的起点，跨多次跟随保留，保证镜头连贯） */
  private readonly current: TrackPoint = { x: 0, y: 0, z: 0 };
  private hasCurrent = false;
  /** 本次跟随的初始距离，用来算 progress */
  private startDistance = 0;
  private lastMs: number | null = null;
  private cancelReason: TrackCancelReason | null = null;
  private count = 0;

  constructor(options: CameraTrackerOptions = {}) {
    this.smoothSeconds = Math.max(1e-3, options.smoothSeconds ?? DEFAULT_SMOOTH_SECONDS);
    this.deadZone = Math.max(0, options.deadZone ?? DEFAULT_DEAD_ZONE);
    this.maxFollowDistance = Math.max(0, options.maxFollowDistance ?? DEFAULT_MAX_FOLLOW_DISTANCE);
  }

  /** 现在是否正在跟随 */
  get isTracking(): boolean {
    return this.tracking;
  }

  /** 平滑进度 0..1（1 = 已到位）。未跟随时恒为 1 —— 没有要走的路 */
  get progress(): number {
    const target = this.targetPoint;
    if (!this.tracking || !target) return 1;
    if (this.startDistance <= ARRIVE_EPSILON) return 1;
    const remaining = distanceBetween(this.current, target);
    return clamp01(1 - remaining / this.startDistance);
  }

  /** 当前跟随目标（未跟随时为 null） */
  get target(): TrackPoint | null {
    return this.targetPoint;
  }

  /** 被中断的原因（最后一次），未中断过为 null */
  get lastCancelReason(): TrackCancelReason | null {
    return this.cancelReason;
  }

  /** 累计跟随次数，便于调试面板显示 */
  get trackCount(): number {
    return this.count;
  }

  /**
   * 开始跟随目标。重复调用同一个（死区内）目标不会重启动画。
   *
   * 死区按**三维距离**算：y 方向换一层（叠罗汉）也算"目标动了"。
   * 只有"正在跟随"时才做死区判断 —— 已经到位后再 track 同一个点，
   * 说明玩家确实想再跟一次，不拦。
   */
  track(target: TrackPoint, nowMs: number): void {
    if (!this.enabledFlag) return;
    // 防御：坐标 / 时间戳是 NaN 时直接忽略，别让 NaN 顺着插值污染相机
    if (!isFinitePoint(target) || !Number.isFinite(nowMs)) return;

    if (this.tracking && this.targetPoint) {
      if (distanceBetween(this.targetPoint, target) < this.deadZone) return;
      // 旧目标被更远的新目标顶掉：记下原因，调试面板能看出"为什么镜头换了方向"
      this.cancelReason = 'replaced';
    }

    if (!this.hasCurrent) {
      // 第一次跟随没有历史起点，直接以目标为起点，避免相机从世界原点横穿地图飞过来
      this.current.x = target.x;
      this.current.y = target.y;
      this.current.z = target.z;
      this.hasCurrent = true;
    }

    this.targetPoint = { x: target.x, y: target.y, z: target.z };
    this.tracking = true;
    this.lastMs = nowMs;
    this.limitFollowDistance();
    this.startDistance = Math.max(ARRIVE_EPSILON, distanceBetween(this.current, this.targetPoint));
    this.count += 1;
  }

  /**
   * 每帧推进。返回「本帧应该写给相机的注视点」；
   * 已到位或未跟随时返回 null（= 不再干预相机）。
   *
   * 返回的是新对象（不是内部状态），调用方随便改都不会污染跟随状态。
   */
  update(nowMs: number): TrackPoint | null {
    if (!this.enabledFlag || !this.tracking) return null;
    const target = this.targetPoint;
    if (!target) return null;

    const dt = this.consumeDt(nowMs);
    // 指数收敛系数：dt = 0 时一动不动（同一帧被调两次也不会白走）
    const ratio = dt > 0 ? 1 - Math.exp((-dt / this.smoothSeconds) * SMOOTH_K) : 0;

    this.current.x += (target.x - this.current.x) * ratio;
    this.current.y += (target.y - this.current.y) * ratio;
    this.current.z += (target.z - this.current.z) * ratio;

    if (distanceBetween(this.current, target) < ARRIVE_EPSILON) {
      // 到位：写回最终点（避免指数收敛永远差一点点），然后撒手交给玩家
      this.current.x = target.x;
      this.current.y = target.y;
      this.current.z = target.z;
      this.tracking = false;
      this.targetPoint = null;
      this.lastMs = null;
      this.cancelReason = 'finished';
      return { x: this.current.x, y: this.current.y, z: this.current.z };
    }

    return { x: this.current.x, y: this.current.y, z: this.current.z };
  }

  /** 中断跟随（玩家手动操作相机时由 Engine 调用） */
  cancel(reason: TrackCancelReason = 'manual'): void {
    // 没在跟就不算"中断"，不记录原因，免得调试面板被无意义的原因刷屏
    if (!this.tracking) return;
    this.tracking = false;
    this.targetPoint = null;
    this.lastMs = null;
    this.cancelReason = reason;
  }

  /** 总开关（关掉后 track/update 都不做事） */
  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
    if (!enabled) this.cancel('disabled');
  }

  /** 复位到初始状态（总开关属于用户偏好，复位时不动它） */
  reset(): void {
    this.tracking = false;
    this.targetPoint = null;
    this.current.x = 0;
    this.current.y = 0;
    this.current.z = 0;
    this.hasCurrent = false;
    this.startDistance = 0;
    this.lastMs = null;
    this.cancelReason = null;
    this.count = 0;
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 水平距离上限。
   *
   * 候选点偶尔会突然跳很远（换支撑物、切区块）。若照常平滑，注视点会从原地
   * 慢慢"飘"过去，相机会横穿整张地图，玩家只觉得镜头失控。
   * 所以：一旦水平距离超过 `maxFollowDistance`，就把注视点直接拉到以目标为中心、
   * 半径 = maxFollowDistance 的水平圆上，从那里开始平滑（先到位，再跟随）。
   * 这样"跟随期间相机到目标的水平距离"始终不超过上限。
   */
  private limitFollowDistance(): void {
    const target = this.targetPoint;
    if (!target) return;
    const dx = this.current.x - target.x;
    const dz = this.current.z - target.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= this.maxFollowDistance || horizontal < 1e-6) return;
    const scale = this.maxFollowDistance / horizontal;
    this.current.x = target.x + dx * scale;
    this.current.z = target.z + dz * scale;
  }

  /** 取出本帧 dt（秒），夹到 [0, MAX_FRAME_DT] */
  private consumeDt(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    const previous = this.lastMs;
    this.lastMs = nowMs;
    if (previous === null) return 0;
    const dt = (nowMs - previous) / 1000;
    // 时钟回拨 / 同一毫秒内重复调用：当作没走时间
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    return Math.min(dt, MAX_FRAME_DT);
  }
}

function distanceBetween(a: TrackPoint, b: TrackPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isFinitePoint(point: TrackPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
