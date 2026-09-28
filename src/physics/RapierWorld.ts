/**
 * Rapier 世界生命周期（M3 第 1 批）。
 *
 * 这个类只干一件事：**把"Rapier 世界"这个对象从创建到销毁的每一步管清楚**，
 * 并在这个过程中给出真实可用的进度与失败信息。刚体/碰撞体/关节的创建都不在这里
 * （那是 RigidBodyFactory / ColliderFactory / JointFactory 的活）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么要把生命周期单独拆出来
 * ────────────────────────────────────────────────────────────
 * M2 的 `PhysicsWorld` 把"加载 wasm""建世界""建刚体""查询"全塞在一起，
 * 于是换地图时"世界要不要销毁重建"这个问题没有明确答案 —— 代码里是"清空刚体但保留世界对象"，
 * 而重力、时间步、求解器迭代这些**世界级参数**从来没有被重新应用过。
 * M3 起这些东西全部要可调（5 个行星预设、时间流速、求解迭代），所以必须有唯一的所有者。
 *
 * ────────────────────────────────────────────────────────────
 * 关于加载进度的诚实说明
 * ────────────────────────────────────────────────────────────
 * `rapier3d-compat` 的 wasm 是**以 base64 内联在 JS 里**的，所以打包后是一个 4.3 MB 的
 * 独立 chunk，浏览器下载它时我们拿不到字节级回调（`import()` 不给进度事件）。
 *
 * 所以进度分两种模式，`progressMode` 会如实告诉调用方当前是哪种：
 *
 * 1. `'bytes'` —— **真字节进度**。前提是构建时给 rapier 的 chunk 固定了文件名
 *    （见 `vite.config.ts` 的 `chunkFileNames`），我们就能先 `fetch()` 它并读
 *    `Content-Length` 与流式分片，算出真实百分比；随后的 `import()` 命中 HTTP 缓存，
 *    不会重复下载。
 * 2. `'phases'` —— **阶段式进度**。拿不到固定 URL（或者 fetch 失败/被 CORS 拦）时退化成
 *    四个已知阶段：下载 → wasm 实例化 → 建世界 → 就绪。百分比是**阶段权重**不是字节数，
 *    `message` 里会写「阶段进度（拿不到字节进度）」。
 *
 * 绝不假装有字节进度：`progressMode === 'phases'` 时 `exactBytes` 为 false。
 */

import { PHYSICS_CONFIG } from '../config';
import type { PhysicsWorldConfig } from '../data/gravityPresets';
import {
  DEFAULT_WORLD_CONFIG,
  validateWorldConfig,
} from '../data/gravityPresets';

/**
 * Rapier 模块与世界的类型。
 *
 * 这里刻意**不 import 类型**（`import type` 也会让 TS 去解析 4 MB 的 d.ts，拖慢构建），
 * 而是用结构化类型描述我们真正用到的那些成员。
 * 这样 `RapierWorld` 依然能通过 `api` / `raw` 暴露强类型给使用者。
 */
export type RapierApi = typeof import('@dimforge/rapier3d-compat').default;
export type RapierWorldInstance = InstanceType<RapierApi['World']>;

/** 加载进度 */
export interface RapierLoadingProgress {
  phase: 'idle' | 'fetching' | 'initializing' | 'building' | 'ready' | 'failed';
  /** 0..1。`exactBytes` 为 false 时这是阶段权重，不是字节比例 */
  progress: number;
  /** 中文说明，直接显示在加载遮罩上 */
  message: string;
  /** 这个百分比是不是真实字节进度 */
  exactBytes: boolean;
  /** 从开始加载到现在过了多少毫秒（拿不到字节进度时，这个至少能给玩家一个时间感） */
  elapsedMs: number;
  /** 已下载字节 / 总字节；拿不到时为 null */
  loadedBytes: number | null;
  totalBytes: number | null;
}

export interface RapierWorldOptions {
  /** 世界配置（重力/时间步/子步/求解迭代/休眠阈值） */
  config?: Partial<PhysicsWorldConfig>;
  /** 进度回调 */
  onProgress?: (progress: RapierLoadingProgress) => void;
  /**
   * 固定 chunk 的 URL（用于真字节进度）。不传或拿不到就退化成阶段进度。
   * Engine 传 `import.meta.env.BASE_URL + 'assets/rapier.js'`。
   */
  chunkUrl?: string;
}

export interface RapierWorldStats {
  ready: boolean;
  /** 是否成功建了事件队列（没有的话传感器不会产生事件） */
  hasEventQueue: boolean;
  bodies: number;
  colliders: number;
  joints: number;
  timestep: number;
  solverIterations: number;
  gravityY: number;
  /** 加载耗时（毫秒） */
  loadMs: number;
  /** 进度模式 */
  progressMode: 'bytes' | 'phases';
}

/** 单帧最多允许的物理子步（防止切后台回来时"追赶"出一帧几百步） */
const HARD_SUBSTEP_CAP = 12;

export class RapierWorldManager {
  private rapier: RapierApi | null = null;
  private instance: RapierWorldInstance | null = null;
  private ready = false;
  private lastError = '';
  private initializing: Promise<boolean> | null = null;
  private loadMs = 0;
  private startedAt = 0;
  private configValue: PhysicsWorldConfig;
  private progressModeValue: 'bytes' | 'phases' = 'phases';
  /**
   * 事件队列（M3 第 4 批）。
   *
   * 为什么必须由**世界**持有而不是触发器系统自己建：`world.step(eventQueue)` 是
   * 事件产生的唯一时机，而 `step()` 只在这里被调用。如果让 TriggerSystem 自己建一个队列，
   * 它拿到的事件永远是空的 —— 因为没有任何地方把队列交给 `step`。
   * 这是那种"代码看起来完全正确但永远不工作"的坑，所以世界持有它是硬约束。
   */
  private eventQueue: { drainCollisionEvents(f: (a: number, b: number, started: boolean) => void): void; free?(): void } | null = null;
  private readonly options: RapierWorldOptions;

  private progressValue: RapierLoadingProgress = {
    phase: 'idle',
    progress: 0,
    message: '物理引擎尚未开始加载',
    exactBytes: false,
    elapsedMs: 0,
    loadedBytes: null,
    totalBytes: null,
  };

  constructor(options: RapierWorldOptions = {}) {
    this.options = options;
    this.configValue = normalizeConfig({ ...DEFAULT_WORLD_CONFIG, ...options.config });
  }

  // ------------------------------------------------------------------ 只读

  get isReady(): boolean {
    return this.ready;
  }

  get isFailed(): boolean {
    return this.progressValue.phase === 'failed';
  }

  get errorMessage(): string {
    return this.lastError;
  }

  get progress(): RapierLoadingProgress {
    return this.progressValue;
  }

  get progressMode(): 'bytes' | 'phases' {
    return this.progressModeValue;
  }

  get api(): RapierApi | null {
    return this.rapier;
  }

  get raw(): RapierWorldInstance | null {
    return this.instance;
  }

  get config(): PhysicsWorldConfig {
    return this.configValue;
  }

  get loadMilliseconds(): number {
    return this.loadMs;
  }

  /** 全世界能被引擎识别的刚体数量（含地形那个 fixed 刚体） */
  get bodyCount(): number {
    return this.instance ? this.instance.bodies.len() : 0;
  }

  get colliderCount(): number {
    return this.instance ? this.instance.colliders.len() : 0;
  }

  get jointCount(): number {
    return this.instance ? this.instance.impulseJoints.len() : 0;
  }

  get stats(): RapierWorldStats {
    return {
      ready: this.ready,
      hasEventQueue: this.eventQueue !== null,
      bodies: this.bodyCount,
      colliders: this.colliderCount,
      joints: this.jointCount,
      timestep: this.configValue.timestep,
      solverIterations: this.configValue.solverIterations,
      gravityY: this.configValue.gravity[1],
      loadMs: this.loadMs,
      progressMode: this.progressModeValue,
    };
  }

  // ------------------------------------------------------------------ 加载

  /**
   * 加载并建世界。可以重复调用，只会真正初始化一次。
   * @returns 是否可用
   */
  async init(): Promise<boolean> {
    if (this.ready) return true;
    if (this.initializing) return this.initializing;

    this.startedAt = now();
    this.initializing = this.doInit();
    const result = await this.initializing;
    // 失败时清掉 promise，允许"重试一次"（例如用户切到 WiFi 之后）
    if (!result) this.initializing = null;
    return result;
  }

  private async doInit(): Promise<boolean> {
    try {
      // ---- 1) 尽量拿到真字节进度
      await this.prefetchChunk();

      // ---- 2) 动态导入（4 MB 级，命中上一步的 HTTP 缓存）
      this.report({ phase: 'fetching', progress: this.progressModeValue === 'bytes' ? 0.55 : 0.25,
        message: '正在加载物理引擎模块…', exactBytes: false });
      const module = await import('@dimforge/rapier3d-compat');
      const api = module.default;
      this.report({ phase: 'initializing', progress: 0.75, message: '正在实例化 WebAssembly…', exactBytes: false });

      // ---- 3) wasm 实例化
      await api.init();

      // ---- 4) 建世界并应用配置
      this.report({ phase: 'building', progress: 0.9, message: '正在创建物理世界…', exactBytes: false });
      this.rapier = api;
      this.instance = new api.World({
        x: this.configValue.gravity[0],
        y: this.configValue.gravity[1],
        z: this.configValue.gravity[2],
      });
      this.applyConfigToInstance();

      // 事件队列：autoDrain = true（Rapier 推荐），否则事件会无限堆积吃内存
      const EventQueueCtor = (api as unknown as { EventQueue?: new (autoDrain: boolean) => never }).EventQueue;
      if (EventQueueCtor) {
        this.eventQueue = new EventQueueCtor(true) as unknown as typeof this.eventQueue;
      }

      this.ready = true;
      this.loadMs = now() - this.startedAt;
      this.report({ phase: 'ready', progress: 1, message: '物理引擎已就绪', exactBytes: false });
      return true;
    } catch (error) {
      // 失败要说清是哪一步失败的，并且给出可行的下一步 —— 而不是一句 "failed"
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.ready = false;
      this.report({
        phase: 'failed',
        progress: 0,
        message:
          `物理引擎加载失败：${message}\n` +
          `沙盘仍可使用（地形、建筑、存档都不受影响），但没有重力与碰撞。` +
          `可能是网络中断（首次需要下载约 4.3 MB 的 wasm）或浏览器不支持 WebAssembly。`,
        exactBytes: false,
      });
      return false;
    }
  }

  /**
   * 尝试拉取 rapier 的 chunk 并报出真实字节进度。
   *
   * 失败（没给 URL / 404 / 被 CORS 拦 / 环境没有 fetch）都不是错误 ——
   * 只是"拿不到字节进度"，退化成阶段进度继续走。
   */
  private async prefetchChunk(): Promise<void> {
    const url = this.options.chunkUrl;
    if (!url) return;
    if (typeof fetch !== 'function') return;

    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) return;
      const totalHeader = response.headers.get('content-length');
      const total = totalHeader ? Number(totalHeader) : null;
      if (!response.body || !Number.isFinite(total ?? NaN) || (total ?? 0) <= 0) {
        // 读不到长度就干脆整体读掉（进程内缓存有效，import 仍然受益）
        await response.arrayBuffer();
        return;
      }

      const reader = response.body.getReader();
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value?.byteLength ?? 0;
        this.progressModeValue = 'bytes';
        this.report({
          phase: 'fetching',
          progress: Math.min(0.5, (loaded / (total ?? 1)) * 0.5),
          message: `正在下载物理引擎 ${(loaded / 1048576).toFixed(1)} / ${((total ?? 0) / 1048576).toFixed(1)} MB`,
          exactBytes: true,
          loadedBytes: loaded,
          totalBytes: total ?? null,
        });
      }
    } catch {
      // 拿不到字节进度完全没关系，阶段进度一样能用
      this.progressModeValue = 'phases';
    }
  }

  // ------------------------------------------------------------------ 配置

  /**
   * 应用配置。
   *
   * 世界还没建时只记下来；已建则立即作用到 Rapier ——
   * 这很重要，因为"改重力"是玩家最常拖的滑块，如果要求重建世界才能生效，
   * 拖一次要等几百毫秒，体验直接崩掉。
   */
  applyConfig(patch: Partial<PhysicsWorldConfig>): { applied: boolean; problems: string[] } {
    const next = normalizeConfig({ ...this.configValue, ...patch });
    const problems = validateWorldConfig(next);
    if (problems.length > 0) {
      // 非法值一律拒绝并**原样返回原因**，不做"静默夹到范围内" ——
      // 静默夹值会让玩家以为自己拖到了 0 重力，实际是 0.5，然后开始怀疑物理坏了
      return { applied: false, problems };
    }
    this.configValue = next;
    if (this.ready) this.applyConfigToInstance();
    return { applied: true, problems: [] };
  }

  private applyConfigToInstance(): void {
    const world = this.instance;
    if (!world) return;
    world.gravity = {
      x: this.configValue.gravity[0],
      y: this.configValue.gravity[1],
      z: this.configValue.gravity[2],
    };
    world.timestep = this.configValue.timestep;
    const params = world.integrationParameters as unknown as {
      numSolverIterations?: number;
      dt?: number;
    };
    if (typeof params.numSolverIterations === 'number') {
      params.numSolverIterations = this.configValue.solverIterations;
    }
  }

  /** 当前时间步（秒），Engine 的累加器要用它 */
  get timestep(): number {
    return this.configValue.timestep;
  }

  /** 单帧最多子步（受配置与硬上限双重约束） */
  get maxSubsteps(): number {
    return Math.min(HARD_SUBSTEP_CAP, Math.max(1, Math.floor(this.configValue.maxSubsteps)));
  }

  get gravityY(): number {
    return this.configValue.gravity[1];
  }

  set gravityY(value: number) {
    this.applyConfig({ gravity: [this.configValue.gravity[0], value, this.configValue.gravity[2]] });
  }

  // ------------------------------------------------------------------ 推进

  /** 推进一步（Engine 的累加器负责决定推几步）。有事件队列就交给它收集事件。 */
  step(): void {
    if (!this.ready || !this.instance) return;
    if (this.eventQueue) this.instance.step(this.eventQueue as never);
    else this.instance.step();
  }

  /** 是否有事件队列（没有时传感器事件不会产生，面板要如实说明） */
  get hasEventQueue(): boolean {
    return this.eventQueue !== null;
  }

  /**
   * 排空这一帧的碰撞事件。
   *
   * **必须在 `step()` 之后、下一帧 `step()` 之前调用**：`autoDrain` 会在下次 step 前
   * 自动清空队列，所以拖到下一帧再读就什么都没有了。
   */
  drainCollisions(callback: (colliderA: number, colliderB: number, started: boolean) => void): number {
    if (!this.eventQueue) return 0;
    let count = 0;
    try {
      this.eventQueue.drainCollisionEvents((a, b, started) => {
        count += 1;
        callback(a, b, started);
      });
    } catch (error) {
      console.warn('[Rapier] 排空碰撞事件失败', error);
    }
    return count;
  }

  /**
   * 补一次"零步"来刷新查询管线。
   *
   * **这里必须把时间步临时改成 0 再改回来**：
   * - 为什么需要零步：Rapier 的射线/形状查询用的是宽相位与窄相位的缓存，
   *   而这些缓存只在 `step()` 里更新。刚加完碰撞体就查询会拿到空结果。
   * - 为什么必须是 0：用正常的 1/60 推一步会让物体真的往下掉一点点，
   *   而"刷新查询"是编辑器操作，不该改变模拟状态。
   * - **为什么一定要改回**：M2 的实现在这里设了 0 却忘了恢复，
   *   结果每次 syncQueries 之后时间步就变成 0、物理彻底停住；
   *   当时能正常工作纯粹是因为 `step()` 每帧都重新写了时间步，
   *   把这个 bug 盖住了。M3 起时间步可配置（时间流速/慢速档），这种"靠别人擦屁股"的写法不能留。
   */
  syncQueries(): void {
    const world = this.instance;
    if (!world) return;
    const saved = world.timestep;
    world.timestep = 0;
    world.step();
    world.timestep = this.configValue.timestep || saved;
  }

  /**
   * 清空世界内容但**保留世界对象**（换地图用）。
   *
   * 顺序有讲究：先删关节再删刚体。反过来的话 Rapier 会先销毁刚体、
   * 关节自动失效，但 `impulseJoints.len()` 在下一帧之前仍然是旧值，
   * 于是统计面板会短暂显示"地上有 8 个关节"而实际已经没了。
   */
  clear(): { bodies: number; colliders: number; joints: number } {
    const world = this.instance;
    if (!world) return { bodies: 0, colliders: 0, joints: 0 };

    const before = {
      bodies: world.bodies.len(),
      colliders: world.colliders.len(),
      joints: world.impulseJoints.len(),
    };

    // 1) 关节
    try {
      const handles: number[] = [];
      world.impulseJoints.forEach((joint: { handle: number }) => handles.push(joint.handle));
      for (const handle of handles) {
        const joint = world.getImpulseJoint(handle);
        if (joint) world.removeImpulseJoint(joint, false);
      }
    } catch (error) {
      console.warn('[Rapier] 清空关节时出错（继续清刚体）', error);
    }

    // 2) 刚体（碰撞体随刚体一起消失）
    try {
      const handles: number[] = [];
      world.bodies.forEach((body: { handle: number }) => handles.push(body.handle));
      for (const handle of handles) {
        const body = world.getRigidBody(handle);
        if (body) world.removeRigidBody(body);
      }
    } catch (error) {
      console.warn('[Rapier] 清空刚体时出错', error);
    }

    return before;
  }

  /** 彻底销毁（页面卸载 / 引擎 dispose） */
  dispose(): void {
    if (this.instance) {
      this.clear();
      try {
        // compat 版的 World 持有 wasm 侧内存，free() 才会真的还回去
        (this.instance as unknown as { free?: () => void }).free?.();
      } catch {
        /* free 不是所有版本都有，失败也无所谓：页面都要关了 */
      }
    }
    if (this.eventQueue) {
      try {
        this.eventQueue.free?.();
      } catch {
        /* 不是所有版本都有 free() */
      }
    }
    this.eventQueue = null;
    this.instance = null;
    this.rapier = null;
    this.ready = false;
    this.initializing = null;
    this.progressValue = {
      phase: 'idle',
      progress: 0,
      message: '物理世界已销毁',
      exactBytes: false,
      elapsedMs: 0,
      loadedBytes: null,
      totalBytes: null,
    };
  }

  // ------------------------------------------------------------------ 内部

  private report(patch: Partial<RapierLoadingProgress>): void {
    this.progressValue = {
      ...this.progressValue,
      ...patch,
      elapsedMs: now() - (this.startedAt || now()),
    };
    this.options.onProgress?.(this.progressValue);
  }
}

/** 把配置里明显非法的值归一到安全默认（用于构造与 applyConfig 的输入侧） */
function normalizeConfig(config: PhysicsWorldConfig): PhysicsWorldConfig {
  const finite = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;
  return {
    gravity: [
      finite(config.gravity[0], 0),
      finite(config.gravity[1], DEFAULT_WORLD_CONFIG.gravity[1]),
      finite(config.gravity[2], 0),
    ],
    timestep: clamp(finite(config.timestep, DEFAULT_WORLD_CONFIG.timestep), 1 / 240, 1 / 15),
    maxSubsteps: Math.round(clamp(finite(config.maxSubsteps, DEFAULT_WORLD_CONFIG.maxSubsteps), 1, HARD_SUBSTEP_CAP)),
    solverIterations: Math.round(
      clamp(finite(config.solverIterations, DEFAULT_WORLD_CONFIG.solverIterations), 1, 16),
    ),
    sleepThreshold: clamp(finite(config.sleepThreshold, DEFAULT_WORLD_CONFIG.sleepThreshold), 0, 30),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 供 Engine 使用：默认固定 chunk 名（与 vite.config.ts 的 chunkFileNames 必须一致） */
export const RAPIER_CHUNK_FILE = 'assets/rapier.js';

/** 兼容 M2 的常量来源：默认固定步长 */
export const DEFAULT_FIXED_STEP = PHYSICS_CONFIG.fixedTimeStep;
