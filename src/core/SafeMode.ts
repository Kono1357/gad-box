/**
 * 安全模式（M5 第 1 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它是什么、又不是什么
 * ────────────────────────────────────────────────────────────
 * 它**只是一个状态 + 一份清单**。它不认识 Engine、不认识 Three.js、不认识 DOM，
 * 也**永远不会去关任何东西** —— 关的动作由 Engine 照着 `restrictions` 做。
 * 这么分有两个实打实的好处：
 * 1. 可以断言（`scripts/checks/errors.check.ts` 在 Node 里把进入/退出/清单/文案全测一遍），
 *    而"引擎里到底关成了没有"这种问题没法在 Node 里测；
 * 2. 不会出现"清单里写了关阴影、代码里忘了关"这种**两边不一致**的状态 ——
 *    因为只有一份清单，Engine 是照抄它、不是另写一份。
 *
 * ────────────────────────────────────────────────────────────
 * 什么时候该进安全模式（判断在调用方，这里只收理由）
 * ────────────────────────────────────────────────────────────
 * 共同特征都是"这台设备/这一次打开已经不正常了，先保证能开起来"：
 * WebGL 上下文建不起来、换世界时加载失败、本地存档读出来是坏的、
 * 短时间内错误太多（`ErrorHandler` 报的）、或者玩家自己点了。
 * 判断逻辑放在 Engine：它才知道"刚才那一步是不是关键的初始化步骤"。
 *
 * ────────────────────────────────────────────────────────────
 * 清单里的数字都是**有出处的**，不是随手写的
 * ────────────────────────────────────────────────────────────
 * - 粒子上限：正常值来自 `fluid/FluidPresets.ts` 的 `particleLimitFor()`
 *   （手机 3000；桌面按档位 6000 / 12000 / 20000）与每个预设自己的 `maxParticles`；
 * - 渲染距离 3：`core/QualityPreset.ts` 的 `resolveRenderDistance()` 里 `Math.max(3, …)`
 *   与 `config.ts` 的 `CULLING_CONFIG.minRenderDistance = 3` 都是这个下限；
 * - 像素比 1：`QUALITY_PRESETS.performance.maxPixelRatio = 1`。
 * 安全模式下取的值是**在这条产品线上额外定的一道更严的线**（比如粒子 500），
 * 属于策略选择，不是"量出来的最优值"—— 注释里写清楚，免得后人以为它是实测结果。
 */

/** 安全模式的进入理由（`detail` 由调用方给一句人类看得懂的中文说明） */
export type SafeModeReason =
  | 'webgl-unavailable'
  | 'world-load-failed'
  | 'save-corrupt'
  | 'too-many-errors'
  | 'manual';

export interface SafeModeState {
  active: boolean;
  reason: SafeModeReason | null;
  /** 为什么进的安全模式（中文，直接显示给玩家看） */
  detail: string;
  /** 进入时刻（`Date.now()`）；没在安全模式就是 `null` */
  since: number | null;
}

/** 理由 → 中文标签。面板/报告都读它，避免每个界面各写一份翻译 */
export const SAFE_MODE_REASON_LABELS: Record<SafeModeReason, string> = {
  'webgl-unavailable': 'WebGL 不可用（显卡驱动或上下文创建失败）',
  'world-load-failed': '世界加载失败',
  'save-corrupt': '本地存档损坏',
  'too-many-errors': '短时间内错误太多',
  manual: '玩家手动进入',
};

/**
 * 清单项的稳定键。Engine 按它做映射（`switch` 上有穷尽检查），
 * 也方便断言"清单里到底有没有那一项"而不用去比对中文文案。
 */
export type SafeModeRestrictionKey =
  | 'fluid-particle-limit'
  | 'fluid-surface-rebuild'
  | 'shadows'
  | 'ambient-occlusion'
  | 'pixel-ratio'
  | 'render-distance'
  | 'auto-simulation'
  | 'auto-degrade'
  | 'stress-overlay';

/** 清单里的一项：关掉什么、关成什么、为什么关、Engine 该走哪个入口 */
export interface SafeModeRestriction {
  key: SafeModeRestrictionKey;
  /** 中文名（面板直接显示） */
  label: string;
  /** 安全模式下的目标值 */
  value: string | number | boolean;
  /** 为什么安全模式要关它 —— 写给人（包括未来的自己）看的理由，面板也显示这句 */
  reason: string;
  /**
   * Engine 应该调的入口（**提示字符串，不是回调**）。
   * 加这个字段是为了让"清单"和"实际动作"能对上：接线时照着它逐个落实，
   * 而且它出现在面板上时，玩家也能看懂安全模式究竟改了什么。
   */
  entry: string;
}

/** 安全模式下的流体粒子上限（策略值，不是实测最优；正常值见文件头的出处说明） */
export const SAFE_MODE_FLUID_PARTICLE_LIMIT = 500;
/** 安全模式下的渲染距离（与 QualityPreset / CULLING_CONFIG 的最小值 3 一致） */
export const SAFE_MODE_RENDER_DISTANCE = 3;
/** 安全模式下的设备像素比上限 */
export const SAFE_MODE_PIXEL_RATIO = 1;

/**
 * 建议的触发阈值：同一会话里累计捕获到这么多条错误就进安全模式。
 * 属于策略选择（不是实测值）；调用方想改就改自己的判断，这里只是个默认建议。
 */
export const SAFE_MODE_ERROR_THRESHOLD = 5;

/**
 * 安全模式下应该关掉的全部东西。
 *
 * 刻意返回一个**冻结的常量数组**：它的每一项都是"为什么"的载体，
 * 不该被任何调用方就地改掉（改了之后面板上说的和实际做的不一样，最难查）。
 */
export const SAFE_MODE_RESTRICTIONS: readonly SafeModeRestriction[] = Object.freeze([
  {
    key: 'fluid-particle-limit',
    label: '流体粒子数上限',
    value: SAFE_MODE_FLUID_PARTICLE_LIMIT,
    reason:
      '流体求解是每帧 CPU 的大头（邻居搜索 + 压力迭代都与粒子数成正比）。'
      + '正常上限由 FluidPresets.particleLimitFor 给（手机 3000，桌面按档位 6000~20000），'
      + '安全模式压到 500：此时的第一目标是"还能画出一帧"，不是"水花好不好看"。',
    entry: '流体：把粒子池上限设为 500（超出上限的粒子直接不生成，不是只不渲染）',
  },
  {
    key: 'fluid-surface-rebuild',
    label: '流体表面重建',
    value: false,
    reason:
      '表面重建每帧都要新建几何体并上传显卡。上下文刚丢失/驱动不稳时，'
      + '这一步是最容易再触发一次崩溃的环节 —— 先关掉它，用粒子点渲染代替，画面差一点但不会再炸。',
    entry: '流体：渲染样式固定为 particles，不跑 FluidSurface 重建',
  },
  {
    key: 'shadows',
    label: '阴影',
    value: false,
    reason:
      '阴影要把整个场景再渲染一遍到深度贴图，并且额外占用一块显存和一组着色器。'
      + '安全模式下少一组着色器，就少一次"重建着色器时又失败一次"的机会。',
    entry: '画质：state.quality.shadows = false + RenderSystem 关掉 shadowMap 更新',
  },
  {
    key: 'ambient-occlusion',
    label: '环境光遮蔽（AO）',
    value: false,
    reason: 'AO 是额外的屏幕空间采样，纯画质收益、纯性能成本；安全模式下没有任何理由留着它。',
    entry: '画质：state.quality.ao = false',
  },
  {
    key: 'pixel-ratio',
    label: '设备像素比上限',
    value: SAFE_MODE_PIXEL_RATIO,
    reason:
      '像素比 2 意味着要填的像素是 1 的 4 倍（填充率对刚出过问题的 GPU 最敏感）。'
      + '压到 1 是"等效关掉超采样"，也是 QUALITY_PRESETS.performance 用的那个值。',
    entry: '画质：把渲染器的 pixelRatio 压到 1',
  },
  {
    key: 'render-distance',
    label: '渲染距离',
    value: SAFE_MODE_RENDER_DISTANCE,
    reason:
      '渲染距离决定同时要渲染和保留多少区块。降到最小值（3，与 QualityPreset.resolveRenderDistance 的'
      + '下限一致）能让显存与每帧的区块重建量都掉到最低，先确认"最小规模下是稳定的"。',
    entry: '画质：state.quality.renderDistance = 3（再调 applyQualityPreset 让剔除系统跟上）',
  },
  {
    key: 'auto-simulation',
    label: '自动模拟（水 / 沙）',
    value: false,
    reason:
      '自动模拟在玩家不动手时也在持续改变世界并消耗 CPU。安全模式下要让它**停下来**：'
      + '世界静止之后才能判断"是不是模拟本身把这次搞崩的"，玩家放东西也才看得清结果。',
    entry: '物理：state.physics.waterEnabled = false、sandEnabled = false',
  },
  {
    key: 'auto-degrade',
    label: '自动画质降级',
    value: false,
    reason:
      'AutoDegrade 内部的 AdaptiveQuality 是画质的唯一决策源，而安全模式也要定画质 —— '
      + '两个"自动调画质"的机制同时活着会互相打架（画质反复横跳，且日志里看不出是谁改的）。'
      + '安全模式下改画质这件事只由安全模式负责。',
    entry: '性能：关掉 autoDegrade（并把可用性策略交给安全模式固定）',
  },
  {
    key: 'stress-overlay',
    label: '应力可视化与调试线框',
    value: false,
    reason:
      '应力着色（StressVisualizer）每 250ms 就要重算全场并重建调试几何体，'
      + '物理调试线框同样每帧上传顶点。这些都是"看数据"用的，出问题时不该再为它们付帧时间。',
    entry: '调试：stress / physicsDebugLines 关闭并清空已有几何体',
  },
]);

/**
 * 安全模式状态机。
 *
 * 进入之后**不会自己退出**：导致它进来的原因（上下文失败、存档坏了）不会因为过了几秒就消失，
 * 自动退出只会让人看到"闪一下又崩了"。退出只能由调用方显式 `exit()`（面板上的按钮或玩家操作）。
 */
export class SafeMode {
  private current: SafeModeState = { active: false, reason: null, detail: '', since: null };

  /**
   * 进入安全模式。
   *
   * 已经处于安全模式时**保留最早的 `since`**（只更新理由与说明）：
   * `since` 表达的是"从什么时候开始不对劲的"，若因为第二次理由覆盖而重置，
   * 面板上的"已开启多久"会突然回到 0 秒，看起来像刚刚才崩 —— 那会误导排查方向。
   */
  enter(reason: SafeModeReason, detail: string): void {
    const text = detail.trim().length > 0 ? detail.trim() : SAFE_MODE_REASON_LABELS[reason];
    this.current = {
      active: true,
      reason,
      detail: text,
      since: this.current.active && this.current.since !== null ? this.current.since : Date.now(),
    };
  }

  /** 退出安全模式；没在安全模式时是空操作（重复调用安全） */
  exit(): void {
    this.current = { active: false, reason: null, detail: '', since: null };
  }

  /** 当前状态（返回副本，外部改不到内部状态） */
  get state(): SafeModeState {
    return {
      active: this.current.active,
      reason: this.current.reason,
      detail: this.current.detail,
      since: this.current.since,
    };
  }

  /**
   * 安全模式下应该关掉什么。
   *
   * **没在安全模式时返回空清单**，而不是把清单照样返回：
   * 调用方（Engine）是照着这份清单去关东西的，激活状态下返回空清单，
   * "不在安全模式却把画质关到最低"这种事故就永远不会发生 —— 让错误的状态无法被表达，
   * 比在注释里写"调用前请先判断 active"可靠得多。
   */
  get restrictions(): readonly SafeModeRestriction[] {
    return this.current.active ? SAFE_MODE_RESTRICTIONS : [];
  }

  /** 面板用的一行中文说明（不含换行：它要能塞进侧栏的一行里） */
  describe(): string {
    if (!this.current.active) return '安全模式未开启：画质与模拟都按正常档位运行。';
    const reason = this.current.reason ? SAFE_MODE_REASON_LABELS[this.current.reason] : '未标注原因';
    const since = this.current.since;
    const elapsed = since === null ? '不可用（没有记录进入时刻）' : formatElapsed(Date.now() - since);
    return (
      `安全模式已开启（原因：${reason}，已开启 ${elapsed}）：`
      + `${this.current.detail}。已按清单关闭 ${SAFE_MODE_RESTRICTIONS.length} 项高开销功能，`
      + `先保证能玩，再逐项排查。`
    );
  }
}

/** 中文时长文案（秒 / 分 / 时）。负数按 0 处理：时钟被改过时不该出现"-3 秒前" */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}
