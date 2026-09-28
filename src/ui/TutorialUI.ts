/**
 * 教学关卡界面层（TutorialUI）。
 *
 * 这一层只做"把 Engine 算好的教学状态画出来"：关卡名、第几步、步骤说明、隐藏提示、
 * 进度条、用时、步骤清单，以及六个按钮的回调转发。它**不做任何判定** ——
 * "这一步算不算做完"由 Engine 决定，判定结果通过 `stepDone` 传进来；
 * 连"玩家卡住了没有"也由 Engine 判断（它才知道玩家多久没动作），
 * 面板只负责在收到 hint 时显示出来。
 *
 * 两个取舍：
 * 1. **不逐帧重排 DOM**：`update()` 每帧都会被调，但只有「关卡 / 步骤 / 是否完成 / 整数秒」
 *    这些字段变了才真正写 DOM，签名没变直接返回（低配手机上重排步骤清单很贵）；
 * 2. **通关层复用 `#tut-step-hint`**（本文件采用的是契约里给的第二方案）：
 *    通关时把 `#tut-step-hint` 写成「🎉 通关！…」，而不是另插一层节点。
 *    理由：不改 index.html / CSS 就能生效，也不需要动画或额外定位，
 *    而通关时这一步的 hint 本来也没有意义了。
 */

import type { TutorialLevel, TutorialStep } from '../tutorial/TutorialLevel';
import { JOINT_TYPE_LABELS } from '../data/jointTypes';
import { getBuildingDef } from '../data/buildingCatalog';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 步骤目标的中文短名 —— TutorialStep 没有 title 字段，用 goal 拼一个能进清单的短标题 */
const GOAL_LABELS: Record<TutorialStep['goal'], string> = {
  place: '放东西',
  joint: '连关节',
  trigger: '放触发器',
  interact: '看物理跑起来',
  manual: '自己确认做到',
};

/** 把秒数格式化成 mm:ss（超过 99 分钟就自然进位，不做特殊处理） */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface TutorialUIHandlers {
  /** 玩家点了「下一步」（Engine 负责推进关卡状态机并做校验） */
  onNext(): void;
  /** 玩家点了「上一步」 */
  onPrev(): void;
  /** 玩家点了「跳过这一关」 */
  onSkipLevel(): void;
  /** 玩家点了「退出教学」 */
  onExit(): void;
  /** 玩家点了「重新开始这一关」 */
  onRestart(): void;
  /** 玩家点了「做完了」按钮（有些步骤需要玩家自己确认做到了，而不是引擎检测） */
  onConfirmStep(): void;
}

/** 一次渲染所需的全部状态由 Engine 提供 */
export interface TutorialStats {
  level: TutorialLevel;
  stepIndex: number;
  /** 这一步是否已被引擎检测通过 */
  stepDone: boolean;
  /** 引擎给的额外提示（例如「还差一个门框没放」）；没有则不显示 */
  hint?: string;
  /** 关卡总进度 0..1（按步骤数算） */
  progress: number;
  /** 关卡内累计用时（秒） */
  elapsedSeconds: number;
  /** 剩余可跳过次数（0 表示不允许跳过，跳过按钮变灰） */
  skipsLeft: number;
  /** 关卡是否已完成（显示通关界面） */
  levelComplete: boolean;
  /** 已完成关卡数 / 总关卡数 */
  completedLevels: number;
  totalLevels: number;
}

/**
 * 教学面板。
 *
 * 初始为隐藏状态：玩家没进教学模式时不该看到这个面板，
 * 所以构造完就 `hide()`，Engine 进教学时再 `show()`。
 * 隐藏方式除了项目惯用的 `.visible` class，还兜底写一次内联 `display` ——
 * 因为 #tutorial-panel 的隐藏规则要等 index.html / style.css 补上，
 * 在那之前".visible 没生效"会让关不掉的面板一直挡在屏幕角落。
 */
export class TutorialUI {
  private readonly root: HTMLElement;
  private readonly levelName: HTMLElement;
  private readonly levelProgress: HTMLElement;
  private readonly stepIndexLabel: HTMLElement;
  private readonly stepTitle: HTMLElement;
  private readonly stepText: HTMLElement;
  private readonly stepHint: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly stepList: HTMLElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;

  /** 上一次 update() 的状态签名（变了才写 DOM） */
  private lastSignature = '';
  /** 上一次重建步骤清单时的关键字段（清单只在换关/换步/判定变化时重建） */
  private lastListKey = '';
  private disposed = false;

  constructor(private readonly handlers: TutorialUIHandlers) {
    this.root = must<HTMLElement>('#tutorial-panel');
    this.levelName = must<HTMLElement>('#tut-level-name', this.root);
    this.levelProgress = must<HTMLElement>('#tut-level-progress', this.root);
    this.stepIndexLabel = must<HTMLElement>('#tut-step-index', this.root);
    this.stepTitle = must<HTMLElement>('#tut-step-title', this.root);
    this.stepText = must<HTMLElement>('#tut-step-text', this.root);
    this.stepHint = must<HTMLElement>('#tut-step-hint', this.root);
    this.progressFill = must<HTMLElement>('#tut-progress-fill', this.root);
    this.elapsed = must<HTMLElement>('#tut-elapsed', this.root);
    this.stepList = must<HTMLElement>('#tut-step-list', this.root);
    this.prevButton = must<HTMLButtonElement>('#tut-prev', this.root);
    this.nextButton = must<HTMLButtonElement>('#tut-next', this.root);
    this.confirmButton = must<HTMLButtonElement>('#tut-confirm', this.root);
    this.restartButton = must<HTMLButtonElement>('#tut-restart', this.root);
    this.skipButton = must<HTMLButtonElement>('#tut-skip', this.root);
    this.exitButton = must<HTMLButtonElement>('#tut-exit', this.root);

    // 六个按钮都必须 type="button"：这里再写一次，免得 index.html 漏写时在 <form> 里变成提交键
    for (const button of [
      this.prevButton,
      this.nextButton,
      this.confirmButton,
      this.restartButton,
      this.skipButton,
      this.exitButton,
    ]) {
      button.type = 'button';
    }

    this.prevButton.addEventListener('click', this.handlePrevClick);
    this.nextButton.addEventListener('click', this.handleNextClick);
    this.confirmButton.addEventListener('click', this.handleConfirmClick);
    this.restartButton.addEventListener('click', this.handleRestartClick);
    this.skipButton.addEventListener('click', this.handleSkipClick);
    this.exitButton.addEventListener('click', this.handleExitClick);

    // 教学还没开始，面板先藏起来
    this.hide();
  }

  private readonly handlePrevClick = (): void => {
    this.handlers.onPrev();
  };

  private readonly handleNextClick = (): void => {
    this.handlers.onNext();
  };

  private readonly handleConfirmClick = (): void => {
    this.handlers.onConfirmStep();
  };

  private readonly handleRestartClick = (): void => {
    this.handlers.onRestart();
  };

  private readonly handleSkipClick = (): void => {
    this.handlers.onSkipLevel();
  };

  private readonly handleExitClick = (): void => {
    this.handlers.onExit();
  };

  update(stats: TutorialStats): void {
    if (this.disposed) return;

    // 整数秒也算进签名：用时每秒跳一次，其余字段都是低频的
    const seconds = Math.max(0, Math.floor(stats.elapsedSeconds));
    const signature =
      `${stats.level.id}|${stats.stepIndex}|${stats.stepDone}|${stats.hint ?? ''}|` +
      `${Math.round(clamp01(stats.progress) * 100)}|${seconds}|${stats.skipsLeft}|` +
      `${stats.levelComplete}|${stats.completedLevels}/${stats.totalLevels}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const step = stats.level.steps[stats.stepIndex];
    const totalSteps = stats.level.steps.length;

    this.renderHeader(stats);
    this.renderStep(stats, step, totalSteps);
    this.renderStepList(stats);
    this.renderButtons(stats, step);

    this.progressFill.style.width = `${Math.round(clamp01(stats.progress) * 100)}%`;
    this.elapsed.textContent = `⏱ ${formatElapsed(seconds)}`;
  }

  /** 关卡名 + 「第 N 关 / 共 M 关」（关号由"已完成关卡数"推导，见注释） */
  private renderHeader(stats: TutorialStats): void {
    this.levelName.textContent = this.levelHeading(stats.level);
    if (stats.level.teaching) this.levelName.title = stats.level.teaching;

    // TutorialStats 里没有单独的"第几关"字段：未通关时关号 = 已完成关卡数 + 1，
    // 刚通关的那一刻已完成数已经把它自己算进去了，所以直接用已完成数。
    const levelNo = stats.levelComplete
      ? Math.max(1, stats.completedLevels)
      : Math.min(stats.totalLevels, stats.completedLevels + 1);
    this.levelProgress.textContent = `第 ${levelNo} 关 / 共 ${stats.totalLevels} 关`;
  }

  private levelHeading(level: TutorialLevel): string {
    return `${level.icon} ${level.name}`.trim();
  }

  private renderStep(stats: TutorialStats, step: TutorialStep | undefined, totalSteps: number): void {
    if (!step) {
      this.stepIndexLabel.textContent = '步骤 —';
      this.stepTitle.textContent = '没有更多步骤';
      this.stepText.textContent = '';
      this.stepHint.textContent = '';
      return;
    }

    this.stepIndexLabel.textContent = `步骤 ${stats.stepIndex + 1} / ${totalSteps}`;
    this.stepTitle.textContent = this.stepTitleOf(step, stats.stepIndex);
    this.stepText.textContent = step.text;
    this.renderHint(stats, step);
  }

  /**
   * 提示行。三种来源按优先级：
   * 1. 通关了 → 通关文案（契约里选的第二方案：复用 #tut-step-hint 当通关层）；
   * 2. 引擎实时判断（stats.hint）—— 它才知道玩家是不是卡住了；
   * 3. 关卡数据里的 hint —— 引擎没给提示时回落到它，免得关卡作者写的提示白写；
   *    引擎想彻底关掉提示，传 `hint: ''` 就行（空串在本函数里等价于"不显示"）。
   */
  private renderHint(stats: TutorialStats, step: TutorialStep): void {
    if (stats.levelComplete) {
      this.stepHint.textContent =
        `🎉 通关！${stats.level.name} · 用时 ${formatElapsed(stats.elapsedSeconds)}`;
      this.stepHint.style.color = 'var(--accent)';
      return;
    }

    const hint = stats.hint !== undefined ? stats.hint : (step.hint ?? '');
    this.stepHint.textContent = hint ? `💡 ${hint}` : '';
    this.stepHint.style.color = hint ? 'var(--accent-2)' : '';
  }

  /** 步骤清单：已完成的打勾、当前步骤高亮 */
  private renderStepList(stats: TutorialStats): void {
    const listKey =
      `${stats.level.id}|${stats.stepIndex}|${stats.stepDone}|${stats.levelComplete}`;
    if (listKey === this.lastListKey) return;
    this.lastListKey = listKey;

    this.stepList.innerHTML = '';
    stats.level.steps.forEach((step, index) => {
      const done = index < stats.stepIndex || (index === stats.stepIndex && stats.stepDone) ||
        stats.levelComplete;
      const active = index === stats.stepIndex && !stats.levelComplete;

      // 沿用 PrefabPanel 的做法：list 容器里放 <li>，样式钩子交给 .done / .active
      const item = document.createElement('li');
      item.className = 'step-item';
      item.classList.toggle('done', done);
      item.classList.toggle('active', active);
      // 兜底内联样式：等到 style.css 补上 #tut-step-list 的规则之前，
      // 至少看得到"完成的变灰、当前的加粗"
      item.style.listStyle = 'none';
      item.style.color = done ? 'var(--text-dim)' : '';
      item.style.fontWeight = active ? '700' : '';
      item.textContent = `${done ? '✓ ' : ''}${this.stepTitleOf(step, index)}`;
      item.title = step.text;
      this.stepList.appendChild(item);
    });
  }

  private renderButtons(stats: TutorialStats, step: TutorialStep | undefined): void {
    this.prevButton.disabled = stats.stepIndex <= 0;

    // 「做完了」只在 goal = 'manual' 的步骤可用（引擎检测不到的步骤才需要玩家自己确认），
    // 其余步骤禁用，避免玩家以为"点它就能跳过判定"
    const manual = step?.goal === 'manual';
    this.confirmButton.disabled = !manual;
    // 高亮规则：手动步骤高亮「做完了」（它是推进这一步的唯一方式），
    // 自动判定的步骤在检测通过后高亮「下一步」
    this.confirmButton.classList.toggle('primary', manual);
    this.nextButton.classList.toggle('primary', !manual && stats.stepDone);

    this.skipButton.disabled = stats.skipsLeft <= 0;
    this.skipButton.textContent = stats.skipsLeft > 0
      ? `跳过这一关（还剩 ${stats.skipsLeft} 次）`
      : '跳过这一关（次数已用完）';
  }

  /** 步骤标题：TutorialStep 没有 title，用 goal + 目标模型/关节类型拼一个短标题 */
  private stepTitleOf(step: TutorialStep, index: number): string {
    const prefix = `第 ${index + 1} 步 · `;
    const count = step.count && step.count > 1 ? ` ×${step.count}` : '';

    if (step.goal === 'place' && step.targetDefId) {
      const name = getBuildingDef(step.targetDefId)?.name ?? step.targetDefId;
      return `${prefix}放 ${name}${count}`;
    }
    if (step.goal === 'joint' && step.jointTypes && step.jointTypes.length > 0) {
      const types = step.jointTypes.map((type) => JOINT_TYPE_LABELS[type]).join(' + ');
      return `${prefix}连 ${types}${count}`;
    }
    if (step.goal === 'trigger' && step.targetDefId) {
      const name = getBuildingDef(step.targetDefId)?.name ?? step.targetDefId;
      return `${prefix}放触发器 ${name}${count}`;
    }
    return `${prefix}${GOAL_LABELS[step.goal]}`;
  }

  /** 显示（进入教学模式时调用） */
  show(): void {
    if (this.disposed) return;
    this.root.classList.toggle('visible', true);
    this.root.style.display = '';
    // 强制下一次 update() 重画（隐藏期间可能已经换了步骤）
    this.lastSignature = '';
  }

  hide(): void {
    if (this.disposed) return;
    this.root.classList.toggle('visible', false);
    this.root.style.display = 'none';
  }

  get isVisible(): boolean {
    return this.root.classList.contains('visible');
  }

  /**
   * 关卡完成时弹一个简短的庆祝提示。
   *
   * 刻意不做动画 / 不占定时器：低配手机上逐帧动画最费电，
   * 这里就写一行字到提示行，等 Engine 的下一次 update() 用同义的通关文案覆盖它。
   */
  celebrate(levelName: string, elapsedSeconds: number): void {
    if (this.disposed) return;
    this.stepHint.textContent = `🎉 通关：${levelName} —— 用时 ${formatElapsed(elapsedSeconds)}`;
    this.stepHint.style.color = 'var(--accent)';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prevButton.removeEventListener('click', this.handlePrevClick);
    this.nextButton.removeEventListener('click', this.handleNextClick);
    this.confirmButton.removeEventListener('click', this.handleConfirmClick);
    this.restartButton.removeEventListener('click', this.handleRestartClick);
    this.skipButton.removeEventListener('click', this.handleSkipClick);
    this.exitButton.removeEventListener('click', this.handleExitClick);
    this.stepList.innerHTML = '';
  }
}
