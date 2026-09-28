/**
 * 粒子池（SoA 结构 + 空闲链表）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用**数组的结构（SoA）**而不是 `Particle[]` 对象数组
 * ────────────────────────────────────────────────────────────
 * 每帧要对每个粒子做几十次浮点运算，而且要在空间哈希里来回跳。
 * 如果粒子是 `{ x, y, z, vx, ... }` 这样的对象，会有两个代价：
 * 1. **内存不连续**：对象散在堆上，遍历时缓存命中率低；
 * 2. **GC 压力**：每帧新建/丢弃对象会让主线程被 GC 打断（表现是周期性掉帧，
 *    而不是持续低帧率 —— 这类卡顿最难查）。
 * 用 `Float32Array` 之后，这两件事都消失了，而且数组可以直接被 Worker 的结构化克隆
 * 零拷贝转移（第 6 批要把求解搬到 Worker，这条是前提）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用**空闲链表**而不是"移动最后一个来填补"
 * ────────────────────────────────────────────────────────────
 * 移动填补看上去更简单（O(1) 且数组永远紧凑），但它会让**粒子下标每帧都变**。
 * 下标变了，缓存里的邻域、冻结区域、耦合用的"哪些粒子属于哪个刚体"全都要重算，
 * 而且调试时会看到"同一个粒子在两帧里位置突变"（其实是换人了）。
 * 空闲链表让下标一旦分配就稳定，代价是需要一个 `alive` 标记。
 *
 * `count` 是活跃粒子数；`highWater` 是历史上用过的最大下标 + 1（分配数组用），
 * 也是"这个池子到底用掉多少内存"的诚实指标。
 */

export interface ParticlePoolStats {
  /** 活跃粒子数 */
  alive: number;
  /** 历史上最多同时存活过多少 */
  peakAlive: number;
  /** 下标水位（分配尺寸的依据） */
  highWater: number;
  capacity: number;
  /** 累计生成 / 回收次数（用来验证"池子真的在复用"） */
  spawned: number;
  recycled: number;
}

export class ParticlePool {
  readonly capacity: number;

  // ---- 位置与速度（SoA）
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly velZ: Float32Array;

  // ---- PBF 需要的中间量
  /** 上一步的位置（速度由 `(pos - prev) / dt` 反推，这是 PBF 的核心做法） */
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly prevZ: Float32Array;
  /** 密度与拉格朗日乘子（每步重算） */
  readonly density: Float32Array;
  readonly lambda: Float32Array;
  /** 表面张力/黏性需要的临时速度增量（避免在求解中被反复写回） */
  readonly deltaVX: Float32Array;
  readonly deltaVY: Float32Array;
  readonly deltaVZ: Float32Array;
  /** 是否参与模拟（冻结区域里的粒子每帧写 0） */
  readonly frozen: Uint8Array;
  /** 1 = 活跃，0 = 空闲 */
  readonly alive: Uint8Array;

  /** 空闲下标栈（栈顶 = 下一个可用下标） */
  private readonly freeList: Int32Array;
  private freeCount = 0;
  private aliveCount = 0;
  private peak = 0;
  private high = 0;
  private spawnCounter = 0;
  private recycleCounter = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`粒子池容量必须是正数，收到 ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    const n = this.capacity;
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.posZ = new Float32Array(n);
    this.velX = new Float32Array(n);
    this.velY = new Float32Array(n);
    this.velZ = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.prevZ = new Float32Array(n);
    this.density = new Float32Array(n);
    this.lambda = new Float32Array(n);
    this.deltaVX = new Float32Array(n);
    this.deltaVY = new Float32Array(n);
    this.deltaVZ = new Float32Array(n);
    this.frozen = new Uint8Array(n);
    this.alive = new Uint8Array(n);
    this.freeList = new Int32Array(n);
    // 空闲链表从后往前填：这样**第一次分配会从下标 0 开始**，
    // 顺序分配在遍历时缓存友好（虽然只是开局那一下，但代价为零）
    for (let i = 0; i < n; i += 1) this.freeList[i] = n - 1 - i;
    this.freeCount = n;
  }

  get count(): number {
    return this.aliveCount;
  }

  get highWater(): number {
    return this.high;
  }

  get stats(): ParticlePoolStats {
    return {
      alive: this.aliveCount,
      peakAlive: this.peak,
      highWater: this.high,
      capacity: this.capacity,
      spawned: this.spawnCounter,
      recycled: this.recycleCounter,
    };
  }

  /** 还有多少空位 */
  get free(): number {
    return this.freeCount;
  }

  /**
   * 生成一个粒子。
   *
   * @returns 新粒子的下标；池子满了返回 -1（**不抛异常、不淘汰旧粒子**）。
   *   为什么满了不淘汰旧的：淘汰意味着"玩家刚倒的水会突然少一块"，
   *   而调用方（编辑工具）更希望能告诉玩家"到上限了"并给出数字。
   */
  spawn(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): number {
    if (this.freeCount === 0) return -1;
    this.freeCount -= 1;
    const index = this.freeList[this.freeCount]!;
    this.posX[index] = x;
    this.posY[index] = y;
    this.posZ[index] = z;
    this.prevX[index] = x;
    this.prevY[index] = y;
    this.prevZ[index] = z;
    this.velX[index] = vx;
    this.velY[index] = vy;
    this.velZ[index] = vz;
    this.density[index] = 0;
    this.lambda[index] = 0;
    this.deltaVX[index] = 0;
    this.deltaVY[index] = 0;
    this.deltaVZ[index] = 0;
    this.frozen[index] = 0;
    this.alive[index] = 1;
    this.aliveCount += 1;
    if (this.aliveCount > this.peak) this.peak = this.aliveCount;
    if (index + 1 > this.high) this.high = index + 1;
    this.spawnCounter += 1;
    return index;
  }

  /** 回收一个粒子（重复回收同一个下标是安全的，不会把计数搞乱） */
  kill(index: number): boolean {
    if (index < 0 || index >= this.capacity) return false;
    if (this.alive[index] === 0) return false;
    this.alive[index] = 0;
    this.frozen[index] = 0;
    this.freeList[this.freeCount] = index;
    this.freeCount += 1;
    this.aliveCount -= 1;
    this.recycleCounter += 1;
    return true;
  }

  /**
   * 回收全部（换地图 / 清空流体）。
   *
   * ⚠ 这里同时把 `high` 归零 —— 第一版漏了这一步（只清了 alive 标记），
   * 于是清空之后 `highWater` 还是旧值，求解器会继续遍历那一大段**全是死粒子**的下标：
   * 结果不错（alive 都是 0），但白白浪费几毫秒，而且在"清空后再倒一小滩水"时
   * 性能数据会难看且看不出原因。峰值另用 `peakAlive` 记录，不受影响。
   */
  clear(): void {
    this.alive.fill(0);
    this.frozen.fill(0);
    this.freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i += 1) this.freeList[i] = this.capacity - 1 - i;
    this.aliveCount = 0;
    this.high = 0;
  }

  /**
   * 把某个粒子挪到指定位置并清零速度。
   * 给"抽水/加水"这类编辑工具用：与其 kill + spawn（会换下标），不如原地搬走。
   * 原地搬走的好处是下标稳定，冻结区域与耦合映射都不用重算。
   */
  teleport(index: number, x: number, y: number, z: number): boolean {
    if (index < 0 || index >= this.capacity || this.alive[index] === 0) return false;
    this.posX[index] = x;
    this.posY[index] = y;
    this.posZ[index] = z;
    this.prevX[index] = x;
    this.prevY[index] = y;
    this.prevZ[index] = z;
    this.velX[index] = 0;
    this.velY[index] = 0;
    this.velZ[index] = 0;
    return true;
  }

  /** 遍历活跃粒子（热路径上避免 forEach 闭包，这里只用于冷路径） */
  forEachAlive(fn: (index: number) => void): void {
    for (let i = 0; i < this.high; i += 1) if (this.alive[i] === 1) fn(i);
  }

  /**
   * 紧凑化：把活跃粒子集中到下标 `[0, aliveCount)`。
   *
   * 什么时候用：粒子上限很大但实际只用了几百个时（例如手机端上限 3000、只倒了 300 个），
   * 求解器按 `highWater` 遍历会白跑 90% 的空位。紧凑化之后 `highWater === aliveCount`。
   * 代价是下标会变，所以**只能在"没有外部引用下标"的时候调用**
   * （冻结区域按坐标判断、耦合按坐标查询，所以是安全的；但如果将来有按下标存的东西，
   * 必须先更新它们 —— 这条写在这里免得以后踩）。
   */
  compact(): number {
    let write = 0;
    for (let read = 0; read < this.high; read += 1) {
      if (this.alive[read] === 0) continue;
      if (write !== read) {
        this.posX[write] = this.posX[read]!;
        this.posY[write] = this.posY[read]!;
        this.posZ[write] = this.posZ[read]!;
        this.velX[write] = this.velX[read]!;
        this.velY[write] = this.velY[read]!;
        this.velZ[write] = this.velZ[read]!;
        this.prevX[write] = this.prevX[read]!;
        this.prevY[write] = this.prevY[read]!;
        this.prevZ[write] = this.prevZ[read]!;
        this.frozen[write] = this.frozen[read]!;
        this.alive[write] = 1;
      }
      write += 1;
    }
    for (let i = write; i < this.high; i += 1) this.alive[i] = 0;
    this.aliveCount = write;
    this.high = write;
    // 空闲链表重建：从高水位之后开始
    this.freeCount = 0;
    for (let i = write; i < this.capacity; i += 1) {
      this.freeList[this.freeCount] = i;
      this.freeCount += 1;
    }
    return write;
  }

  /** 估算内存占用（字节）。是真数字，不是估算公式 —— 就是这些 TypedArray 的 byteLength */
  get bytes(): number {
    const arrays: ArrayBufferView[] = [
      this.posX, this.posY, this.posZ, this.velX, this.velY, this.velZ,
      this.prevX, this.prevY, this.prevZ, this.density, this.lambda,
      this.deltaVX, this.deltaVY, this.deltaVZ, this.frozen, this.alive, this.freeList,
    ];
    let total = 0;
    for (const view of arrays) total += view.byteLength;
    return total;
  }
}
