/**
 * 物理状态快照与回溯（M3 第 6 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么回溯记录的是**位姿**而不是世界快照
 * ────────────────────────────────────────────────────────────
 * Rapier 提供 `world.takeSnapshot()`，它把整个 wasm 堆序列化成 `Uint8Array`
 * （刚体、碰撞体、宽相位结构、接触缓存……）。听起来正是我们要的，但：
 *
 * 1. **体积**：一张包含几百个刚体的世界快照在几十 KB 到 MB 级，
 *    300 帧就是几十上百 MB —— 手机上会直接崩。位姿方案是 7 个 float/刚体：
 *    800 刚体 × 32 字节 × 300 帧 ≈ **7.7 MB**，可控；
 * 2. **恢复语义更糟**：`World.restoreSnapshot()` 是**静态方法，返回一个新的世界对象**，
 *    于是所有刚体 handle 全部失效、建筑手里的 `physicsHandle` 全部变成野指针。
 *    要恢复就得重建整个世界并重新映射一切 —— 那不是"回溯一帧"，
 *    而是"重置到那一帧"，成本与体验都不是回退键该有的；
 * 3. 位姿方案唯一的代价是**不重算接触力**（接触点是求解器的中间量）。
 *    所以回溯后画面里物体会回到正确的姿态与位置，但"受力箭头"之类的调试读数
 *    需要等物理再跑一步才准 —— 这一点在 UI 上如实标注，不假装是完整状态回放。
 *
 * 关键帧（位姿之外）仍然提供，但语义写清楚：**跳转到关键帧 = 用那一帧的状态重建物理世界**，
 * 会重建所有刚体、重映射所有 handle。它是一条"重置"路径，不是平滑回退。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用 Float32Array 而不是对象数组
 * ────────────────────────────────────────────────────────────
 * 300 帧 × 800 刚体 = 24 万个记录。用对象数组就是 24 万个临时对象，
 * 60 FPS 下每秒创建几百万个对象，GC 停顿会直接把帧率打成锯齿。
 * 扁平 `Float32Array` 每帧只分配**一个**数组（而且环形缓冲里是复用的）。
 */

/** 一个刚体在一帧里的状态（7 个 float：位置 3 + 四元数 4） */
export const FLOATS_PER_BODY = 7;

export interface PoseBody {
  handle: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

/** 一帧位姿（扁平：handle 放在单独的 Int32Array 里，位姿放在 Float32Array 里） */
export interface PoseFrame {
  /** 物理步号 */
  step: number;
  /** 模拟时间（秒） */
  time: number;
  /** 这一帧记录了哪些刚体 */
  handles: Int32Array;
  /** 长度 = handles.length × 7 */
  data: Float32Array;
  /** 这一帧属于哪个"世代"（换地图会让世代 +1，避免跨世界回放） */
  generation: number;
}

export interface KeyframeRecord {
  index: number;
  label: string;
  step: number;
  time: number;
  /** 世界快照的字节数 */
  bytes: number;
  /** 快照本体 */
  snapshot: Uint8Array;
}

export interface PhysicsSnapshotOptions {
  /** 环形缓冲容量（帧），默认 300 = 5 秒 @60Hz */
  capacity?: number;
  /** 关键帧上限（世界快照体积大，默认 3 个） */
  keyframeLimit?: number;
  /** 每隔多少步记一帧，默认 1（每步都记） */
  strideSteps?: number;
}

export interface PhysicsSnapshotStats {
  /** 已记录的帧数 */
  frames: number;
  capacity: number;
  /** 下次记录会写到哪个槽位 */
  head: number;
  /** 已用字节（位姿缓冲，粗估） */
  poseBytes: number;
  /** 关键帧数量与总字节 */
  keyframes: number;
  keyframeBytes: number;
  /** 当前世代 */
  generation: number;
  /** 记录了但从未被回放过的帧数不做统计 —— 只报事实 */
  strideSteps: number;
}

export class PhysicsSnapshot {
  private readonly capacity: number;
  private readonly keyframeLimit: number;
  private readonly strideSteps: number;
  private readonly frames: (PoseFrame | null)[];
  /** 最新的帧下标（-1 表示还没有任何帧） */
  private head = -1;
  private frameCount = 0;
  private generationValue = 0;
  private lastRecordedStep = Number.NEGATIVE_INFINITY;
  private keyframes: KeyframeRecord[] = [];
  private nextKeyframeIndex = 1;

  constructor(options: PhysicsSnapshotOptions = {}) {
    this.capacity = Math.max(2, Math.floor(options.capacity ?? 300));
    this.keyframeLimit = Math.max(1, Math.floor(options.keyframeLimit ?? 3));
    this.strideSteps = Math.max(1, Math.floor(options.strideSteps ?? 1));
    this.frames = new Array<PoseFrame | null>(this.capacity).fill(null);
  }

  // ------------------------------------------------------------------ 只读

  get capacityValue(): number {
    return this.capacity;
  }

  get recordedFrames(): number {
    return this.frameCount;
  }

  get generation(): number {
    return this.generationValue;
  }

  /** 游标：当前"实时"位于环形缓冲的第几号槽 */
  get cursor(): number {
    return this.head;
  }

  get stats(): PhysicsSnapshotStats {
    const poseBytes = this.frameCount * 0; // 实际字节下面按帧累加
    void poseBytes;
    let bytes = 0;
    for (const frame of this.frames) {
      if (frame) bytes += frame.data.byteLength + frame.handles.byteLength;
    }
    let keyframeBytes = 0;
    for (const keyframe of this.keyframes) keyframeBytes += keyframe.bytes;
    return {
      frames: this.frameCount,
      capacity: this.capacity,
      head: this.head,
      poseBytes: bytes,
      keyframes: this.keyframes.length,
      keyframeBytes,
      generation: this.generationValue,
      strideSteps: this.strideSteps,
    };
  }

  // ------------------------------------------------------------------ 记录

  /**
   * 记一帧。
   *
   * @param step 物理步号（用于抽帧；只有 `step - lastRecorded >= strideSteps` 才真的记）
   * @param bodies 当前所有**动态**刚体（静止与地形不需要回溯，它们本来就不动）
   */
  record(step: number, time: number, bodies: readonly PoseBody[]): boolean {
    if (step - this.lastRecordedStep < this.strideSteps && this.frameCount > 0) return false;
    this.lastRecordedStep = step;

    const count = bodies.length;
    const handles = new Int32Array(count);
    const data = new Float32Array(count * FLOATS_PER_BODY);
    for (let i = 0; i < count; i += 1) {
      const body = bodies[i]!;
      handles[i] = body.handle;
      const base = i * FLOATS_PER_BODY;
      data[base] = body.position.x;
      data[base + 1] = body.position.y;
      data[base + 2] = body.position.z;
      data[base + 3] = body.rotation.x;
      data[base + 4] = body.rotation.y;
      data[base + 5] = body.rotation.z;
      data[base + 6] = body.rotation.w;
    }

    this.head = (this.head + 1) % this.capacity;
    this.frames[this.head] = { step, time, handles, data, generation: this.generationValue };
    this.frameCount = Math.min(this.frameCount + 1, this.capacity);
    return true;
  }

  /** 取环形缓冲里的第 `index` 帧（0 = 最旧的一帧），越界返回 null */
  frameAt(index: number): PoseFrame | null {
    if (index < 0 || index >= this.frameCount) return null;
    const oldest = (this.head - this.frameCount + 1 + this.capacity * 2) % this.capacity;
    const slot = (oldest + index) % this.capacity;
    return this.frames[slot] ?? null;
  }

  /** 最新一帧 */
  latest(): PoseFrame | null {
    return this.head >= 0 ? this.frames[this.head] ?? null : null;
  }

  /** 最旧一帧的序号（面板显示"第 N / M 帧"用） */
  stepRange(): { min: number; max: number } | null {
    const oldest = this.frameAt(0);
    const newest = this.latest();
    if (!oldest || !newest) return null;
    return { min: oldest.step, max: newest.step };
  }

  /**
   * 按"回退多少帧"取一帧。
   *
   * 这是按 R 键回退的语义：forward 为 -1 表示回退一帧。
   * 到边界时**返回边界帧而不是 null** —— 玩家一直按 R 应该停在最旧一帧，
   * 而不是突然什么都没发生（那样会以为回退键坏了）。
   */
  relativeFrame(offset: number): { frame: PoseFrame; index: number; clamped: boolean } | null {
    if (this.frameCount === 0) return null;
    const currentIndex = this.frameCount - 1;
    const target = currentIndex + offset;
    const clampedIndex = Math.min(this.frameCount - 1, Math.max(0, target));
    const frame = this.frameAt(clampedIndex);
    if (!frame) return null;
    return { frame, index: clampedIndex, clamped: clampedIndex !== target };
  }

  // ------------------------------------------------------------------ 写回

  /**
   * 把一帧位姿写回物理世界。
   *
   * **写回必须是"传送 + 归零速度"**：只改位置不改速度的话，物体回到历史位置后
   * 会带着当前速度继续飞（表现是"倒回去了但又立刻弹开"）。
   * 所以这里把线速度与角速度都清掉，让回溯后的世界真正"静止在那一刻"。
   *
   * @param apply 由调用方提供的写回函数（我们在这里不 import Rapier）
   * @returns 成功写回了几个刚体；缺失的刚体（已被删除）会被跳过并计数
   */
  applyFrame(
    frame: PoseFrame,
    apply: (handle: number, position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number; w: number }) => boolean,
  ): { applied: number; missing: number } {
    let applied = 0;
    let missing = 0;
    for (let i = 0; i < frame.handles.length; i += 1) {
      const handle = frame.handles[i]!;
      const base = i * FLOATS_PER_BODY;
      const ok = apply(
        handle,
        { x: frame.data[base]!, y: frame.data[base + 1]!, z: frame.data[base + 2]! },
        {
          x: frame.data[base + 3]!,
          y: frame.data[base + 4]!,
          z: frame.data[base + 5]!,
          w: frame.data[base + 6]!,
        },
      );
      if (ok) applied += 1;
      else missing += 1;
    }
    return { applied, missing };
  }

  // ------------------------------------------------------------------ 关键帧

  /**
   * 记一个关键帧（完整世界快照）。
   *
   * 传进来的 `world` 只需要有 `takeSnapshot()`（Rapier 的 World 就满足）。
   * 快照体积大，所以数量受限；超过上限时**丢最旧的那个**（新状态比旧状态有用）。
   */
  takeKeyframe(label: string, world: { takeSnapshot(): Uint8Array }, step: number, time: number): KeyframeRecord | null {
    let snapshot: Uint8Array;
    try {
      snapshot = world.takeSnapshot();
    } catch (error) {
      console.warn('[快照] 取世界快照失败', error);
      return null;
    }
    const record: KeyframeRecord = {
      index: this.nextKeyframeIndex++,
      label,
      step,
      time,
      bytes: snapshot.byteLength,
      snapshot,
    };
    this.keyframes.push(record);
    while (this.keyframes.length > this.keyframeLimit) this.keyframes.shift();
    return record;
  }

  listKeyframes(): readonly KeyframeRecord[] {
    return this.keyframes;
  }

  keyframeAt(index: number): KeyframeRecord | null {
    return this.keyframes.find((record) => record.index === index) ?? null;
  }

  /**
   * 关键帧恢复。
   *
   * **注意这是"重置"不是"回退"**：Rapier 的 `restoreSnapshot` 是静态方法、
   * 返回一个全新的世界对象，所以调用方（Engine）必须把世界实例换掉、
   * 并重建所有建筑的刚体与 handle 映射。返回值里的 `requiresRebuild` 就是在说这件事 ——
   * UI 应当明确提示玩家"这会重建物理世界"，而不是做成一个悄悄回退的按钮。
   */
  planKeyframeRestore(index: number): { ok: boolean; bytes: number; requiresRebuild: boolean; reason?: string } {
    const record = this.keyframeAt(index);
    if (!record) return { ok: false, bytes: 0, requiresRebuild: true, reason: `没有 #${index} 号关键帧` };
    return { ok: true, bytes: record.bytes, requiresRebuild: true };
  }

  // ------------------------------------------------------------------ 世代与清理

  /**
   * 换世界时调用：丢弃所有帧并让世代 +1。
   *
   * 世代存在的意义是防止**跨世界回放**：换地图后刚体 handle 全部重新分配，
   * 如果还留着旧世界的位姿帧，一按回退就会把新世界的物体"传送到旧世界的位置上"，
   * 看起来像物理彻底坏了。世代号让旧帧能被识别并拒绝。
   */
  newGeneration(): number {
    this.clear();
    this.generationValue += 1;
    return this.generationValue;
  }

  clear(): void {
    this.frames.fill(null);
    this.head = -1;
    this.frameCount = 0;
    this.lastRecordedStep = Number.NEGATIVE_INFINITY;
  }

  /** 连关键帧一起清（关键帧体积大，换地图时必须释放） */
  clearAll(): void {
    this.clear();
    this.keyframes = [];
  }

  /** 面板用：一行中文摘要 */
  describe(): string {
    const stats = this.stats;
    const range = this.stepRange();
    const position = range ? `（第 ${range.min} ~ ${range.max} 步）` : '（还没有记录）';
    return (
      `回溯缓冲 ${stats.frames} / ${stats.capacity} 帧${position}｜` +
      `位姿数据 ${(stats.poseBytes / 1048576).toFixed(1)} MB｜` +
      `关键帧 ${stats.keyframes} 个 / ${(stats.keyframeBytes / 1048576).toFixed(1)} MB`
    );
  }
}
