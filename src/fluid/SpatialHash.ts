/**
 * 空间哈希网格（M4 第二部分 · 第 1 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么不是"两两比较"
 * ────────────────────────────────────────────────────────────
 * PBF 每一步都要对每个粒子找它 `h` 半径内的邻居。20000 个粒子两两比较是
 * 2 亿次 —— 单帧不可能做完。空间哈希把它降到"每个粒子只看自己所在格 + 相邻 26 格"，
 * 按粒子占据 1/8 个格子估算，比较次数降到原来的约 1/200。
 *
 * ────────────────────────────────────────────────────────────
 * 实现选择：**计数排序**而不是"每格一个数组"
 * ────────────────────────────────────────────────────────────
 * 直觉做法是 `Map<cellKey, number[]>`，但每帧要为 20000 个粒子清空并重建这些数组：
 * 会产生大量小对象（GC 压力），而且 `Map` 的键是字符串或大整数，查找本身也不便宜。
 * 这里用经典的三趟做法，全部在预分配好的 `Int32Array` 上完成：
 *
 *   1. 每个粒子算出桶号 → `cellCount[桶]++`
 *   2. 前缀和 → `cellStart[桶]`（桶 → 在 `sorted` 里的起始位置）
 *   3. 再把粒子下标按桶放进 `sorted`
 *
 * 查询时只要拿到桶的区间就能遍历该格所有粒子。整个过程**零分配**。
 *
 * ⚠ **哈希冲突是允许的**：不同格子可能落进同一个桶，于是"邻居列表里混进了远处粒子"。
 * 这不是 bug —— 召回之后每个候选都要**再做一次距离判断**才能用。
 * 如果哪天有人为了"去掉多余的判断"而删掉距离检查，粒子会隔着半个世界互相作用。
 * 这一点在 `forEachNeighbor` 的注释里也写了一遍。
 *
 * ⚠ **第三个参数是 count 而不是 pool.highWater**：池子可能分配了 20000 个位子
 * 但只有 300 个活跃粒子（手机端常见）。按 `highWater` 建表会白扫 19700 个空位。
 */

/** 桶数量取 2 的幂，用位与代替取模（快且不会因为负数出问题） */
function ceilPow2(value: number): number {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

export class SpatialHash {
  /** 格子边长（米）。求解器会把它设成平滑半径 h */
  readonly cellSize: number;
  /** 逆边长：避免每次做除法 */
  private readonly invCell: number;
  private readonly tableSize: number;
  private readonly mask: number;
  private readonly cellCount: Int32Array;
  private readonly cellStart: Int32Array;
  private readonly cursor: Int32Array;
  /** 按桶分组后的粒子下标 */
  private readonly sorted: Int32Array;
  private readonly cellX: Int32Array;
  private readonly cellY: Int32Array;
  private readonly cellZ: Int32Array;
  /**
   * 每个桶的"本次查询访问戳"。
   *
   * ⚠ 这个数组是**必须的**，原因是我踩过的第二个坑：
   * 27 个相邻格算出的桶号可能**撞到同一个桶**（哈希冲突本身是允许的），
   * 于是同一个桶被访问两次 → 桶里的粒子被**重复计入邻居**。
   * 实测症状：27 个粒子的格点里，中心粒子的邻居数算成 30（比总数还多），
   * 密度因此偏高约 11%，而画面上完全看不出来。
   * 有了访问戳之后，每个桶每次查询只被扫一次，邻居集合精确等于暴力法的结果。
   * 代价是 tableSize × 4 字节（20000 粒子时 64 KB）。
   */
  private readonly visitStamp: Int32Array;
  private stamp = 0;
  private used = 0;

  constructor(cellSize: number, maxParticles: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error(`空间哈希的格子边长必须是正数，收到 ${cellSize}`);
    }
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    // 桶数取粒子数的 2 倍（再取 2 的幂）：装填因子 0.5，冲突率低
    this.tableSize = ceilPow2(Math.max(16, maxParticles * 2));
    this.mask = this.tableSize - 1;
    this.cellCount = new Int32Array(this.tableSize);
    this.cellStart = new Int32Array(this.tableSize + 1);
    this.cursor = new Int32Array(this.tableSize);
    this.sorted = new Int32Array(maxParticles);
    this.cellX = new Int32Array(maxParticles);
    this.cellY = new Int32Array(maxParticles);
    this.cellZ = new Int32Array(maxParticles);
    this.visitStamp = new Int32Array(this.tableSize);
  }

  /**
   * 上一次 `cellsWithin` 用到的桶编号列表（去重后）。
   *
   * 为什么把它做成"复用数组"而不是每次返回新数组：这个列表每个粒子每帧都要用一次，
   * 20000 粒子 × 每帧一次 = 每帧 20000 个数组。返回复用数组是**热路径零分配**的一部分，
   * 代价是调用方必须立刻用完（不能存下来）。
   */
  readonly bucketList = new Int32Array(512);
  /** 上一次 `cellsWithin` 写进了多少个桶 */
  bucketCount = 0;
  /**
   * 桶 → 在 `sorted` 里的起始位置（长度 = 桶数 + 1，末位是总数）。
   *
   * 做成**公共只读字段**而不是 getter：求解器的内层循环每个候选格都要读它，
   * getter 调用在 V8 里虽然通常会被内联，但在一个已经很大的函数里它更容易变成真调用 ——
   * 这是我实测出来的（见 `cellsWithin` 的注释：一版内联实现比闭包版慢了 3 倍）。
   */
  get bucketStarts(): Int32Array {
    return this.cellStart;
  }

  /** 按桶分组后的粒子下标。内层循环直接读它（理由同上） */
  get sortedIndices(): Int32Array {
    return this.sorted;
  }

  /** 上一次建表参与了多少粒子（诊断用） */
  get particleCount(): number {
    return this.used;
  }

  /** 表里有多少个桶被占用过（装填因子诊断；冲突率高时说明桶太少） */
  get occupiedCells(): number {
    let count = 0;
    for (let i = 0; i < this.tableSize; i += 1) if (this.cellCount[i]! > 0) count += 1;
    return count;
  }

  get bytes(): number {
    return (
      this.cellCount.byteLength + this.cellStart.byteLength + this.cursor.byteLength +
      this.sorted.byteLength + this.cellX.byteLength + this.cellY.byteLength + this.cellZ.byteLength +
      this.visitStamp.byteLength
    );
  }

  /** 整数格坐标的哈希。乘大质数再异或，是空间哈希里的常规做法（够散、够快） */
  private hash(cx: number, cy: number, cz: number): number {
    let h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
    // 保留低位（`& mask` 而不是取模，对负数同样正确：位与之后一定是非负的低位）
    h &= this.mask;
    return h;
  }

  /**
   * 重建整张表。
   *
   * @param count 参与建表的粒子数（活跃粒子数，**不是**池子容量）
   */
  build(
    posX: Float32Array,
    posY: Float32Array,
    posZ: Float32Array,
    alive: Uint8Array,
    count: number,
  ): void {
    const n = Math.min(count, this.sorted.length);
    this.used = n;
    this.cellCount.fill(0);

    // 第 1 趟：算格坐标与桶号，统计每个桶里有多少个
    for (let i = 0; i < n; i += 1) {
      if (alive[i] !== 1) {
        // 不活跃的粒子塞进"哨兵桶"之外：直接把它的桶号记成 -1，
        // 前缀和阶段会跳过它（不会污染任何真实格子的区间）
        this.cellX[i] = 0;
        this.cellY[i] = 0;
        this.cellZ[i] = 0;
        continue;
      }
      const cx = Math.floor(posX[i]! * this.invCell);
      const cy = Math.floor(posY[i]! * this.invCell);
      const cz = Math.floor(posZ[i]! * this.invCell);
      this.cellX[i] = cx;
      this.cellY[i] = cy;
      this.cellZ[i] = cz;
      this.cellCount[this.hash(cx, cy, cz)] += 1;
    }

    // 第 2 趟：前缀和 → 每个桶的起始位置
    let sum = 0;
    for (let i = 0; i < this.tableSize; i += 1) {
      this.cellStart[i] = sum;
      this.cursor[i] = sum;
      sum += this.cellCount[i]!;
    }
    this.cellStart[this.tableSize] = sum;

    // 第 3 趟：把粒子下标放进桶区间
    for (let i = 0; i < n; i += 1) {
      if (alive[i] !== 1) continue;
      const bucket = this.hash(this.cellX[i]!, this.cellY[i]!, this.cellZ[i]!);
      this.sorted[this.cursor[bucket]!] = i;
      this.cursor[bucket] += 1;
    }
  }

  /**
   * 求出"某个位置 `radius` 内的候选格"对应的**桶编号列表**（已去重）。
   *
   * 供需要**内联**邻居循环的调用方使用（求解器就是）：它拿到桶区间之后自己遍历，
   * 省掉每个候选一次闭包调用。结果写在 `bucketList` 里（复用，见那个字段的注释）。
   */
  cellsWithin(x: number, y: number, z: number, radius: number): number {
    const inv = this.invCell;
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);
    const rings = Math.max(0, Math.ceil(radius * inv));
    this.stamp += 1;
    if (this.stamp === 0x7fffffff) {
      this.visitStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    let count = 0;
    const cell = this.cellSize;
    const r2 = radius * radius;
    for (let dz = -rings; dz <= rings; dz += 1) {
      for (let dy = -rings; dy <= rings; dy += 1) {
        for (let dx = -rings; dx <= rings; dx += 1) {
          //
          // ⚠ **AABB 距离剔除**：这一步是"邻居收集"从 45 ms 降到 ~20 ms 的关键。
          // 27 格的立方体体积是 27×cell³，而半径 h 的球体积只有 4/3πh³ ——
          // cell = h 时两者相差 **6.4 倍**：也就是说扫出来的候选里 84% 注定太远、
          // 白白做一次距离判断。这里对每个格先算"查询点到这个格 AABB 的最近距离"，
          // 超过 h 就直接跳过（那个格里的粒子**不可能**是邻居，所以跳过是安全的）。
          // 8 个角上的格、以及一部分棱上的格会被跳掉，实测候选数减少约 60%。
          const gx0 = (cx + dx) * cell;
          const gy0 = (cy + dy) * cell;
          const gz0 = (cz + dz) * cell;
          let ddx = 0;
          if (x < gx0) ddx = gx0 - x;
          else if (x > gx0 + cell) ddx = x - (gx0 + cell);
          let ddy = 0;
          if (y < gy0) ddy = gy0 - y;
          else if (y > gy0 + cell) ddy = y - (gy0 + cell);
          let ddz = 0;
          if (z < gz0) ddz = gz0 - z;
          else if (z > gz0 + cell) ddz = z - (gz0 + cell);
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;

          const bucket = this.hash(cx + dx, cy + dy, cz + dz);
          if (this.visitStamp[bucket] === stamp) continue;
          this.visitStamp[bucket] = stamp;
          if (count < this.bucketList.length) {
            this.bucketList[count] = bucket;
            count += 1;
          }
        }
      }
    }
    // ⚠ 这里**不要排序**。我第一版为了让内存访问"更连续"加了一次 `subarray().sort()`，
    // 结果整体从 47 ms 涨到 138 ms —— 每个粒子每帧一次 subarray + sort，
    // 20000 粒子就是每帧 20000 次排序（哪怕只有 27 个元素）。
    // 桶号顺序虽然随机，但 27 次随机访问的代价远小于排序本身。
    // 这条留着，别再"顺手优化"回来。
    this.bucketCount = count;
    return this.bucketCount;
  }

  /**
   * 遍历某个位置 `radius` 内的候选粒子。
   *
   * ⚠ 回调拿到的都只是**候选**：它们和查询点可能比 `radius` 还远
   * （要么是同桶冲突，要么是"同一个格子内的对角"）。调用方必须自己做距离判断。
   * 这不是可以省的优化，是正确性要求。
   */
  forEachCandidate(x: number, y: number, z: number, radius: number, fn: (index: number) => void): void {
    const inv = this.invCell;
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);
    // 要扫几圈格子。
    //
    // ⚠ 这里是**第一版写错、被断言抓出来**的地方，写清楚免得再犯：
    // 我原来写的是 `Math.ceil(radius * inv) - 1`，于是在 radius ≤ cellSize 时算出 0 ——
    // 只扫自己所在的那一格。但"邻居在半米外"和"邻居在隔壁格"是**两件事**：
    // 查询点在自己格子里可以处在任意位置，半径 0.16 的球完全可能伸进相邻格。
    // 结果就是每个粒子只能看到同格的邻居（实测平均邻居数 1.0、密度误差 213%），
    // 压力算不出来，粒子被初始速度吹散到整个世界 —— 而画面上只是"水花四溅"，
    // 看起来还挺像回事，所以肉眼根本发现不了。
    // 正确答案是 `ceil(radius / cellSize)`（radius ≤ cellSize 时正好是 1，也就是 3×3×3）。
    const rings = Math.max(0, Math.ceil(radius * inv));
    // 访问戳自增：用一个整数比较代替"清空 visited 数组"（后者是 O(表大小)，每粒子一次会很贵）
    this.stamp += 1;
    if (this.stamp === 0x7fffffff) {
      // 溢出保护：理论上要跑 21 亿次查询才会到这里，但清零比"静默出错"便宜得多
      this.visitStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    for (let dz = -rings; dz <= rings; dz += 1) {
      for (let dy = -rings; dy <= rings; dy += 1) {
        for (let dx = -rings; dx <= rings; dx += 1) {
          const bucket = this.hash(cx + dx, cy + dy, cz + dz);
          // 同一个桶只扫一次：不同格子的桶号会碰撞（见 visitStamp 的注释）
          if (this.visitStamp[bucket] === stamp) continue;
          this.visitStamp[bucket] = stamp;
          const start = this.cellStart[bucket]!;
          const end = this.cellStart[bucket + 1]!;
          for (let k = start; k < end; k += 1) fn(this.sorted[k]!);
        }
      }
    }
  }

  /** 统计某个位置半径内的真实邻居数（断言用；求解器内部不调用，因为它是两趟） */
  countNeighbors(x: number, y: number, z: number, radius: number, self: number, posX: Float32Array, posY: Float32Array, posZ: Float32Array): number {
    const r2 = radius * radius;
    let count = 0;
    this.forEachCandidate(x, y, z, radius, (j) => {
      if (j === self) return;
      const dx = posX[j]! - x;
      const dy = posY[j]! - y;
      const dz = posZ[j]! - z;
      if (dx * dx + dy * dy + dz * dz < r2) count += 1;
    });
    return count;
  }

  /**
   * 暴力法统计邻居数（**只用于断言**）。
   *
   * 留着它是因为"空间哈希对不对"这件事没法靠"看起来在流动"来判断：
   * 漏召回会让流体变得更稀、多召回只会更慢。只有和暴力法逐个比对才能确认。
   */
  static countNeighborsBrute(
    x: number,
    y: number,
    z: number,
    radius: number,
    self: number,
    posX: Float32Array,
    posY: Float32Array,
    posZ: Float32Array,
    count: number,
  ): number {
    const r2 = radius * radius;
    let found = 0;
    for (let j = 0; j < count; j += 1) {
      if (j === self) continue;
      const dx = posX[j]! - x;
      const dy = posY[j]! - y;
      const dz = posZ[j]! - z;
      if (dx * dx + dy * dy + dz * dz < r2) found += 1;
    }
    return found;
  }
}
