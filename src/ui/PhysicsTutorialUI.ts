/**
 * 物理教学界面层（PhysicsTutorialUI）。
 *
 * 和已有的 ui/TutorialUI.ts 是同一套做法，只做"把 Engine 算好的状态画出来"：
 * 关卡名、主题、第几步、步骤标题与正文、提示、进度条、**未达成清单**、用时、
 * 步骤清单、关卡进度点，以及六个按钮 + 进度点点击的回调转发。
 * 它**不做任何判定** —— "这一步算不算做完"由 tutorial/PhysicsTutorial.ts 的状态机决定
 * （判定结果连同中文原因一起通过 `unmet` 传进来），面板只负责显示。
 *
 * 三个取舍（都是照抄 TutorialUI 的经验，理由写在这里免得后来人改回去）：
 * 1. **不逐帧重排 DOM**：`update()` 每帧都会被调，但只有「关卡 / 步骤 / 是否完成 /
 *    未达成清单 / 整数秒」这些字段真的变了才写 DOM，签名没变直接返回（低配手机上重排清单很贵）；
 * 2. **.visible class + 内联 display 兜底**：`#physics-tutorial-panel` 的隐藏规则要等
 *    index.html / style.css 补上，在那之前"关不掉的面板挡在屏幕角落"比什么都难受；
 * 3. **庆祝不做动画**：低配手机上逐帧动画最费电，`celebrate()` 只往 `#ptut-step-hint`
 *    写一行字，等下一次 `update()` 用正常内容覆盖它（复用节点，不加新 DOM）。
 *
 * 手机可点面积：六个按钮都写 `type="button"` 并强制 `min-height: 44px`，
 * 免得 index.html 漏写时在 <form> 里变成提交键、或者高度不够点不中。
 */

import type { PhysicsTutorialLevel } from '../tutorial/PhysicsTutorial';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 把秒数格式化成 mm:ss（超过 99 分钟自然进位，不做特殊处理） */
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

/** 进度点不可点时 title 里说的话（要么想看清为什么，要么就想点一下） */
const LOCKED_DOT_TITLE = '这一关还没解锁：先把它前面的关卡走完（不能跳关）';

export interface PhysicsTutorialUIHandlers {
  onNext(): void;
  onPrev(): void;
  onConfirmStep(): void;
  onRestart(): void;
  onSkipLevel(): void;
  onExit(): void;
  /** 点了某一关的进度点（允许直接跳到已解锁的关卡） */
  onJumpToLevel(index: number): void;
}

export interface PhysicsTutorialUIStats {
  level: PhysicsTutorialLevel;
  levelIndex: number;
  totalLevels: number;
  stepIndex: number;
  stepDone: boolean;
  /** 未达成的中文原因（空数组 = 已达成） */
  unmet: string[];
  progress: number;
  elapsedSeconds: number;
  skipsLeft: number;
  completedLevels: number;
  /** 是否所有关卡都通了 */
  allComplete: boolean;
}

/**
 * 物理教学面板。
 *
 * 初始隐藏：玩家没进物理教学时不该看到它，构造完就 `hide()`，Engine 进入教学时再 `show()`。
 */
export class PhysicsTutorialUI {
  private readonly root: HTMLElement;
  private readonly levelName: HTMLElement;
  private readonly levelProgress: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly stepIndexLabel: HTMLElement;
  private readonly stepTitle: HTMLElement;
  private readonly stepText: HTMLElement;
  private readonly stepHint: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly unmetList: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly estimated: HTMLElement;
  private readonly stepList: HTMLElement;
  private readonly levelDots: HTMLElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;

  /** 上一次 update() 的状态签名（变了才写 DOM） */
  private lastSignature = '';
  /** 上一次重建未达成清单 / 步骤清单 / 进度点时的关键字段 */
  private lastUnmetKey = '';
  private lastListKey = '';
  private lastDotsKey = '';
  private disposed = false;

  constructor(private readonly handlers: PhysicsTutorialUIHandlers) {
    this.root = must<HTMLElement>('#physics-tutorial-panel');
    this.levelName = must<HTMLElement>('#ptut-level-name', this.root);
    this.levelProgress = must<HTMLElement>('#ptut-level-progress', this.root);
    this.summary = must<HTMLElement>('#ptut-summary', this.root);
    this.stepIndexLabel = must<HTMLElement>('#ptut-step-index', this.root);
    this.stepTitle = must<HTMLElement>('#ptut-step-title', this.root);
    this.stepText = must<HTMLElement>('#ptut-step-text', this.root);
    this.stepHint = must<HTMLElement>('#ptut-step-hint', this.root);
    this.progressFill = must<HTMLElement>('#ptut-progress-fill', this.root);
    this.unmetList = must<HTMLElement>('#ptut-unmet', this.root);
    this.elapsed = must<HTMLElement>('#ptut-elapsed', this.root);
    this.estimated = must<HTMLElement>('#ptut-estimated', this.root);
    this.stepList = must<HTMLElement>('#ptut-step-list', this.root);
    this.levelDots = must<HTMLElement>('#ptut-level-dots', this.root);
    this.prevButton = must<HTMLButtonElement>('#ptut-prev', this.root);
    this.nextButton = must<HTMLButtonElement>('#ptut-next', this.root);
    this.confirmButton = must<HTMLButtonElement>('#ptut-confirm', this.root);
    this.restartButton = must<HTMLButtonElement>('#ptut-restart', this.root);
    this.skipButton = must<HTMLButtonElement>('#ptut-skip', this.root);
    this.exitButton = must<HTMLButtonElement>('#ptut-exit', this.root);

    for (const button of [
      this.prevButton,
      this.nextButton,
      this.confirmButton,
      this.restartButton,
      this.skipButton,
      this.exitButton,
    ]) {
      button.type = 'button';
      // 手机可点面积：44px 是手指能稳定点中的下限
      button.style.minHeight = '44px';
    }

    this.prevButton.addEventListener('click', this.handlePrevClick);
    this.nextButton.addEventListener('click', this.handleNextClick);
    this.confirmButton.addEventListener('click', this.handleConfirmClick);
    this.restartButton.addEventListener('click', this.handleRestartClick);
    this.skipButton.addEventListener('click', this.handleSkipClick);
    this.exitButton.addEventListener('click', this.handleExitClick);
    // 进度点用事件代理：数量随关卡数变化，逐个挂监听会在换关时漏掉新点
    this.levelDots.addEventListener('click', this.handleDotsClick);

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

  /**
   * 进度点点击。**能不能跳由这里再判一次**：
   * 只有 `index <= completedLevels` 的关卡允许跳（不能跳过没通关的关卡），
   * 不可跳的点带 `data-locked`，点上去什么都不发生 —— 面板的 disabled 样式只是提示，
   * 真正的门禁在这里。
   */
  private readonly handleDotsClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const dot = target.closest<HTMLElement>('[data-level-index]');
    if (!dot || dot.dataset.locked === '1') return;
    const index = Number(dot.dataset.levelIndex);
    if (!Number.isInteger(index) || index < 0) return;
    this.handlers.onJumpToLevel(index);
  };

  update(stats: PhysicsTutorialUIStats): void {
    if (this.disposed) return;

    const seconds = Math.max(0, Math.floor(stats.elapsedSeconds));
    const unmetKey = stats.unmet.join('｜');
    // 整数秒也算进签名：用时每秒跳一次，其余字段都是低频的
    const signature =
      `${stats.level.id}|${stats.levelIndex}/${stats.totalLevels}|${stats.stepIndex}|` +
      `${stats.stepDone}|${unmetKey}|${Math.round(clamp01(stats.progress) * 100)}|` +
      `${seconds}|${stats.skipsLeft}|${stats.completedLevels}|${stats.allComplete}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const step = stats.level.steps[stats.stepIndex];
    const totalSteps = stats.level.steps.length;

    this.renderHeader(stats);
    this.renderStep(stats, step, totalSteps);
    this.renderUnmet(unmetKey, stats.unmet);
    this.renderStepList(stats);
    this.renderLevelDots(stats);
    this.renderButtons(stats, step);

    this.progressFill.style.width = `${Math.round(clamp01(stats.progress) * 100)}%`;
    this.renderTime(stats, seconds, step?.hint ?? '');
  }

  /** 关卡名 + 「第 N 关 / 共 M 关」+ 主题 */
  private renderHeader(stats: PhysicsTutorialUIStats): void {
    const level = stats.level;
    this.levelName.textContent = `${level.emoji} ${level.name}`.trim();
    this.levelName.title = level.completion;
    this.levelProgress.textContent = `第 ${stats.levelIndex + 1} 关 / 共 ${stats.totalLevels} 关`;
    this.summary.textContent = level.summary;
  }

  private renderStep(
    stats: PhysicsTutorialUIStats,
    step: PhysicsTutorialLevel['steps'][number] | undefined,
    totalSteps: number,
  ): void {
    if (!step) {
      this.stepIndexLabel.textContent = '步骤 —';
      this.stepTitle.textContent = '没有更多步骤';
      this.stepText.textContent = '';
      return;
    }
    this.stepIndexLabel.textContent = `步骤 ${stats.stepIndex + 1} / ${totalSteps}`;
    this.stepTitle.textContent = step.title;
    this.stepText.textContent = step.text;
  }

  /**
   * 未达成清单：**逐条**列出状态机给的中文原因，玩家一眼就知道还差什么。
   *
   * 这是这个面板最有用的一块，所以不做"只显示第一条"的节省；
   * 已经达成时给一句确定的话（而不是空着），免得玩家以为面板坏了。
   */
  private renderUnmet(unmetKey: string, unmet: string[]): void {
    if (unmetKey === this.lastUnmetKey) return;
    this.lastUnmetKey = unmetKey;

    this.unmetList.innerHTML = '';
    if (unmet.length === 0) {
      const line = document.createElement('p');
      line.className = 'inline-label dim';
      line.textContent = '这一小步已经完成了';
      this.unmetList.appendChild(line);
      return;
    }
    for (const reason of unmet) {
      const line = document.createElement('p');
      line.className = 'inline-label warn';
      line.textContent = `· ${reason}`;
      this.unmetList.appendChild(line);
    }
  }

  /** 步骤清单：已完成的打勾、当前步骤高亮 */
  private renderStepList(stats: PhysicsTutorialUIStats): void {
    const listKey = `${stats.level.id}|${stats.stepIndex}|${stats.stepDone}|${stats.allComplete}`;
    if (listKey === this.lastListKey) return;
    this.lastListKey = listKey;

    this.stepList.innerHTML = '';
    stats.level.steps.forEach((step, index) => {
      const done =
        index < stats.stepIndex || (index === stats.stepIndex && stats.stepDone) || stats.allComplete;
      const active = index === stats.stepIndex && !stats.allComplete;

      const item = document.createElement('li');
      item.className = 'step-item';
      item.classList.toggle('done', done);
      item.classList.toggle('active', active);
      // 兜底内联样式：等 style.css 补上 #ptut-step-list 的规则之前，
      // 至少看得到"完成的变灰、当前的加粗"
      item.style.listStyle = 'none';
      item.style.color = done ? 'var(--text-dim)' : 'var(--text)';
      item.style.fontWeight = active ? '700' : '';
      item.textContent = `${done ? '✓ ' : ''}${index + 1}. ${step.title}`;
      item.title = step.text;
      this.stepList.appendChild(item);
    });
  }

  /**
   * 关卡进度点：totalLevels 个圆点，已完成的加 `done`、当前的加 `active`。
   *
   * 跳关规则：只有 `index <= completedLevels` 的关卡能跳（已通关的可以回去复习），
   * 后面的点加 `disabled` 类、变半透明，并在 `title` 里写清原因 —— 不给玩家留"点了没反应"的疑惑。
   */
  private renderLevelDots(stats: PhysicsTutorialUIStats): void {
    const dotsKey =
      `${stats.totalLevels}|${stats.completedLevels}|${stats.levelIndex}|${stats.allComplete}`;
    if (dotsKey === this.lastDotsKey) return;
    this.lastDotsKey = dotsKey;

    this.levelDots.innerHTML = '';
    for (let index = 0; index < stats.totalLevels; index++) {
      const done = index < stats.completedLevels;
      const active = index === stats.levelIndex;
      const jumpable = index <= stats.completedLevels;

      const dot = document.createElement('i');
      dot.dataset.levelIndex = String(index);
      if (!jumpable) dot.dataset.locked = '1';
      dot.className = active ? 'active' : done ? 'done' : '';
      if (!jumpable) dot.classList.add('disabled');

      // 用 <i> + 内联样式：契约要求进度点不依赖新的 CSS 规则也能看出来
      dot.style.display = 'inline-block';
      dot.style.width = '10px';
      dot.style.height = '10px';
      dot.style.borderRadius = '50%';
      dot.style.margin = '0 4px 0 0';
      dot.style.background = active
        ? 'var(--accent)'
        : done
          ? 'var(--accent-2)'
          : 'var(--panel-border)';
      dot.style.opacity = jumpable ? '1' : '0.45';
      dot.style.cursor = jumpable ? 'pointer' : 'default';
      dot.title = jumpable
        ? `第 ${index + 1} 关${active ? '（当前）' : '：已解锁，点了可以跳过去'}`
        : `${LOCKED_DOT_TITLE}（第 ${index + 1} 关）`;

      this.levelDots.appendChild(dot);
    }
  }

  private renderButtons(
    stats: PhysicsTutorialUIStats,
    step: PhysicsTutorialLevel['steps'][number] | undefined,
  ): void {
    this.prevButton.disabled = stats.levelIndex <= 0 && stats.stepIndex <= 0;

    // 「做完了」只在带 manual 目标的步骤可用：引擎确实检测不到那些东西，
    // 其余步骤禁用，免得玩家以为"点它就能跳过判定"
    const manual = step ? step.goals.some((goal) => goal.kind === 'manual') : false;
    this.confirmButton.disabled = !manual;
    // 高亮规则：手动步骤高亮「做完了」（它是推进这一步的唯一方式），
    // 自动判定的步骤在达成后高亮「下一步」
    this.confirmButton.classList.toggle('primary', manual && !stats.stepDone);
    // 契约：stepDone === true 时「下一步」加 primary 并把文案变成「下一步 ✓」。
    // 不做"最后一步改成完成本关"之类的额外文案 —— 玩家在六个按钮里认的是同一句话。
    this.nextButton.classList.toggle('primary', stats.stepDone);
    this.nextButton.textContent = stats.stepDone ? '下一步 ✓' : '下一步 ▶';

    this.skipButton.disabled = stats.skipsLeft <= 0;
    this.skipButton.textContent =
      stats.skipsLeft > 0
        ? `跳过这一关（还剩 ${stats.skipsLeft} 次）`
        : '跳过这一关（次数已用完）';
  }

  /**
   * 用时 + 提示。
   *
   * 超时只在用时上加 `warn` 并**多给一句安慰**（「没关系，物理就是慢慢试」）：
   * 教学面板的职责是让人愿意继续试，不是催人 —— 所以这里不弹窗、不响铃、不改按钮文案。
   */
  private renderTime(
    stats: PhysicsTutorialUIStats,
    seconds: number,
    stepHint: string,
  ): void {
    this.elapsed.textContent = `⏱ ${formatElapsed(seconds)}`;

    const estimatedMinutes = stats.level.estimatedMinutes;
    this.estimated.textContent = `建议 ${estimatedMinutes} 分钟`;

    // 超过建议用时 1.5 倍才算"慢"，低于这个数不提，免得刚开局就给人压力
    const limitSeconds = estimatedMinutes * 60 * 1.5;
    const overtime = limitSeconds > 0 && seconds > limitSeconds;
    this.elapsed.classList.toggle('warn', overtime);

    const usedMinutes = Math.max(1, Math.round(seconds / 60));
    const lines = stepHint ? [`💡 ${stepHint}`] : [];
    if (overtime) {
      lines.push(
        `用了 ${usedMinutes} 分钟，超过建议的 ${estimatedMinutes} 分钟（没关系，物理就是慢慢试）`,
      );
    }
    this.stepHint.textContent = lines.join('　');
    this.stepHint.classList.toggle('warn', overtime);
    this.stepHint.style.color = stepHint ? 'var(--accent-2)' : 'var(--text-dim)';
  }

  /** 显示（进入物理教学时调用） */
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
   * 通关庆祝（不做花哨动画，低配手机跑不动）。
   *
   * 就写一行字到 `#ptut-step-hint`（复用现成节点，不加 DOM、不设定时器、不做补间），
   * 下一次 `update()` 会用正常的提示把它覆盖掉。
   */
  celebrate(levelName: string, elapsedSeconds: number, allComplete: boolean): void {
    if (this.disposed) return;
    const head = `🎉 通关：${levelName} —— 用时 ${formatElapsed(elapsedSeconds)}`;
    const tail = allComplete ? ' · 六关全部到手，物理沙盘随你玩' : '';
    this.stepHint.textContent = head + tail;
    this.stepHint.classList.remove('warn');
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
    this.levelDots.removeEventListener('click', this.handleDotsClick);
    this.stepList.innerHTML = '';
    this.unmetList.innerHTML = '';
    this.levelDots.innerHTML = '';
  }
}
