import { BUILDING_CATALOG, getBuildingDef } from '../data/buildingCatalog';
import type { AppState } from '../appState';

function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

export interface BuildingPanelHandlers {
  /** 选中了一个模型（进入放置模式） */
  onSelect(defId: string): void;
  /** 旋转选中的实例 */
  onRotate(deltaDegrees: number): void;
  onDelete(): void;
  onDuplicate(): void;
  /** 把镜头对准选中的实例 */
  onFocus(): void;
  /** 放置设置变化 */
  onBuildSettingsChange(): void;
}

export interface BuildingPanelStats {
  /** 世界里已有的建筑数量 */
  instanceCount: number;
  /** 当前选中实例的说明 */
  selectionLabel: string;
  /** 当前放置检查结果 */
  placementLabel: string;
  /** 支撑检查结果（未开启时为空） */
  supportLabel: string;
}

/**
 * 建筑面板的"操作区"。
 *
 * ────────────────────────────────────────────────────────────
 * 浏览区（分类 / 搜索 / 分页 / 卡片）已经搬走了
 * ────────────────────────────────────────────────────────────
 * M4 第 2 批把物品浏览拆给了 `CatalogPanel`（它管 `#catalog-*` 那一整套节点）：
 * 387 个物品带来的搜索 / 二级分类 / 内容包 / 收藏这些事，和"摆好之后怎么转、
 * 怎么删"是两类完全不同的逻辑，混在一个类里谁都说不清改一行会动到哪块界面。
 * 所以这里**只保留**：
 * - 放置设置（吸附、步长、旋转步长）；
 * - 对已选中实例的操作按钮（旋转 / 删除 / 复制 / 对准）；
 * - 三行状态文字（选中说明、放置检查、支撑检查、世界内建筑数）。
 *
 * ⚠ 面板里的 `#building-search` / `#building-tabs` / `#building-grid` / `#building-pager`
 * 已从 index.html 移除，这里**不能再引用**，否则构造时 `must()` 会直接抛
 * 「UI 元素缺失」把整个应用带崩。
 *
 * 一个仍然保留的设计：选中模型后**不会立刻放置**，而是进入"放置模式"，
 * 由 3D 场景里的幽灵预览决定最终落点 —— 这样误点的代价只是换了个模型，
 * 不会往世界里乱丢东西。
 */
export class BuildingPanel {
  private readonly detail: HTMLElement;
  private readonly supportLabel: HTMLElement;
  private readonly placementLabel: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly snapInput: HTMLInputElement;
  private readonly snapStepSelect: HTMLSelectElement;
  private readonly rotationSelect: HTMLSelectElement;
  private readonly groundInput: HTMLInputElement;
  private readonly actionButtons: HTMLButtonElement[];

  /**
   * ⚠ 初值必须是 -Infinity 而不是 0：`performance.now()` 在页面启动后的头 150ms 内
   * 比这个节流窗口还小，用 0 当基线会把**第一次** update() 吞掉，状态文字就一直是空的。
   */
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly state: AppState,
    private readonly handlers: BuildingPanelHandlers,
  ) {
    this.detail = must<HTMLElement>('#building-detail');
    this.supportLabel = must<HTMLElement>('#support-label');
    this.placementLabel = must<HTMLElement>('#placement-label');
    this.countLabel = must<HTMLElement>('#building-count');
    this.snapInput = must<HTMLInputElement>('#build-snap');
    this.snapStepSelect = must<HTMLSelectElement>('#build-snapstep');
    this.rotationSelect = must<HTMLSelectElement>('#build-rotstep');
    this.groundInput = must<HTMLInputElement>('#build-ground');
    this.actionButtons = [
      ...must<HTMLElement>('#build-actions').querySelectorAll<HTMLButtonElement>('[data-build-action]'),
    ];

    this.bindEvents();
    this.syncControls();
    this.updateDetail();
  }

  private bindEvents(): void {
    for (const button of this.actionButtons) {
      button.addEventListener('click', () => {
        switch (button.dataset.buildAction) {
          case 'rotate-left':
            this.handlers.onRotate(-this.state.build.rotationStep);
            break;
          case 'rotate-right':
            this.handlers.onRotate(this.state.build.rotationStep);
            break;
          case 'delete':
            this.handlers.onDelete();
            break;
          case 'duplicate':
            this.handlers.onDuplicate();
            break;
          case 'focus':
            this.handlers.onFocus();
            break;
          default:
            break;
        }
      });
    }

    const notify = (): void => {
      this.state.build.snapToGrid = this.snapInput.checked;
      this.state.build.snapStep = Number(this.snapStepSelect.value);
      this.state.build.rotationStep = Number(this.rotationSelect.value);
      this.state.build.snapToGround = this.groundInput.checked;
      this.handlers.onBuildSettingsChange();
    };
    this.snapInput.addEventListener('change', notify);
    this.snapStepSelect.addEventListener('change', notify);
    this.rotationSelect.addEventListener('change', notify);
    this.groundInput.addEventListener('change', notify);
  }

  /**
   * 选中模型的说明。
   *
   * 浏览区搬走之后，这里**只负责说明当前选中的模型**（选哪个由 CatalogPanel 决定），
   * 不再参与任何列表渲染 —— 面板与列表之间只通过 `state.selectedBuildingId` 交流。
   */
  private updateDetail(): void {
    const def = this.state.selectedBuildingId ? getBuildingDef(this.state.selectedBuildingId) : null;
    if (!def) {
      this.detail.textContent = '从上面选一个模型，然后在场景里点地面放置。';
      return;
    }
    this.detail.innerHTML =
      `<b>${def.icon} ${def.name}</b>　<small>${def.category} · ${def.type}</small><br>` +
      `<span class="dim">${def.description}</span><br>` +
      `<span class="dim">尺寸 ${def.size[0]}×${def.size[1]}×${def.size[2]} m ｜ 质量 ${Math.round(def.mass)} kg ｜ ` +
      `摩擦 ${def.friction} ｜ 弹性 ${def.restitution}</span><br>` +
      `<span class="dim">标签：${def.tags.join('、')}</span>`;
  }

  private syncControls(): void {
    this.snapInput.checked = this.state.build.snapToGrid;
    this.snapStepSelect.value = String(this.state.build.snapStep);
    this.rotationSelect.value = String(this.state.build.rotationStep);
    this.groundInput.checked = this.state.build.snapToGround;
  }

  /** 每帧调用（节流） */
  update(stats: BuildingPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 150) return;
    this.lastRefresh = now;

    this.countLabel.textContent = `世界内建筑：${stats.instanceCount}`;
    this.supportLabel.textContent = stats.supportLabel;
    this.placementLabel.textContent = stats.placementLabel;

    const hasSelection = this.state.selectedInstanceId !== null;
    for (const button of this.actionButtons) {
      const action = button.dataset.buildAction;
      if (action === 'focus') continue;
      button.disabled = !hasSelection;
    }
  }

  /** 外部改变了选中状态后强制刷新 */
  syncAll(): void {
    this.updateDetail();
    this.syncControls();
    this.lastRefresh = Number.NEGATIVE_INFINITY; // 让下一次 update() 立刻生效，不被节流吞掉
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}

/** 供状态栏显示的简写：分类分布 */
export function buildingCategorySummary(): string {
  const counts = new Map<string, number>();
  for (const def of BUILDING_CATALOG) counts.set(def.category, (counts.get(def.category) ?? 0) + 1);
  return [...counts.entries()].map(([key, value]) => `${key}${value}`).join(' ');
}
