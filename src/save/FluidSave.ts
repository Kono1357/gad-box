/**
 * 流体与沙的存档（M4 第二部分 · 第 8 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么不能直接把 Float32Array 塞进 JSON
 * ────────────────────────────────────────────────────────────
 * 20000 个粒子 × (3 位置 + 3 速度) 个 float32 = 480 KB。
 * 用 JSON 写数字会膨胀 3~5 倍（每个数字是 1~12 个字符的文本），
 * 于是"存一次水"就变成两三兆的字符串 —— 浏览器的 localStorage 配额是 5 MB 左右，
 * 一次就爆。所以这里做两件事：**量化** + **字节打包**。
 *
 * ## 量化（这一步决定"存回来的水还是不是那摊水"）
 *
 * | 量 | 精度 | 为什么够 |
 * |---|---|---|
 * | 位置 | **1/512 米（约 2 毫米）** | 粒子半径是 80 毫米，2 毫米的误差看不出来 |
 * | 速度 | **1/64 米/秒** | 速度是用来恢复动量的，0.016 m/s 的误差在视觉上无意义 |
 * | 沙的湿度 | **1/255** | 它本身就是一个 0~1 的百分比 |
 *
 * 位置不是存"绝对坐标"，而是存**相对世界包围盒的偏移**再量化：
 * 世界坐标范围可能只有几米（一桶水），也可能跨几十米（一条河），
 * 用固定的绝对精度会在小范围里浪费位数、在大范围里精度不够。
 *
 * ## 打包
 *
 * 量化之后是 `Uint8Array`，走与体素存档同一条 `packBytes` 路径
 * （RLE 更小就用 RLE，否则原样），再 base64 成可以放进 JSON 的字符串。
 *
 * ## 如实说明：**这是有损压缩**
 *
 * 位置与速度都会被量化。所以"存档 → 读档"之后流体的**微观状态会变**
 * （粒子不会精确回到原来的位置），但**宏观状态一致**（同样的水面高度、同样的流向）。
 * 断言里钉的就是这个：位置误差在容差内、速度误差在容差内、粒子数**精确相等**。
 * 粒子数必须精确相等 —— 少一个或者多一个都是 bug，不是"精度问题"。
 */

import { base64ToBytes, packBytes, unpackBytes, type PackedBytes } from './SaveSystem';
import type { ParticlePool } from '../fluid/ParticlePool';
import type { SandSystem } from '../sand/SandSystem';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import { getVoxelId } from '../data/voxelTypes';

const SAND = getVoxelId('sand');

/**
 * 存档格式的魔数（用来识别"这不是我们的流体存档"）。
 * 放在 JSON 的 `magic` 字段里 —— 玩家可能把别的 JSON 粘进导入框，
 * 那时候要能立刻说"这不是流体存档"，而不是解到一半报一个看不懂的错。
 */
const FLUID_MAGIC = 0x4753464c; // "GSFL"
const FLUID_VERSION = 1;

/** 位置量化精度：1/512 米（约 2 毫米） */
export const POSITION_QUANTUM = 1 / 512;
/** 速度量化精度：1/64 米/秒 */
export const VELOCITY_QUANTUM = 1 / 64;

export interface FluidSavePayload {
  /** 魔数（识别"这是不是流体存档"） */
  magic?: number;
  /** 格式版本（读档时要检查） */
  v: number;
  /** 粒子数 */
  count: number;
  /** 粒子包围盒（量化用的参考系） */
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** 量化打包后的粒子数据 */
  particles: PackedBytes;
  /** 沙的湿度（稀疏：只有非零湿度的格子） */
  sand: PackedBytes | null;
  /**
   * 沙数据的**字节数**。
   *
   * 为什么必须存它：`unpackBytes` 需要知道期望长度，而 `raw` 模式下
   * "长度不对就截断" —— 我第一版传了 -1 表示"不知道长度"，
   * 结果 `subarray(0, -1)` 把**最后一个字节**砍掉了，于是最后一个沙格的湿度
   * 静默丢失（断言里表现为"读回来是 0"）。
   * 存长度比"猜长度"可靠，而且让格式自描述。
   */
  sandLength?: number;
  /** 存档时的流体类型（读回来要恢复预设） */
  fluidType: string;
  /** 存档时间戳（面板显示"这是什么时候存的"） */
  savedAtMs: number;
}

export interface FluidSaveStats {
  /** 粒子数 */
  particles: number;
  /** 沙的湿度条目数 */
  sandEntries: number;
  /** 打包后的字节数（压缩后） */
  packedBytes: number;
  /** 未压缩的原始字节数 */
  rawBytes: number;
  /** 压缩率（packedBytes / rawBytes） */
  ratio: number;
  /** 打包耗时（毫秒） */
  ms: number;
}

/** 写 16 位小端整数 */
function writeU16(out: number[], value: number): void {
  const clamped = Math.max(0, Math.min(65535, Math.round(value)));
  out.push(clamped & 0xff, (clamped >> 8) & 0xff);
}

/** 读 16 位小端整数 */
function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** 编码一个 32 位整数为 varint（沙的稀疏坐标用；格子坐标不会很大） */
function writeVarint(out: number[], value: number): void {
  let v = Math.max(0, Math.round(value));
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor]!;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) break;
  }
  return { value: value >>> 0, next: cursor };
}

export class FluidSave {
  /**
   * 把流体（+ 可选的沙湿度）打包成可以放进 JSON 的载荷。
   *
   * @param pool 粒子池
   * @param fluidType 当前流体类型（读档时恢复）
   * @param sand 沙系统（可选；给了就连湿度一起存）
   * @param grid 体素网格（沙的湿度要用它找到"哪些格子是沙"）
   */
  static encode(
    pool: ParticlePool,
    fluidType: string,
    sand?: SandSystem,
    grid?: VoxelGrid,
    nowMs = 0,
  ): FluidSavePayload {
    const count = pool.count;
    // ---- 1) 求包围盒（只统计活跃粒子）
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    const high = pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (pool.alive[i] !== 1) continue;
      const x = pool.posX[i]!;
      const y = pool.posY[i]!;
      const z = pool.posZ[i]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    // 没有粒子时给一个"空盒"，读档时 count=0 会直接跳过
    if (!Number.isFinite(minX)) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }
    const bounds = { minX, minY, minZ, maxX, maxY, maxZ };

    // ---- 2) 量化粒子（位置 16 位、速度 16 位）
    const out: number[] = [];
    for (let i = 0; i < high; i += 1) {
      if (pool.alive[i] !== 1) continue;
      // 位置：相对包围盒的偏移 → 0~65535
      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);
      const spanZ = Math.max(1e-6, maxZ - minZ);
      writeU16(out, ((pool.posX[i]! - minX) / spanX) * 65535);
      writeU16(out, ((pool.posY[i]! - minY) / spanY) * 65535);
      writeU16(out, ((pool.posZ[i]! - minZ) / spanZ) * 65535);
      // 速度：直接按 1/64 量化（速度范围有界，不需要相对化）
      writeU16(out, (pool.velX[i]! / VELOCITY_QUANTUM) + 32768);
      writeU16(out, (pool.velY[i]! / VELOCITY_QUANTUM) + 32768);
      writeU16(out, (pool.velZ[i]! / VELOCITY_QUANTUM) + 32768);
    }
    const particleBytes = new Uint8Array(out);

    // ---- 3) 沙的湿度（稀疏：只有湿度 > 0 的沙格才记）
    let sandBytes: Uint8Array | null = null;
    if (sand && grid) {
      const sandOut: number[] = [];
      for (let y = 0; y < grid.sizeY; y += 1) {
        for (let z = 0; z < grid.sizeZ; z += 1) {
          for (let x = 0; x < grid.sizeX; x += 1) {
            if (grid.getVoxel(x, y, z) !== SAND) continue;
            const moisture = sand.moistureAt(x, y, z);
            if (moisture <= 1 / 255) continue;
            // 坐标打包成一个整数再 varint：世界最大 192×32×192，足够放
            const packed = x + z * 256 + y * 256 * 256;
            writeVarint(sandOut, packed);
            sandOut.push(Math.round(moisture * 255));
          }
        }
      }
      sandBytes = new Uint8Array(sandOut);
    }

    return {
      magic: FLUID_MAGIC,
      v: FLUID_VERSION,
      count,
      bounds,
      particles: packBytes(particleBytes),
      sand: sandBytes ? packBytes(sandBytes) : null,
      sandLength: sandBytes ? sandBytes.length : 0,
      fluidType,
      savedAtMs: nowMs,
    };
  }

  /**
   * 读回流体。
   *
   * @returns 恢复的粒子数；载荷非法时返回 -1 并把原因写进 `lastError`
   */
  static decode(
    payload: FluidSavePayload,
    pool: ParticlePool,
    sand?: SandSystem,
    grid?: VoxelGrid,
  ): number {
    FluidSave.lastError = null;
    if (!payload || typeof payload !== 'object') {
      FluidSave.lastError = '流体存档不是一个对象';
      return -1;
    }
    if (payload.magic !== undefined && payload.magic !== FLUID_MAGIC) {
      FluidSave.lastError = '这不是流体存档（魔数不对）—— 是不是把世界存档或别的 JSON 粘进来了？';
      return -1;
    }
    if (payload.v !== FLUID_VERSION) {
      FluidSave.lastError = `流体存档版本不支持：${payload.v}（本版本支持 ${FLUID_VERSION}）`;
      return -1;
    }
    const count = Math.max(0, Math.floor(payload.count ?? 0));
    const bounds = payload.bounds;
    if (!bounds || !Number.isFinite(bounds.minX)) {
      FluidSave.lastError = '流体存档里没有有效的包围盒';
      return -1;
    }

    // 先清空（读档是"替换"不是"叠加"）
    pool.clear();

    // ⚠ 沙的湿度要在**粒子数检查之前**恢复。
    // 我第一版把 `if (count === 0) return 0;` 放在这里，于是"存档里只有沙、没有水"时
    // 沙的湿度**根本不会被读回来** —— 而那是完全合法的一种存档（玩家只弄湿了沙）。
    // 断言里表现为"写进去 0.75、读回来 0"。
    let sandRestored = 0;
    if (payload.sand && sand && grid) {
      try {
        const sandBytes = unpackBytes(payload.sand, payload.sandLength ?? 0);
        let cursor = 0;
        while (cursor < sandBytes.length) {
          const coord = readVarint(sandBytes, cursor);
          cursor = coord.next;
          if (cursor >= sandBytes.length) break;
          const moisture = sandBytes[cursor]! / 255;
          cursor += 1;
          const x = coord.value % 256;
          const z = Math.floor(coord.value / 256) % 256;
          const y = Math.floor(coord.value / 65536);
          if (grid.inBounds(x, y, z) && grid.getVoxel(x, y, z) === SAND) {
            sand.setMoisture(x, y, z, moisture);
            sandRestored += 1;
          }
        }
      } catch (error) {
        // 沙的数据坏了不该让"粒子已经读回来了"这件事作废 —— 如实警告，继续
        FluidSave.lastError = `沙的湿度数据解不开：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    FluidSave.lastSandEntries = sandRestored;

    if (count === 0) return 0;

    let bytes: Uint8Array;
    try {
      bytes = unpackBytes(payload.particles, count * 12);
    } catch (error) {
      FluidSave.lastError = `流体粒子数据解不开：${error instanceof Error ? error.message : String(error)}`;
      return -1;
    }
    if (bytes.length < count * 12) {
      // 数据比声明的粒子数短：这是**损坏**，不是"少几个粒子" —— 如实报错而不是静默截断
      FluidSave.lastError =
        `流体粒子数据长度不对：声明 ${count} 个粒子（需要 ${count * 12} 字节），实际 ${bytes.length} 字节`;
      return -1;
    }

    const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
    const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
    const spanZ = Math.max(1e-6, bounds.maxZ - bounds.minZ);
    let restored = 0;
    for (let i = 0; i < count; i += 1) {
      const offset = i * 12;
      const qx = readU16(bytes, offset);
      const qy = readU16(bytes, offset + 2);
      const qz = readU16(bytes, offset + 4);
      const x = bounds.minX + (qx / 65535) * spanX;
      const y = bounds.minY + (qy / 65535) * spanY;
      const z = bounds.minZ + (qz / 65535) * spanZ;
      const vx = (readU16(bytes, offset + 6) - 32768) * VELOCITY_QUANTUM;
      const vy = (readU16(bytes, offset + 8) - 32768) * VELOCITY_QUANTUM;
      const vz = (readU16(bytes, offset + 10) - 32768) * VELOCITY_QUANTUM;
      if (pool.spawn(x, y, z, vx, vy, vz) >= 0) restored += 1;
    }

    return restored;
  }

  /** 上一次 decode 的失败原因（成功时为 null） */
  static lastError: string | null = null;
  /** 上一次 decode 恢复了多少格沙的湿度（诊断：用来区分"沙没存"和"沙没读出来"） */
  static lastSandEntries = 0;

  /** 统计载荷大小（面板显示"存档有多大"）；纯信息，不参与读写 */
  static measure(payload: FluidSavePayload): FluidSaveStats {
    const particleBytes = Math.ceil(base64ToBytes(payload.particles.d).length);
    const sandBytes = payload.sand ? Math.ceil(base64ToBytes(payload.sand.d).length) : 0;
    // ⚠ "原始大小"指的是**没量化**时的字节数：6 个量（3 位置 + 3 速度）× float32 4 字节 = **24 字节/粒子**。
    // 我第一版写成 12（那是量化后的字节数），于是压缩率永远显示 100% ——
    // 那个数字不是"压缩没生效"，而是"分母算错了"，等于把量化的收益藏起来了。
    // 量化的收益就是 24 → 12 字节（50%），RLE 在高熵数据上基本帮不上忙（见 README）。
    const rawBytes = payload.count * 24;
    return {
      particles: payload.count,
      sandEntries: sandBytes === 0 ? 0 : sandBytes,
      packedBytes: particleBytes + sandBytes,
      rawBytes,
      ratio: rawBytes === 0 ? 0 : (particleBytes + sandBytes) / rawBytes,
      ms: 0,
    };
  }

  /** 一行中文摘要（面板与日志用） */
  static describe(payload: FluidSavePayload): string {
    const stats = FluidSave.measure(payload);
    const ratio = stats.rawBytes > 0 ? (stats.ratio * 100).toFixed(0) : '—';
    return (
      `流体存档 v${payload.v}：${payload.count} 个粒子｜类型 ${payload.fluidType}｜` +
      `打包后 ${(stats.packedBytes / 1024).toFixed(1)} KB（原始 ${(stats.rawBytes / 1024).toFixed(1)} KB，${ratio}%）` +
      (payload.sand ? '｜含沙的湿度' : '')
    );
  }
}
