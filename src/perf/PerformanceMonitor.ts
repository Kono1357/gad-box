/**
 * 性能指标聚合（src/perf 模块 3/5）。
 *
 * ────────────────────────────────────────────────────────────
 * 它是什么，以及它**不是**什么
 * ────────────────────────────────────────────────────────────
 * 这个模块不做任何测量：它只是把已有的几路数据聚成**一份面板要读的指标对象**。
 *
 * - 帧时间与阶段耗时 → 交给 `FrameProfiler`（环形窗口 + 分位数 + 阶段拆解）；
 * - 慢帧事件 → 交给 `SlowFrameLogger`（阈值 + 去重 + 世界快照）；
 * - 资源类指标（JS 堆 / 几何 / 贴图 / 显存粗估）→ **复用 `ResourceMonitor` 的 `ResourceSnapshot`**，
 *   本模块不自己去读 `performance.memory`，也不自己数 geometry：
 *   同一个事实在两处各算一遍，迟早会出现两个不一样的面板数字。
 * - 物理耗时 / 休眠率 / 区块 / 冻结刚体 → 由调用方（Engine）在 `refreshResources()` 的 extra 里喂进来。
 *
 * 依赖方向刻意保持**单向**：只 `import type { ResourceSnapshot }`（类型），
 * 不 import three / Rapier / Engine，也不 import ResourceMonitor 的运行时值 ——
 * 所以这一层可以在 Node 里直接断言，不需要浏览器。
 *
 * ────────────────────────────────────────────────────────────
 * 两处"宁可显示没有，也不编造数字"的地方
 * ────────────────────────────────────────────────────────────
 * 1. **gcCount 是近似值**。浏览器不暴露 GC 次数：`performance.memory` 只有堆用量，
 *    `PerformanceObserver` 的 `gc` 条目只在部分浏览器实现。所以这里的做法是：
 *    能订阅 gc 条目就订阅（真实计数），订阅不到就退化成"堆用量比上次下降超过 5% 记一次"
 *    —— 那通常意味着刚发生过一次回收，但它也可能只是世界被卸载了。
 *    注释和 describe() 里都必须写明这是近似，不能让它看起来像精确值。
 * 2. **materials 只能由调用方统计**。`renderer.info.memory` 里只有 geometries / textures /
 *    programs，**没有材质计数**。这里默认返回 0 并如实标注"未统计"，
 *    绝不拿 geometries 冒充材质数 —— 编一个数字比留空更糟。
 */

import { FrameProfiler, type FrameStats } from './FrameProfiler';
import { SlowFrameLogger, type SlowFrameRecord } from './SlowFrameLogger';
import type { ResourceSnapshot } from '../world/ResourceMonitor';

export interface PerformanceMetrics {
  fps: number;
  frameTime: number;
  drawCalls: number;
  triangles: number;
  physicsTime: number;
  /** GC 次数：浏览器不暴露，用"堆下降次数"近似，并如实标注是近似 */
  gcCount: number;
  jsHeap: number | null;
  gpuMemory: number;
  geometries: number;
  materials: number;
  textures: number;
  /** 休眠率（物理）/ 可见区块 / 总区块 */
  sleepRatio: number;
  visibleChunks: number;
  totalChunks: number;
  /** 距离剔除冻结的刚体数 */
  frozenBodies: number;
}

/** 堆用量比上次下降超过这个比例，就近似认为发生过一次 GC */
const GC_DROP_RATIO = 0.05;
/** draw call 高到这个数，优先怀疑渲染提交次数（区块/实例没合批） */
const DRAW_CALL_HIGH = 350;
/** 三角形高到这个数，即使 draw call 不多也要怀疑几何本身太重 */
const TRIANGLES_HIGH = 800_000;
/** 物理耗时占单帧的比例超过这个值，就认定物理是瓶颈 */
const PHYSICS_SHARE_HIGH = 0.35;
/** 单帧超过这个毫秒数就算"超预算"，用于判断是否存在主线程脚本瓶颈 */
const FRAME_OVER_BUDGET_MS = 20;

export class PerformanceMonitor {
  readonly profiler: FrameProfiler;
  readonly slowLogger: SlowFrameLogger;

  private readonly current: PerformanceMetrics = {
    fps: 0,
    frameTime: 0,
    drawCalls: 0,
    triangles: 0,
    physicsTime: 0,
    gcCount: 0,
    jsHeap: null,
    gpuMemory: 0,
    geometries: 0,
    materials: 0,
    textures: 0,
    sleepRatio: 0,
    visibleChunks: 0,
    totalChunks: 0,
    frozenBodies: 0,
  };

  private frameIndex = 0;
  /** 上一次采样到的堆用量（MB），用于近似 GC 计数；null 表示浏览器不给堆数据 */
  private lastHeapUsedMB: number | null = null;
  /** 堆下降近似出来的回收次数 */
  private gcApprox = 0;
  /** PerformanceObserver 报上来的真实 gc 条目数（只有部分浏览器支持） */
  private gcObserved = 0;
  /** 慢帧记录里附带的"当时世界概况" */
  private worldHint: SlowFrameRecord['world'] | undefined;

  constructor(options: { frameWindow?: number; slowThresholdMs?: number } = {}) {
    this.profiler = new FrameProfiler({ windowSize: options.frameWindow ?? 120 });
    this.slowLogger = new SlowFrameLogger({
      thresholdMs: options.slowThresholdMs ?? this.profiler.budgetMs,
    });
    this.observeGC();
  }

  /**
   * 尝试订阅 GC 条目。失败是**预期内的**：Chrome / Firefox 支持，Safari 与部分
   * 内嵌 WebView 会直接抛异常，所以整段包在 try 里，失败就静默退回近似计数。
   */
  private observeGC(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'gc') this.gcObserved += 1;
        }
      });
      observer.observe({ entryTypes: ['gc'] } as PerformanceObserverInit);
    } catch {
      // 不支持 gc 条目：无视。gcCount 会由"堆下降近似"兜底，并在面板上标注近似。
    }
  }

  /** 每帧喂入最小必要信息；资源类指标由 refreshResources() 低频更新 */
  frame(input: { ms: number; phases?: Record<string, number>; context?: string }): void {
    const now = currentNow();
    this.frameIndex += 1;
    this.profiler.push(input.ms, input.phases, input.context, now);
    this.slowLogger.record(
      {
        index: this.frameIndex,
        ms: input.ms,
        phases: input.phases,
        context: input.context,
        world: this.worldHint,
      },
      now,
    );
  }

  /**
   * 低频（约 1 秒一次）刷新资源类指标；传入的是**已有的** ResourceSnapshot。
   *
   * - `snapshot === null`（还没采样过）时不抛异常，也不把已有数字清零 ——
   *   面板会在别处显示"暂无采样"，而不是突然从 120 个几何掉到 0。
   * - `extra` 用来补那些只能在 Engine 侧量到的数（物理耗时、休眠率、区块数、冻结刚体、材质数）。
   */
  refreshResources(snapshot: ResourceSnapshot | null, extra?: Partial<PerformanceMetrics>): void {
    if (snapshot) {
      this.current.drawCalls = snapshot.drawCalls;
      this.current.triangles = snapshot.triangles;
      this.current.geometries = snapshot.geometries;
      this.current.textures = snapshot.textures;
      this.current.gpuMemory = snapshot.estGpuMB;
      this.current.jsHeap = snapshot.heapUsedMB;

      // GC 近似：堆用量明显下降 ≈ 发生过一次回收。只有两边都有数时才比较。
      if (snapshot.heapUsedMB !== null) {
        const previous = this.lastHeapUsedMB;
        if (previous !== null && previous > 0 && snapshot.heapUsedMB < previous * (1 - GC_DROP_RATIO)) {
          this.gcApprox += 1;
        }
        this.lastHeapUsedMB = snapshot.heapUsedMB;
      }
    }

    if (extra) {
      for (const key of Object.keys(extra) as (keyof PerformanceMetrics)[]) {
        // 这两项由本模块自己维护（来自 ResourceSnapshot 与 gc 近似），不接受外部覆盖，
        // 否则面板上的堆用量可能同时有两个来源，迟早对不上。
        if (key === 'gcCount' || key === 'jsHeap') continue;
        assign(this.current, key, extra[key]);
      }
    }

    // 慢帧记录跟着带上当时的规模，便于按记录复现。
    // 放在 extra 之后再取刻意的：区块数（totalChunks）正是从 extra 来的，
    // 先取的话第一条快照会带上上一次的旧值。
    if (snapshot) {
      this.worldHint = {
        chunks: this.current.totalChunks,
        bodies: snapshot.physicsBodies,
        objects: snapshot.buildings,
      };
    }
  }

  get metrics(): PerformanceMetrics {
    this.syncDerived();
    return { ...this.current };
  }

  /** 把由其它字段推导出来的量算回 current：帧率、帧耗时、GC 总数 */
  private syncDerived(): void {
    const stats = this.profiler.stats;
    if (stats.count > 0) {
      this.current.frameTime = stats.average;
      this.current.fps = stats.fps;
    }
    // GC：能订阅到真实条目就用真实的，订阅不到就全算近似的。两者相加，
    // 因为近似那一部分只在"观察不到 gc 条目"时才有数，不会重复计。
    this.current.gcCount = this.gcObserved + this.gcApprox;
  }

  /** 面板用：完整中文摘要（含"当前瓶颈在哪"的一句判断） */
  describe(): string {
    this.syncDerived();
    const c = this.current;
    const heap =
      c.jsHeap === null ? '堆用量不可用（非 Chromium 内核）' : `堆 ${c.jsHeap.toFixed(1)} MB`;
    // 「（近似）」三个字必须跟着 gcCount 走，不能只在 tooltip 里写
    const gc = `GC 约 ${c.gcCount} 次（近似，浏览器不暴露真实次数）`;
    const physics =
      c.frameTime > 0 ? `${c.physicsTime.toFixed(1)} ms（占单帧 ${((c.physicsTime / c.frameTime) * 100).toFixed(0)}%）` : `${c.physicsTime.toFixed(1)} ms`;
    return (
      `${this.profiler.describe()}｜${this.slowLogger.describe()}｜` +
      `渲染 ${c.drawCalls} draw / ${c.triangles.toLocaleString('en-US')} 三角形｜` +
      `物理 ${physics}｜休眠率 ${(c.sleepRatio * 100).toFixed(0)}%` +
      `（冻结 ${c.frozenBodies}）｜区块 ${c.visibleChunks}/${c.totalChunks} 可见｜` +
      `${heap}｜显存粗估 ${c.gpuMemory.toFixed(0)} MB｜几何 ${c.geometries} / 贴图 ${c.textures} / 材质 ${c.materials === 0 ? '未统计' : String(c.materials)}｜` +
      `${gc}｜诊断：${this.diagnose().advice}`
    );
  }

  /**
   * 瓶颈判断：根据帧耗时构成给出"现在最可能是什么在拖慢"的中文结论。
   *
   * 判断顺序是有意为之（从"证据最硬"到"只能猜"）：
   * 1. 物理耗时占比高 → 物理求解；
   * 2. draw call / 三角形过高 → 渲染提交或几何量；
   * 3. 都不是但单帧确实超预算 → 只能说是主线程里的脚本（网格重建、模拟步进、GC）；
   * 4. 否则 → 没有明显瓶颈。
   */
  diagnose(): { bottleneck: 'render' | 'physics' | 'script' | 'unknown'; advice: string } {
    // 必须先同步派生量：frameTime / fps 是由帧窗口算出来的，
    // 而调用方很可能在 refreshResources() 之后直接问诊断，中间没人读过 metrics ——
    // 那时 current.frameTime 还是 0，会得到"暂无可判断的数据"这种误导性结论。
    this.syncDerived();
    const c = this.current;
    const frameTime = c.frameTime > 0 ? c.frameTime : 0;
    const share = frameTime > 0 ? c.physicsTime / frameTime : 0;

    if (c.physicsTime > 0 && share >= PHYSICS_SHARE_HIGH) {
      return {
        bottleneck: 'physics',
        advice:
          `物理求解是瓶颈：单帧物理 ${c.physicsTime.toFixed(1)} ms，占 ${(share * 100).toFixed(0)}%。` +
          `可以降物理精度（降低分帧预算、减少子步，别去降求解器迭代——那会让同样的塔突然不倒）或开距离剔除。`,
      };
    }

    if (c.drawCalls >= DRAW_CALL_HIGH || c.triangles >= TRIANGLES_HIGH) {
      return {
        bottleneck: 'render',
        advice:
          `渲染提交次数多：${c.drawCalls} draw call / ${c.triangles.toLocaleString('en-US')} 三角形，` +
          `可能是区块或实例没合批、可见区块太多。可以降渲染距离、合并同材质网格、打开视锥剔除。`,
      };
    }

    if (frameTime > FRAME_OVER_BUDGET_MS) {
      return {
        bottleneck: 'script',
        advice:
          `单帧 ${frameTime.toFixed(1)} ms 已经超预算，但物理与渲染提交都不高：` +
          `大概率是主线程脚本（区块网格重建 / 体素模拟步进 / GC）。看阶段拆解里耗时最高的那一项。`,
      };
    }

    return {
      bottleneck: 'unknown',
      advice: frameTime > 0 ? `帧时间 ${frameTime.toFixed(1)} ms，暂无明显瓶颈。` : '暂无可判断的数据。',
    };
  }

  /** 帧分析快照（面板直接读，免得它自己再调一次 profiler） */
  get frameStats(): FrameStats {
    return this.profiler.stats;
  }

  reset(): void {
    this.profiler.clear();
    this.slowLogger.clear();
    this.frameIndex = 0;
    this.lastHeapUsedMB = null;
    this.gcApprox = 0;
    this.gcObserved = 0;
    this.worldHint = undefined;
    this.current.fps = 0;
    this.current.frameTime = 0;
    this.current.drawCalls = 0;
    this.current.triangles = 0;
    this.current.physicsTime = 0;
    this.current.gcCount = 0;
    this.current.jsHeap = null;
    this.current.gpuMemory = 0;
    this.current.geometries = 0;
    this.current.materials = 0;
    this.current.textures = 0;
    this.current.sleepRatio = 0;
    this.current.visibleChunks = 0;
    this.current.totalChunks = 0;
    this.current.frozenBodies = 0;
  }
}

function currentNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 按 key 赋值的小工具：`Partial<PerformanceMetrics>` 的键是联合类型，
 * 直接 `target[key] = value` 在 strict 下会被判成 `never`，这里用泛型把类型对上。
 */
function assign<K extends keyof PerformanceMetrics>(
  target: PerformanceMetrics,
  key: K,
  value: PerformanceMetrics[K] | undefined,
): void {
  if (value === undefined) return;
  target[key] = value;
}
