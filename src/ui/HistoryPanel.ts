function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 把文本塞进 innerHTML 前先转义（操作名由引擎拼接，可能含 < > 或引号） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 历史里的一条操作记录 */
export interface HistoryEntry {
  /** 已应用操作里的序号，0 开始 */
  index: number;
  /** 操作名，例如 "抬升 · 137 格"、"放置 石墙" */
  label: string;
  /** 时间戳（Date.now()） */
  time: number;
  /** 该操作改动的体素数 */
  voxelChanges: number;
  /** 新增的建筑数 */
  buildingsAdded: number;
  /** 删除的建筑数 */
  buildingsRemoved: number;
  /** 被移动/旋转的物体数 */
  transforms: number;
}

export interface HistoryPanelHandlers {
  onUndo(): void;
  onRedo(): void;
  onClear(): void;
  /** 回退或前进到"第 index 步已应用"的状态（index = -1 表示回到最初） */
  onJumpTo(index: number): void;
}

export interface HistoryPanelStats {
  /** 已经应用的操作（从旧到新，也就是撤销栈的内容） */
  entries: HistoryEntry[];
  /** 可重做的步数 */
  redoCount: number;
  /** 当前处在第几步（= entries.length - 1）；没有任何操作时是 -1 */
  cursor: number;
}

/** 列表里最多渲染多少条（更早的折叠成一行提示） */
const MAX_RENDERED = 60;

/** 引擎侧的历史深度上限，只用来写提示文案 */
const HISTORY_LIMIT = 100;

/**
 * 操作历史面板：撤销 / 重做 / 一步跳到任意历史点。
 *
 * 两个取舍：
 * 1. **列表只渲染最近 60 条** —— 历史最多留 100 步，全画出来手机上根本滚不动，
 *    更早的部分折叠成一行"…还有 N 条更早的操作"；
 * 2. **刷新按 200ms 节流** —— 拖拽笔刷时历史每帧都在变，逐帧重排 DOM 会拖慢帧率，
 *    而历史面板晚 200ms 更新对玩家毫无影响。外部改了历史后调 syncAll() 立即对齐。
 */
export class HistoryPanel {
  private readonly undoCountLabel: HTMLElement;
  private readonly redoCountLabel: HTMLElement;
  private readonly cursorLabel: HTMLElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly hintLabel: HTMLElement;
  private readonly list: HTMLElement;

  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: HistoryPanelHandlers) {
    this.undoCountLabel = must<HTMLElement>('#history-undo-count');
    this.redoCountLabel = must<HTMLElement>('#history-redo-count');
    this.cursorLabel = must<HTMLElement>('#history-cursor');
    this.undoButton = must<HTMLButtonElement>('#btn-history-undo');
    this.redoButton = must<HTMLButtonElement>('#btn-history-redo');
    this.clearButton = must<HTMLButtonElement>('#btn-history-clear');
    this.hintLabel = must<HTMLElement>('#history-hint');
    this.list = must<HTMLElement>('#history-list');

    this.undoButton.addEventListener('click', this.handleUndoClick);
    this.redoButton.addEventListener('click', this.handleRedoClick);
    this.clearButton.addEventListener('click', this.handleClearClick);
    // 列表用事件委托：条目会被整批重建，逐条绑监听在 100 步时会很浪费
    this.list.addEventListener('click', this.handleListClick);
  }

  private readonly handleUndoClick = (): void => {
    this.handlers.onUndo();
  };

  private readonly handleRedoClick = (): void => {
    this.handlers.onRedo();
  };

  private readonly handleClearClick = (): void => {
    this.handlers.onClear();
  };

  private readonly handleListClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>('.history-item');
    if (!item) return;

    const raw = item.dataset.index;
    if (raw === undefined) return;
    const index = Number.parseInt(raw, 10);
    if (Number.isNaN(index)) return;

    this.handlers.onJumpTo(index);
  };

  /** 每帧调用（内部按 200ms 节流） */
  update(stats: HistoryPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 200) return;
    this.lastRefresh = now;
    this.refresh(stats);
  }

  /** 立即刷新一次（外部改完历史后调用，例如撤销/重做之后） */
  syncAll(stats: HistoryPanelStats): void {
    if (this.disposed) return;
    this.lastRefresh = 0;
    this.refresh(stats);
  }

  private refresh(stats: HistoryPanelStats): void {
    const total = stats.entries.length;
    const applied = stats.cursor < 0 ? 0 : stats.cursor + 1;

    this.undoCountLabel.textContent = String(total);
    this.redoCountLabel.textContent = String(stats.redoCount);
    this.cursorLabel.textContent = `${applied} / ${total}`;

    this.undoButton.disabled = total === 0;
    this.redoButton.disabled = stats.redoCount === 0;
    this.clearButton.disabled = total === 0 && stats.redoCount === 0;

    this.hintLabel.textContent =
      '点列表里的任意一步可以直接回退到那一步' + (total > 0 ? `（最多保留 ${HISTORY_LIMIT} 步）` : '');

    this.renderList(stats);
  }

  private renderList(stats: HistoryPanelStats): void {
    this.list.innerHTML = '';
    const entries = stats.entries;

    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没有任何操作，画一笔试试';
      this.list.appendChild(empty);
      return;
    }

    // 倒序：最新的在最上面，符合"刚做完的动作最相关"的直觉
    const oldest = Math.max(0, entries.length - MAX_RENDERED);
    for (let i = entries.length - 1; i >= oldest; i -= 1) {
      const entry = entries[i];
      const item = document.createElement('li');
      item.className = 'history-item';
      item.dataset.index = String(entry.index);
      if (entry.index > stats.cursor) item.classList.add('future');
      if (entry.index === stats.cursor) item.classList.add('current');

      item.innerHTML =
        `<b>#${entry.index + 1}</b>` +
        `<span class="label">${escapeHtml(entry.label)}</span>` +
        `<small class="time">${new Date(entry.time).toLocaleTimeString('zh-CN')}</small>` +
        `<small class="changes">${this.formatChanges(entry)}</small>`;
      this.list.appendChild(item);
    }

    if (oldest > 0) {
      const more = document.createElement('li');
      more.className = 'empty';
      more.textContent = `…还有 ${oldest} 条更早的操作`;
      this.list.appendChild(more);
    }
  }

  /** 改动摘要，例如 "体素 137 · 建筑 +1"；某类改动为 0 就不显示它 */
  private formatChanges(entry: HistoryEntry): string {
    const parts: string[] = [];
    if (entry.voxelChanges > 0) parts.push(`体素 ${entry.voxelChanges}`);
    if (entry.buildingsAdded > 0) parts.push(`建筑 +${entry.buildingsAdded}`);
    if (entry.buildingsRemoved > 0) parts.push(`建筑 -${entry.buildingsRemoved}`);
    if (entry.transforms > 0) parts.push(`变换 ${entry.transforms}`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.undoButton.removeEventListener('click', this.handleUndoClick);
    this.redoButton.removeEventListener('click', this.handleRedoClick);
    this.clearButton.removeEventListener('click', this.handleClearClick);
    this.list.removeEventListener('click', this.handleListClick);
  }
}
