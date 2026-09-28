function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface ShortcutItem {
  /** 按键文本，例如 "Ctrl+Z"、"Shift + 滚轮"、"[ / ]" */
  keys: string;
  /** 中文说明 */
  description: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

/** 完整快捷键表（面板直接渲染它） */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '文件与历史',
    items: [
      { keys: 'Ctrl+Z', description: '撤销' },
      { keys: 'Ctrl+Y', description: '重做' },
      { keys: 'Ctrl+Shift+Z', description: '重做' },
      { keys: 'Ctrl+S', description: '保存到本地' },
      { keys: 'Ctrl+E', description: '导出 JSON' },
      { keys: 'Ctrl+O', description: '导入 JSON' },
      { keys: 'M', description: '主菜单 · 参考地图' },
    ],
  },
  {
    title: '相机',
    items: [
      { keys: 'W A S D / 方向键', description: '水平移动' },
      { keys: 'Q / E', description: '降 / 升' },
      { keys: 'Shift', description: '加速移动' },
      { keys: '中键拖拽', description: '旋转视角' },
      { keys: '右键拖拽', description: '平移' },
      { keys: '滚轮', description: '缩放' },
      { keys: 'F', description: '复位相机' },
      { keys: '双指拖动', description: '手机平移' },
      { keys: '双指捏合', description: '手机缩放' },
    ],
  },
  {
    title: '模式与工具',
    items: [
      { keys: 'Tab', description: '编辑 / 观察模式切换' },
      { keys: '1', description: '地形笔刷工具' },
      { keys: '2', description: '建筑放置工具' },
      { keys: '3', description: '选择工具' },
      { keys: '? 或 F1', description: '打开本速查表' },
    ],
  },
  {
    title: '笔刷',
    items: [
      { keys: 'Alt + 滚轮', description: '调半径' },
      { keys: 'Ctrl + 滚轮', description: '调强度' },
      { keys: '[ / ]', description: '切换笔刷形状' },
      { keys: '1~9 0 - =', description: '切换 12 种笔刷模式' },
      { keys: 'Shift', description: '按住反向（抬升↔下沉、挖洞↔填实）' },
      { keys: '左键拖拽', description: '连续涂抹' },
      { keys: '右键单击', description: '擦除' },
      { keys: '一次拖动', description: '= 一步撤销' },
    ],
  },
  {
    title: '建议与吸附',
    items: [
      { keys: '[ / ]', description: '切换智能放置候选点（建筑工具下）' },
      { keys: 'Enter', description: '确认放置' },
      { keys: 'Esc', description: '取消放置' },
      { keys: 'Ctrl + 滚轮', description: '微调旋转角' },
      { keys: 'G', description: '开关吸附点对齐' },
    ],
  },
  {
    title: '选择与微调',
    items: [
      { keys: '左键', description: '点击选中' },
      { keys: 'Ctrl + 左键', description: '加选 / 取消' },
      { keys: '拖拽', description: '框选' },
      { keys: 'Ctrl+A', description: '全选' },
      { keys: 'Esc', description: '清空选择' },
      { keys: '空格', description: '拿起 / 放下' },
      { keys: 'Delete', description: '删除选中' },
      { keys: 'Ctrl+D', description: '复制选中' },
      { keys: '方向键 ← → ↑ ↓', description: '微调位置' },
      { keys: ', / .', description: '绕 Y 轴微调旋转' },
      { keys: 'Ctrl+Z', description: '撤销微调' },
    ],
  },
  {
    title: '分组与蓝图',
    items: [
      { keys: 'Ctrl+G', description: '成组' },
      { keys: 'Ctrl+Shift+G', description: '解散组' },
      { keys: 'Ctrl+P', description: '保存为预制件' },
      { keys: 'Ctrl+B', description: '导出蓝图' },
      { keys: 'Ctrl+M', description: '镜像复制' },
    ],
  },
  {
    title: '物理与调试',
    items: [
      { keys: 'P', description: '暂停 / 播放' },
      { keys: 'N', description: '单步前进 1/60 秒' },
      { keys: '1× 2× 4×', description: '时间倍速按钮' },
      { keys: 'B', description: '区块边界' },
      { keys: '`', description: '地形线框' },
      { keys: 'R', description: '重建全部区块网格' },
    ],
  },
];

/**
 * 快捷键速查表（遮罩层）。
 *
 * 三件刻意的事：
 * 1. **分组可折叠**（`<details open>`）—— 8 组 50 多条一次全铺开太长，
 *    但默认全展开又比"先点开再找"快，所以用 open 起步、由玩家自己收；
 * 2. **键位文本与说明分开存**（keys / description）—— 渲染成 `<kbd>说明</kbd>` 两列，
 *    以后想做"按键筛选"只要过滤数据，不用改渲染；
 * 3. **这里不处理 `?` / `F1`** —— 开合由引擎统一分发，面板再监听一遍会一开一关白忙一场。
 */
export class ShortcutHelp {
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly closeButton: HTMLElement;

  private disposed = false;

  constructor() {
    this.overlay = must<HTMLElement>('#shortcut-help');
    this.list = must<HTMLElement>('#shortcut-list');
    this.closeButton = must<HTMLElement>('#btn-shortcut-close');

    this.render();

    this.closeButton.addEventListener('click', this.handleCloseClick);
    // 点遮罩空白处关闭（点卡片内部不关）
    this.overlay.addEventListener('click', this.handleOverlayClick);
    window.addEventListener('keydown', this.handleKeyDown);
  }

  private readonly handleCloseClick = (): void => {
    this.close();
  };

  private readonly handleOverlayClick = (ev: MouseEvent): void => {
    if (ev.target === this.overlay) this.close();
  };

  private readonly handleKeyDown = (ev: KeyboardEvent): void => {
    // 只收 Esc：? / F1 由引擎分发，避免双重触发把面板闪一下
    if (ev.key !== 'Escape') return;
    if (!this.isOpen) return;
    this.close();
  };

  private render(): void {
    this.list.innerHTML = '';
    for (const group of SHORTCUT_GROUPS) {
      const details = document.createElement('details');
      details.className = 'shortcut-group';
      details.open = true;

      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.appendChild(summary);

      const rows = document.createElement('div');
      rows.className = 'shortcut-rows';
      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';

        const kbd = document.createElement('kbd');
        kbd.textContent = item.keys;
        const text = document.createElement('span');
        text.textContent = item.description;

        row.appendChild(kbd);
        row.appendChild(text);
        rows.appendChild(row);
      }

      details.appendChild(rows);
      this.list.appendChild(details);
    }
  }

  open(): void {
    if (this.disposed) return;
    this.overlay.classList.add('visible');
  }

  close(): void {
    if (this.disposed) return;
    this.overlay.classList.remove('visible');
  }

  toggle(): void {
    if (this.disposed) return;
    this.overlay.classList.toggle('visible', !this.isOpen);
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('visible');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeButton.removeEventListener('click', this.handleCloseClick);
    this.overlay.removeEventListener('click', this.handleOverlayClick);
    window.removeEventListener('keydown', this.handleKeyDown);
  }
}
