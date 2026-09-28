/**
 * 逻辑连线（问题 A.6）：**积木式因果**。
 *
 * 这个东西把沙盘从"物理玩具"变成"会自动发生事情的装置"，模型非常小：
 *
 *   触发器 / 建筑 ──发出──▶ 事件（LogicEvent）
 *                              │
 *                              ├─ 这条连线听不听这个事件？（listen / sourceId）
 *                              ├─ 现在能不能触发？（enabled / 冷却 / 概率）
 *                              ▼
 *                          动作（LogicAction）
 *                              │
 *                              ▼
 *                        引擎去执行它
 *
 * 关键设计：**LogicLink 本身零依赖、零副作用**。
 * 它不 import Rapier、不 import Three.js、不碰 DOM、不读全局状态 ——
 * 唯一的不确定源是 `Math.random()`（概率）。所有"真的动手"的事情都被包装成
 * `LogicActionRequest` 交回给 Engine 执行。这样带来三个好处：
 * 1. 这个文件可以在 Node 里直接单测（本轮的交付自检就是这么做的）；
 * 2. 引擎的渲染/物理/音频/手机震动各自有各自的生命周期，逻辑层不需要知道；
 * 3. 想回放一次"事故"（存档 / 回放）时，只要重放事件就够了。
 *
 * 数据层的存盘格式是 `LogicLinkConfig`（`src/data/physicsComponents.ts`），
 * 运行时格式是 `LogicLinkRecord`（数字 id、动作带冷却和概率）。
 * 两者之间的桥就是文件末尾的 `linkSpecFromConfig()`。
 *
 * 关于冷却和概率的口径（写清楚，免得两边理解不一致）：
 * - 冷却按**动作**粒度：`cooldownMs` 是 `LogicAction` 的字段，同一个动作在冷却期内
 *   被跳过，不影响同一条连线上的别的动作；
 * - 概率没命中时**不**增加 `firedCount`，并且这条动作不出现在返回值里 ——
 *   也就是说 `fire()` 返回空数组 = "这次什么都没发生"；
 * - `firedCount` 是"这条连线真正触发了的**事件次数**"，一次事件里执行 3 个动作也只 +1。
 */

import type { LogicEvent, LogicEventType, LogicLinkConfig } from '../data/physicsComponents';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type LogicActionType =
  | 'apply-impulse' // 给目标刚体加冲量
  | 'set-mode' // 改刚体模式（dynamic/kinematic/fixed）
  | 'set-motor' // 改铰链电机速度
  | 'remove' // 删除目标（例如门被炸掉）
  | 'spawn' // 生成一个建筑（按 defId）
  | 'toggle-trigger' // 开关另一个触发器
  | 'vibrate' // 手机震动（毫秒）
  | 'toast' // 弹提示
  | 'sound-hint'; // 播放一句提示（本项目没有音频资源，只发事件给 UI）

export interface LogicAction {
  type: LogicActionType;
  /** 目标刚体句柄 / 建筑 id / 触发器 id，视 type 而定 */
  targetId?: number;
  /** spawn 用 */
  defId?: string;
  /** apply-impulse 用 */
  impulse?: Vec3;
  /** set-motor 用 */
  motorSpeed?: number;
  motorForce?: number;
  /** set-mode 用 */
  mode?: 'dynamic' | 'kinematic' | 'static';
  /** 冷却（毫秒），默认 0 = 不冷却 */
  cooldownMs?: number;
  /** 触发概率 0..1，默认 1（制造偶然性） */
  probability?: number;
  /** toast 用 */
  text?: string;
}

/**
 * 逻辑门（M3 第 4 批）。
 *
 * 每一种的语义都写得**可判定**（而不是"大致是那个意思"），因为逻辑门的语义含糊
 * 必然导致"有时候开有时候不开"这类没法排查的问题：
 *
 * | 门 | 语义 | 关键参数 |
 * |---|---|---|
 * | `none` | 事件到 → 立刻执行（默认） | — |
 * | `or` | 与 none 相同；显式写出来是为了让面板上显示"这是或门" | — |
 * | `and` | `windowMs` 内凑齐 `required` 个输入才执行一次 | `required`（默认 2）、`windowMs`（默认 400） |
 * | `not` | 事件到达时，若 `inhibitSourceId` 在 `windowMs` 内**没有**活动，才执行 | `inhibitSourceId`、`windowMs` |
 * | `delay` | 事件到达后等 `delayMs` 再执行（**排队**，不是丢弃） | `delayMs`（默认 500） |
 * | `timer` | 事件持续活动（`windowMs` 内有输入）时，每 `intervalMs` 执行一次 | `intervalMs`（默认 1000）、`windowMs` |
 */
export type LogicGateKind = 'none' | 'or' | 'and' | 'not' | 'delay' | 'timer';

export const LOGIC_GATE_LABELS: Record<LogicGateKind, string> = {
  none: '直接触发',
  or: '或（任一输入）',
  and: '与（需多个输入）',
  not: '非（被抑制时不触发）',
  delay: '延时',
  timer: '计时（持续活动时周期触发）',
};

export interface LogicGate {
  kind: LogicGateKind;
  /** and 需要几个输入（默认 2） */
  required?: number;
  /** and/not/timer 的时间窗口（毫秒），默认 400 */
  windowMs?: number;
  /** delay 的延迟（毫秒），默认 500 */
  delayMs?: number;
  /** timer 的周期（毫秒），默认 1000 */
  intervalMs?: number;
  /**
   * not 门的抑制源：在窗口内 `sourceId` 命中过它，就不执行。
   * 不填时 `not` 会退化成 `none` 并在 `validate()` 里报出来 —— 一个永远为真的"非门"
   * 是逻辑错误，不该静默生效。
   */
  inhibitSourceId?: number | null;
}

export interface LogicLinkRecord {
  id: number;
  label: string;
  /** 逻辑门（不填 = 直接触发） */
  gate?: LogicGate;
  /** 监听哪些事件类型 */
  listen: LogicEventType[];
  /** 只监听某个触发器/某座建筑；null = 全部 */
  sourceId: number | null;
  actions: LogicAction[];
  enabled: boolean;
  firedCount: number;
  /** 上一次触发时间（冷却用） */
  lastFiredMs: number;
}

/** 每帧调用，返回本帧要执行的动作（由 Engine 执行——LogicLink 本身不认识 Three.js / DOM） */
export interface LogicActionRequest {
  action: LogicAction;
  linkId: number;
  event: LogicEvent;
}

/** `add()` 接受的规格（运行时字段由 LogicLink 自己填） */
export type LogicLinkSpec = Omit<LogicLinkRecord, 'id' | 'firedCount' | 'lastFiredMs'>;

/**
 * 事件类型 → 默认动作类型。
 * 存盘格式（LogicLinkConfig.events）里只写了事件，没写动作，所以要有这么一张表
 * 把"玩家勾了'开门'"翻译成"那就去转门轴电机"。
 * `none` 不出现在表里 —— 它代表"什么都不做"，转换时直接跳过。
 */
const EVENT_TO_ACTION: Partial<Record<LogicEventType, LogicActionType>> = {
  'open-door': 'set-motor',
  'close-door': 'set-motor',
  'toggle-motor': 'set-motor',
  'toggle-light': 'toast',
  'play-animation': 'sound-hint',
  'play-sound': 'sound-hint',
  'set-color': 'toast',
  'spawn-object': 'spawn',
  'destroy-object': 'remove',
  teleport: 'apply-impulse',
  none: undefined,
};

/**
 * 把存盘格式（`LogicLinkConfig`）转成运行时规格。
 *
 * @param config data 层的连线配置
 * @param listen 这条连线要监听哪些事件类型；`config.on` 的 enter/exit/activate/always
 *               语义由触发器决定（"进入时 / 离开时 / 激活时 / 一直"），
 *               调用方按当前相位筛过事件之后把对应的事件类型传进来即可。
 *               默认就是 `config.events` 里出现过的类型。
 */
export function linkSpecFromConfig(
  config: LogicLinkConfig,
  listen?: LogicEventType[],
): LogicLinkSpec {
  const actions: LogicAction[] = [];
  for (const event of config.events) {
    if (event.type === 'none') continue;
    const type = EVENT_TO_ACTION[event.type];
    if (!type) continue;
    const action: LogicAction = { type };
    // LogicEvent.target 是字符串 id，这里尽力转成数字（转不了就不带 targetId）。
    // 用 Number() 而不是 parseInt()：rapier3d-compat 0.21 的 wasm 会把 u32 handle
    // 的位模式当成 f64 交回来，handle 可能长成 "5e-324" 这种科学计数法，
    // parseInt 会把它读成 5（错），Number 才是对的。
    if (event.target !== undefined && event.target.trim() !== '') {
      const target = Number(event.target);
      if (Number.isFinite(target)) action.targetId = target;
    }
    // 附加参数原样带过去，由引擎解释（颜色、传送点、生成模型 id…）
    if (type === 'spawn' && typeof event.data?.defId === 'string') {
      action.defId = event.data.defId;
    }
    if (type === 'toast' && typeof event.data?.text === 'string') {
      action.text = event.data.text;
    }
    actions.push(action);
  }

  const source = Number(config.sourceId);
  return {
    label: config.label ?? config.id,
    listen: listen ?? [...new Set(config.events.map((event) => event.type))],
    sourceId: config.sourceId.trim() !== '' && Number.isFinite(source) ? source : null,
    actions,
    enabled: true,
  };
}

export class LogicLink {
  private readonly records: LogicLinkRecord[] = [];
  private nextId = 1;
  /**
   * 动作级冷却表：key = `${linkId}:${actionIndex}` → 上次执行时刻。
   * 放在这里而不是动作对象上，是为了让 `list()` 返回的数据保持"配置"语义，
   * 不含运行时噪音。
   */
  private readonly actionFiredMs = new Map<string, number>();
  /** 每条连线的输入时间戳（最近 N 个），and/or/not/timer 都要看它 */
  private readonly inputTimes = new Map<number, number[]>();
  /** delay 门的待执行队列 */
  private readonly delayed = new Map<number, { at: number; requests: LogicActionRequest[] }[]>();
  /** timer 门上次触发时刻 */
  private readonly timerLast = new Map<number, number>();
  /** not 门的抑制源最近活动时刻 */
  private readonly inhibitLast = new Map<number, number>();

  get count(): number {
    return this.records.length;
  }

  // ---------------------------------------------------------------- 增删

  /** 加一条连线 */
  add(spec: LogicLinkSpec): number {
    const record: LogicLinkRecord = {
      id: this.nextId++,
      label: spec.label,
      listen: [...spec.listen],
      sourceId: spec.sourceId ?? null,
      actions: spec.actions.map((action) => ({ ...action })),
      enabled: spec.enabled ?? true,
      // ⚠ 逻辑门必须显式拷进来。`add()` 是**逐字段构造**记录的（不是展开 spec），
      // 所以新增字段时忘了在这里加一行，表现就是"门配置被静默丢弃、全部退化成直接触发" ——
      // 我在第一版就踩了这个坑（9 条断言同时红），写在这里备查。
      gate: spec.gate ? { ...spec.gate } : undefined,
      firedCount: 0,
      lastFiredMs: 0,
    };
    this.records.push(record);
    return record.id;
  }

  remove(id: number): boolean {
    const index = this.records.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    for (const key of [...this.actionFiredMs.keys()]) {
      if (key.startsWith(`${id}:`)) this.actionFiredMs.delete(key);
    }
    return true;
  }

  setEnabled(id: number, enabled: boolean): void {
    const record = this.records.find((item) => item.id === id);
    if (record) record.enabled = enabled;
  }

  /** 一次性注册一组预设连线（供「20 个组合」用） */
  addAll(specs: LogicLinkSpec[]): number[] {
    return specs.map((spec) => this.add(spec));
  }

  find(id: number): LogicLinkRecord | null {
    return this.records.find((item) => item.id === id) ?? null;
  }

  list(): LogicLinkRecord[] {
    return [...this.records];
  }

  /** 连线数量统计，按 listen 事件类型分组 */
  stats(): { total: number; enabled: number; fired: number } {
    let enabled = 0;
    let fired = 0;
    for (const record of this.records) {
      if (record.enabled) enabled++;
      fired += record.firedCount;
    }
    return { total: this.records.length, enabled, fired };
  }

  /** 按监听的事件类型分组统计（"哪些事件有人在听"） */
  countByEventType(): Partial<Record<LogicEventType, number>> {
    const out: Partial<Record<LogicEventType, number>> = {};
    for (const record of this.records) {
      for (const type of record.listen) out[type] = (out[type] ?? 0) + 1;
    }
    return out;
  }

  clear(): void {
    this.records.length = 0;
    this.actionFiredMs.clear();
    // 门的运行时状态也必须清：抑制源时刻、计时器、待执行的延时队列
    // 都是**按连线 id** 存的，连线的 id 从 1 重新开始 —— 不清就会串到新世界的连线上
    this.inputTimes.clear();
    this.delayed.clear();
    this.timerLast.clear();
    this.inhibitLast.clear();
    this.nextId = 1;
  }

  // ---------------------------------------------------------------- 触发

  /**
   * 收到一个事件，返回应该执行的动作队列。
   * 冷却、概率、过滤都在这里处理完 —— 引擎拿到什么就执行什么，不用再做判断。
   */
  fire(event: LogicEvent, nowMs: number): LogicActionRequest[] {
    const requests: LogicActionRequest[] = [];
    for (const record of this.records) {
      if (!record.enabled) continue;
      if (!record.listen.includes(event.type)) continue;
      if (record.sourceId !== null && !this.matchesSource(record.sourceId, event)) continue;

      // ---- 逻辑门：决定"这次输入到底要不要执行"
      const gate = record.gate;
      const gateKind = gate?.kind ?? 'none';
      const windowMs = Math.max(0, gate?.windowMs ?? 400);

      if (gateKind !== 'none') {
        // 记下输入时间（所有门都要用），并丢掉窗口外的旧时间戳 —— 不丢的话数组会无限增长
        const times = this.inputTimes.get(record.id) ?? [];
        times.push(nowMs);
        const cutoff = nowMs - Math.max(windowMs, gate?.intervalMs ?? 0, gate?.delayMs ?? 0) * 2;
        while (times.length > 0 && times[0]! < cutoff) times.shift();
        this.inputTimes.set(record.id, times);
      }

      if (gateKind === 'and') {
        const required = Math.max(2, gate?.required ?? 2);
        const times = this.inputTimes.get(record.id) ?? [];
        const inWindow = times.filter((time) => nowMs - time <= windowMs);
        if (inWindow.length < required) continue;
        // 凑齐之后清空：否则下一条输入又会立刻凑齐，变成"按一次触发一片"
        this.inputTimes.set(record.id, []);
      } else if (gateKind === 'not') {
        const inhibit = gate?.inhibitSourceId ?? null;
        if (inhibit === null) {
          // 没有抑制源的"非门"是逻辑错误：退化成直接触发，但 validate() 会报出来
        } else {
          const last = this.inhibitLast.get(inhibit);
          if (last !== undefined && nowMs - last <= windowMs) continue;
        }
      } else if (gateKind === 'delay' || gateKind === 'timer') {
        // 这两种门在下面单独处理
      }

      const pending: LogicActionRequest[] = [];
      record.actions.forEach((action, index) => {
        // 概率：没命中就当这条动作不存在（firedCount 也不加）
        const probability = action.probability ?? 1;
        if (probability <= 0) return;
        if (probability < 1 && Math.random() >= probability) return;

        // 冷却：按动作粒度
        const cooldown = action.cooldownMs ?? 0;
        if (cooldown > 0) {
          const key = `${record.id}:${index}`;
          const last = this.actionFiredMs.get(key);
          if (last !== undefined && nowMs - last < cooldown) return;
          this.actionFiredMs.set(key, nowMs);
        }

        pending.push({ action, linkId: record.id, event });
      });

      // 整条连线"没触发"时不加 firedCount，也不更新 lastFiredMs
      if (pending.length === 0) continue;

      if (gateKind === 'delay') {
        // 延时门：**排队**而不是丢弃。丢弃会让"按下按钮 0.5 秒后开门"变成
        // "快速按两下只开一次门"，那是明显的 bug 而不是特性
        const delayMs = Math.max(0, gate?.delayMs ?? 500);
        const queue = this.delayed.get(record.id) ?? [];
        queue.push({ at: nowMs + delayMs, requests: pending });
        this.delayed.set(record.id, queue);
        record.lastFiredMs = nowMs;
        continue;
      }

      if (gateKind === 'timer') {
        // 计时门：第一次输入立刻执行一次，之后每 intervalMs 一次（只要还在活动窗口内）。
        // 这正好对应"踩住压力板不放 → 机关每秒转一圈"的玩法
        const intervalMs = Math.max(50, gate?.intervalMs ?? 1000);
        const last = this.timerLast.get(record.id);
        if (last !== undefined && nowMs - last < intervalMs) continue;
        this.timerLast.set(record.id, nowMs);
      }

      record.firedCount++;
      record.lastFiredMs = nowMs;
      requests.push(...pending);
    }
    return requests;
  }

  /**
   * 每帧调用：把到期的延时动作放出来，并让计时门在"持续活动"时周期触发。
   *
   * 这两种门都需要一个"没有新事件也要发生点什么"的时机 —— 事件驱动的 `fire()` 做不到，
   * 所以必需单独一个 tick。**这也是本文件唯一有时间推进语义的方法**。
   */
  tick(nowMs: number): LogicActionRequest[] {
    const requests: LogicActionRequest[] = [];

    // ---- 延时门
    for (const [linkId, queue] of [...this.delayed.entries()]) {
      const ready = queue.filter((item) => item.at <= nowMs);
      if (ready.length === 0) continue;
      const remain = queue.filter((item) => item.at > nowMs);
      if (remain.length > 0) this.delayed.set(linkId, remain);
      else this.delayed.delete(linkId);

      const record = this.records.find((item) => item.id === linkId);
      if (!record || !record.enabled) continue;
      for (const item of ready) {
        record.firedCount += 1;
        record.lastFiredMs = nowMs;
        requests.push(...item.requests);
      }
    }

    // ---- 计时门
    for (const record of this.records) {
      if (!record.enabled) continue;
      const gate = record.gate;
      if (!gate || gate.kind !== 'timer') continue;
      const windowMs = Math.max(0, gate.windowMs ?? 400);
      const intervalMs = Math.max(50, gate.intervalMs ?? 1000);
      const times = this.inputTimes.get(record.id) ?? [];
      const active = times.some((time) => nowMs - time <= windowMs);
      if (!active) {
        // 不活动就复位，下次活动重新"立刻执行一次"
        this.timerLast.delete(record.id);
        continue;
      }
      const last = this.timerLast.get(record.id);
      if (last !== undefined && nowMs - last < intervalMs) continue;
      this.timerLast.set(record.id, nowMs);

      const pending: LogicActionRequest[] = [];
      record.actions.forEach((action, index) => {
        const probability = action.probability ?? 1;
        if (probability <= 0) return;
        if (probability < 1 && Math.random() >= probability) return;
        const cooldown = action.cooldownMs ?? 0;
        if (cooldown > 0) {
          const key = `${record.id}:${index}`;
          const previous = this.actionFiredMs.get(key);
          if (previous !== undefined && nowMs - previous < cooldown) return;
          this.actionFiredMs.set(key, nowMs);
        }
        // 计时门的 tick 事件：复用这条连线监听的第一个事件类型，
        // 并带上 `tick: true` 标记 —— 这样事件类型仍然是合法的 LogicEventType，
        // 而动作执行器能分辨"这是持续活动的周期触发"而不是"又发生了一次新事件"
        pending.push({
          action,
          linkId: record.id,
          event: {
            type: record.listen[0] ?? 'none',
            data: { tick: true, at: nowMs, reason: 'timer-gate' },
          },
        });
      });
      if (pending.length === 0) continue;
      record.firedCount += 1;
      record.lastFiredMs = nowMs;
      requests.push(...pending);
    }

    return requests;
  }

  /** 记一次"抑制源活动"（not 门用）。由 Engine 在事件分派时调用。 */
  noteInhibitActivity(sourceId: number, nowMs: number): void {
    this.inhibitLast.set(sourceId, nowMs);
  }

  // ---------------------------------------------------------------- 校验

  /**
   * 校验：目标不存在的动作要能报出来（UI 提示用）。
   *
   * @param exists 由调用方提供"这个 id 还在不在"的判断。刚体句柄、建筑 id、
   *               触发器 id 分属不同命名空间，逻辑层不该自己去猜，所以走回调。
   */
  validate(exists: (id: number) => boolean): { linkId: number; reason: string }[] {
    const issues: { linkId: number; reason: string }[] = [];
    for (const record of this.records) {
      if (record.sourceId !== null && !exists(record.sourceId)) {
        issues.push({
          linkId: record.id,
          reason: `连线 ${record.id}「${record.label}」的监听源 ${record.sourceId} 号已不存在`,
        });
      }
      // ---- 门的配置错误也要报出来（一个永远为真的"非门"是逻辑错误，不该静默生效）
      const gate = record.gate;
      if (gate) {
        if (gate.kind === 'not' && (gate.inhibitSourceId ?? null) === null) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」设为非门，但没指定抑制源 —— 它会退化成"直接触发"`,
          });
        }
        if (gate.kind === 'not' && gate.inhibitSourceId !== null && gate.inhibitSourceId !== undefined
          && !exists(gate.inhibitSourceId)) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」的非门抑制源 ${gate.inhibitSourceId} 号已不存在`,
          });
        }
        if (gate.kind === 'delay' && (gate.delayMs ?? 500) <= 0) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」延时门的延时为 0，等同于直接触发`,
          });
        }
        if (gate.kind === 'timer' && (gate.intervalMs ?? 1000) < 50) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」计时门的周期小于 50ms，会每帧触发`,
          });
        }
        if (gate.kind === 'and' && (gate.required ?? 2) < 2) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」与门只要求 1 个输入，等同于直接触发`,
          });
        }
      }
      for (const action of record.actions) {
        if (action.targetId === undefined) continue;
        if (this.targetMustExist(action.type) && !exists(action.targetId)) {
          issues.push({
            linkId: record.id,
            reason: `连线 ${record.id}「${record.label}」的目标 ${action.targetId} 号刚体已不存在`,
          });
        }
      }
    }
    return issues;
  }

  /** 这些动作必须有一个还在的目标；toast / vibrate / sound-hint 不需要 */
  private targetMustExist(type: LogicActionType): boolean {
    switch (type) {
      case 'toast':
      case 'vibrate':
      case 'sound-hint':
        return false;
      default:
        return true;
    }
  }

  /**
   * 事件和 `sourceId` 的比对。
   *
   * `LogicEvent` 里只有字符串 `target`，没有数字 sourceId，而 `LogicLinkRecord.sourceId`
   * 是数字（刚体句柄 / 建筑 id / 触发器 id 都用数字）。所以这里把事件里所有"可能是它"
   * 的数字都拿出来比一遍：`target`、`data.sourceId`、`data.ownerId`、
   * `data.triggerId`、`data.handle`。命中任意一个就算这条连线的源。
   */
  private matchesSource(sourceId: number, event: LogicEvent): boolean {
    const candidates: unknown[] = [event.target];
    const data = event.data;
    if (data) {
      // `triggerOwnerId` 是"触发区绑定的宿主"（按钮/压力板自己）。
      // 它必须在这里 —— 否则"给按钮建一条连线"永远匹配不上：
      // 按钮不动，动的是踩它的人，所以 event.target 与 data.ownerId 都不是按钮。
      candidates.push(
        data.sourceId,
        data.ownerId,
        data.triggerId,
        data.handle,
        data.bodyHandle,
        data.triggerOwnerId,
      );
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && candidate === sourceId) return true;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        // 同 linkSpecFromConfig：用 Number() 而不是 parseInt()，才能对上
        // wasm 侧科学计数法写法的 handle
        const parsed = Number(candidate);
        if (Number.isFinite(parsed) && parsed === sourceId) return true;
      }
    }
    return false;
  }
}
