/**
 * 确认对话框（问题 4.1：换地图前先问一句「要不要先保存」）。
 *
 * 这里和 M1.5 的决策是**反的**，得说清楚为什么改。
 *
 * M1.5 的判断是：换地图不必确认——因为地图随时能重新生成，弹窗只会打断「点开看看」的探索欲。
 * 但 M2.5 起这个判断不成立了：玩家会花十几分钟用笔刷雕地形、堆建筑、接关节，
 * 这些**不可能靠重新生成地图复原**。这时候「一键换图 = 静默清空成果」是不可接受的。
 *
 * 于是改成：**只在真的会有损失时才问**。`shouldAsk()` 由调用方用「有没有未保存的改动」来判断，
 * 没有任何改动时照样直接换，不打扰。
 *
 * 三个选项而不是两个，是因为「取消」和「先保存」是两种完全不同的意图，
 * 两个按钮的二选一会逼玩家在「丢掉成果」和「放弃换图」之间硬选。
 *
 * DOM 现建现挂（同 LoadingOverlay）：关键路径上的组件不该依赖 index.html 里的 id。
 */

export type ConfirmChoice = 'confirm' | 'save' | 'cancel';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 主按钮文字，默认「继续」 */
  confirmLabel?: string;
  /** 次要按钮文字（例如「先保存再继续」）；不传则不显示 */
  extraLabel?: string;
  /** 取消按钮文字，默认「取消」 */
  cancelLabel?: string;
  /** 点遮罩/Esc 时算哪个选择，默认 'cancel' */
  dismissAs?: ConfirmChoice;
}

export class ConfirmDialog {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly messageEl: HTMLParagraphElement;
  private readonly confirmBtn: HTMLButtonElement;
  private readonly extraBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private resolve: ((choice: ConfirmChoice) => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'confirm-dialog';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    Object.assign(this.root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(6, 9, 12, 0.62)',
      zIndex: '980',
      padding: '20px',
      backdropFilter: 'blur(2px)',
    } satisfies Partial<CSSStyleDeclaration>);

    this.card = document.createElement('div');
    Object.assign(this.card.style, {
      width: 'min(420px, 92vw)',
      background: '#161b22',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '14px',
      padding: '20px',
      color: '#e8eef5',
      font: '14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 18px 48px rgba(0,0,0,0.5)',
    } satisfies Partial<CSSStyleDeclaration>);

    this.titleEl = document.createElement('h3');
    Object.assign(this.titleEl.style, { margin: '0 0 10px', fontSize: '16px', fontWeight: '600' });

    this.messageEl = document.createElement('p');
    Object.assign(this.messageEl.style, { margin: '0 0 18px', color: '#b9c6d4', whiteSpace: 'pre-line' });

    const footer = document.createElement('div');
    Object.assign(footer.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });

    this.cancelBtn = this.makeButton('取消', 'ghost');
    this.extraBtn = this.makeButton('先保存再继续', 'ghost');
    this.confirmBtn = this.makeButton('继续', 'primary');

    footer.append(this.cancelBtn, this.extraBtn, this.confirmBtn);
    this.card.append(this.titleEl, this.messageEl, footer);
    this.root.appendChild(this.card);
    document.body.appendChild(this.root);

    this.cancelBtn.addEventListener('click', () => this.settle('cancel'));
    this.extraBtn.addEventListener('click', () => this.settle('save'));
    this.confirmBtn.addEventListener('click', () => this.settle('confirm'));
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root) this.settle(this.dismissAs);
    });
    window.addEventListener('keydown', this.handleKey);
  }

  /** 遮罩被点击时算作哪个选择 */
  private dismissAs: ConfirmChoice = 'cancel';

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  /** 打开并等待玩家选择 */
  ask(options: ConfirmOptions): Promise<ConfirmChoice> {
    // 重复打开时，上一个等待者按「取消」结算，避免 Promise 永远挂着
    this.settle('cancel');

    this.dismissAs = options.dismissAs ?? 'cancel';
    this.titleEl.textContent = options.title;
    this.messageEl.textContent = options.message;
    this.confirmBtn.textContent = options.confirmLabel ?? '继续';
    this.cancelBtn.textContent = options.cancelLabel ?? '取消';
    this.extraBtn.textContent = options.extraLabel ?? '';
    this.extraBtn.style.display = options.extraLabel ? 'inline-block' : 'none';

    this.root.style.display = 'flex';
    // 焦点给「取消」而不是「继续」：危险操作的默认焦点应当是安全的那个
    this.cancelBtn.focus();

    return new Promise<ConfirmChoice>((resolve) => {
      this.resolve = resolve;
    });
  }

  close(): void {
    this.settle('cancel');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKey);
    this.settle('cancel');
    this.root.remove();
  }

  private settle(choice: ConfirmChoice): void {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = null;
    this.root.style.display = 'none';
    resolve(choice);
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.settle(this.dismissAs);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.settle('confirm');
    }
  };

  private makeButton(label: string, kind: 'primary' | 'ghost'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    const base: Partial<CSSStyleDeclaration> = {
      minHeight: '40px',
      minWidth: '88px',
      padding: '0 16px',
      borderRadius: '9px',
      fontSize: '14px',
      cursor: 'pointer',
      border: '1px solid transparent',
    };
    Object.assign(
      button.style,
      kind === 'primary'
        ? { ...base, background: '#2f81f7', color: '#fff', borderColor: '#2f81f7' }
        : { ...base, background: 'rgba(255,255,255,0.06)', color: '#e8eef5', borderColor: 'rgba(255,255,255,0.14)' },
    );
    return button;
  }
}
