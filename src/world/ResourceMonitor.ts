/**
 * 资源监视器（问题 4.3 + 补充 4）。
 *
 * 玩家反馈「反复切换地图之后越来越卡、最后崩掉」——原因是**换地图时旧世界没被真正释放**：
 * 体素数组、区块 geometry、建筑 InstancedMesh、Rapier 刚体、命令历史全都还挂在内存里，
 * 只是没人引用它们了而已。这个模块负责把「现在到底占了多少」量化出来，让问题看得见。
 *
 * 三层指标，各自来源不同，**精度也完全不同，必须如实标注**：
 *
 * 1. **JS 堆**：只有 Chromium 系浏览器提供 `performance.memory`。拿不到时一律返回 null，
 *    而不是用「估算值」冒充真值 —— 这个项目不做假数据。
 * 2. **GPU 侧**：从 Three.js 的 `renderer.info` 读 geometry / texture / program 计数，
 *    并按顶点数与贴图像素数**粗估**显存占用。粗估就是粗估，面板里会写「估算」。
 * 3. **世界侧**：体素字节数、建筑数、物理体数、关节数 —— 这些是自己分配的内存，能算准。
 *
 * 手动回收（补充 4.2）：优先调 `window.gc()`（Chrome 加 `--js-flags="--expose-gc"` 才有），
 * 拿不到就用「主动清空引用 + 触发一次完整渲染」的办法把能释放的先释放掉，
 * 并**明确告诉用户这一步只是尽力而为**。
 */

/** 一次采样 */
export interface ResourceSnapshot {
  atMs: number;
  /** JS 堆已用（MB）；浏览器不支持时为 null */
  heapUsedMB: number | null;
  /** JS 堆总量（MB）；不支持时 null */
  heapTotalMB: number | null;
  /** JS 堆上限（MB）；不支持时 null */
  heapLimitMB: number | null;
  /** Three.js 里的 geometry 数 */
  geometries: number;
  /** Three.js 里的 texture 数 */
  textures: number;
  /** 编译过的 shader program 数 */
  programs: number;
  /** 上一帧 draw call */
  drawCalls: number;
  /** 上一帧三角形 */
  triangles: number;
  /** 体素数据自身占用（MB），由 Uint8Array 字节数算出，**准的** */
  voxelMB: number;
  /** 建筑实例数 */
  buildings: number;
  /** Rapier 刚体数 */
  physicsBodies: number;
  /** 关节数 */
  joints: number;
  /** 触发器数 */
  triggers: number;
  /** 显存粗估（MB，按几何顶点 + 贴图像素 × 4 字节），**估算值** */
  estGpuMB: number;
  /** 触发器/关节等模拟子系统自身的耗时 */
  note?: string;
}

/** 换世界前后的内存对比 */
export interface SwitchMemoryRecord {
  label: string;
  startedMs: number;
  finishedMs: number;
  /** 换之前的快照 */
  before: ResourceSnapshot | null;
  /** 换之后的快照 */
  after: ResourceSnapshot | null;
  /** 释放动作的条数（由 WorldUnloader 报告） */
  releasedItems: number;
  /** 堆变化（MB）；无 performance.memory 时为 null */
  heapDeltaMB: number | null;
  /** GPU 对象数变化 */
  geometryDelta: number;
  textureDelta: number;
  /** 用时（毫秒） */
  ms: number;
}

/** 采样输入：调用方（Engine）把当前世界的事实喂进来 */
export interface ResourceSampleInput {
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  /** 体素总格数（含空气），用来算体素数组字节数 */
  voxelCapacity: number;
  /** 另有一份等大的水位数组 */
  waterCapacity: number;
  buildings: number;
  physicsBodies: number;
  joints?: number;
  triggers?: number;
  note?: string;
}

/** 保留多少条历史采样（约 1 分钟 @ 每 500ms 一次） */
const HISTORY_LIMIT = 120;
/** 采样节流（毫秒）：面板刷新频率远低于帧率，没必要每帧采 */
export const SAMPLE_INTERVAL_MS = 500;

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readPerformanceMemory(): PerformanceMemory | null {
  if (typeof performance === 'undefined') return null;
  const memory = (performance as unknown as { memory?: PerformanceMemory }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
  return memory;
}

/** `window.gc` 是否存在（Chrome 需要 --js-flags="--expose-gc"） */
export function hasForceGC(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as unknown as { gc?: () => void }).gc === 'function';
}

export class ResourceMonitor {
  private readonly samples: ResourceSnapshot[] = [];
  private readonly switches: SwitchMemoryRecord[] = [];
  private pendingSwitch: { label: string; startedMs: number; before: ResourceSnapshot | null } | null = null;
  private lastSampleMs = 0;

  get latest(): ResourceSnapshot | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1]! : null;
  }

  get history(): readonly ResourceSnapshot[] {
    return this.samples;
  }

  get switchLog(): readonly SwitchMemoryRecord[] {
    return this.switches;
  }

  /** 浏览器是否提供 JS 堆数据（面板据此决定是否显示「—」而不是假装有数） */
  get hasHeapData(): boolean {
    return readPerformanceMemory() !== null;
  }

  /** 是否可以强制 GC */
  get canForceGC(): boolean {
    return hasForceGC();
  }

  /**
   * 采样一次。节流：距上次采样不足 `intervalMs` 时返回上一次的结果（不产生新样本）。
   * `force = true` 时忽略节流——换世界前后必须拿到准确的两个点。
   */
  sample(input: ResourceSampleInput, nowMs: number, force = false, intervalMs = SAMPLE_INTERVAL_MS): ResourceSnapshot {
    const last = this.latest;
    if (!force && last && nowMs - this.lastSampleMs < intervalMs) return last;

    const memory = readPerformanceMemory();
    // 体素：type 数组 + water 数组，都是 Uint8Array，一字节一格
    const voxelBytes = (input.voxelCapacity + input.waterCapacity) * 1;
    const snapshot: ResourceSnapshot = {
      atMs: nowMs,
      heapUsedMB: memory ? memory.usedJSHeapSize / 1048576 : null,
      heapTotalMB: memory ? memory.totalJSHeapSize / 1048576 : null,
      heapLimitMB: memory ? memory.jsHeapSizeLimit / 1048576 : null,
      geometries: input.geometries,
      textures: input.textures,
      programs: input.programs,
      drawCalls: input.drawCalls,
      triangles: input.triangles,
      voxelMB: voxelBytes / 1048576,
      buildings: input.buildings,
      physicsBodies: input.physicsBodies,
      joints: input.joints ?? 0,
      triggers: input.triggers ?? 0,
      estGpuMB: estimateGpuMB(input.geometries, input.textures),
      note: input.note,
    };

    this.lastSampleMs = nowMs;
    if (force) this.samples.push(snapshot);
    else {
      this.samples.push(snapshot);
      while (this.samples.length > HISTORY_LIMIT) this.samples.shift();
    }
    return snapshot;
  }

  /** 换世界开始：记下当前快照作为基准 */
  beginSwitch(label: string, nowMs: number): void {
    this.pendingSwitch = { label, startedMs: nowMs, before: this.latest };
  }

  /** 换世界结束：写入一条对比记录 */
  endSwitch(after: ResourceSnapshot | null, releasedItems: number, nowMs: number): SwitchMemoryRecord | null {
    const pending = this.pendingSwitch;
    if (!pending) return null;
    this.pendingSwitch = null;

    const before = pending.before;
    const record: SwitchMemoryRecord = {
      label: pending.label,
      startedMs: pending.startedMs,
      finishedMs: nowMs,
      before,
      after,
      releasedItems,
      heapDeltaMB:
        before && after && before.heapUsedMB !== null && after.heapUsedMB !== null
          ? after.heapUsedMB - before.heapUsedMB
          : null,
      geometryDelta: after && before ? after.geometries - before.geometries : 0,
      textureDelta: after && before ? after.textures - before.textures : 0,
      ms: nowMs - pending.startedMs,
    };
    this.switches.push(record);
    while (this.switches.length > 12) this.switches.shift();
    return record;
  }

  /**
   * 手动回收内存（补充 4.2）。
   *
   * 这里必须对用户说实话：JS 没有「立即释放」这回事，我们能做的只有两件事——
   * 1. 有 `window.gc` 就调一次（Chrome 的 `--expose-gc` / DevTools 的 collectGarbage）；
   * 2. 没有的话，清掉我们自己的历史采样（这是本模块唯一持有的、有上限的引用），
   *    并把结果如实告诉用户「建议刷新页面」。
   *
   * 返回值里的 `note` 会原样显示在面板上，不做美化。
   */
  collectGarbage(): { ok: boolean; note: string; droppedSamples: number } {
    const dropped = this.samples.length;
    const gc = typeof window !== 'undefined' ? (window as unknown as { gc?: () => void }).gc : undefined;
    if (typeof gc === 'function') {
      try {
        gc();
        this.samples.length = 0;
        this.lastSampleMs = 0;
        return {
          ok: true,
          note: `已调用 window.gc()，并清掉 ${dropped} 条历史采样。注意：GC 只回收「没人引用」的对象，` +
            `如果你还能看到内存没降，说明确实还有引用没断开。`,
          droppedSamples: dropped,
        };
      } catch (error) {
        return {
          ok: false,
          note: `window.gc() 调用失败：${error instanceof Error ? error.message : String(error)}`,
          droppedSamples: 0,
        };
      }
    }
    this.samples.length = 0;
    this.lastSampleMs = 0;
    return {
      ok: false,
      note:
        `当前浏览器没有开放 window.gc（Chrome 需要启动参数 --js-flags="--expose-gc"）。` +
        `已清掉 ${dropped} 条历史采样；真正的堆回收只能等浏览器自己决定。` +
        `如果连续切换地图后内存一直涨，请刷新页面。`,
      droppedSamples: dropped,
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.switches.length = 0;
    this.pendingSwitch = null;
    this.lastSampleMs = 0;
  }
}

/**
 * 显存粗估。
 *
 * 做法：每个 geometry 按「顶点属性 + 索引」估一个常量，每张贴图按 512×512 RGBA 估。
 * 这是**非常粗**的估计——真实占用取决于驱动、纹理格式、mipmap、压缩。
 * 之所以还留着它，是因为它能反映「相对趋势」：切换地图后这个数如果一路涨，就一定有东西没释放。
 */
export function estimateGpuMB(geometries: number, textures: number): number {
  const perGeometryMB = 0.12;
  const perTextureMB = 1.0; // 512×512×4 ≈ 1 MB，本项目图集就是这个尺寸
  return geometries * perGeometryMB + textures * perTextureMB;
}

/** 一行中文摘要，面板顶部用 */
export function describeSnapshot(snapshot: ResourceSnapshot | null): string {
  if (!snapshot) return '暂无采样';
  const heap = snapshot.heapUsedMB === null ? '堆数据不可用（非 Chromium 内核）' : `堆 ${snapshot.heapUsedMB.toFixed(1)} MB`;
  return `${heap}｜几何 ${snapshot.geometries} / 贴图 ${snapshot.textures}｜体素数据 ${snapshot.voxelMB.toFixed(1)} MB｜显存粗估 ${snapshot.estGpuMB.toFixed(0)} MB`;
}
