function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI 元素缺失：${selector}（检查 index.html）`);
  return el;
}

/** 把文本塞进 innerHTML 前先转义（组名/预制件名是玩家起的，缩略图是 data URL） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface PrefabPanelHandlers {
  /** 把当前选中的物体打成一个组 */
  onCreateGroup(): void;
  /** 解散当前选中的组 */
  onUngroup(): void;
  /** 选中某个组里的所有物体 */
  onSelectGroup(groupId: string): void;
  /** 删除某个组（只解散，不删物体） */
  onDeleteGroup(groupId: string): void;
  /** 把当前选中保存成预制件 */
  onSavePrefab(): void;
  /** 把某个预制件放到光标位置 */
  onPlacePrefab(prefabId: string): void;
  onDeletePrefab(prefabId: string): void;
  onExportBlueprint(): void;
  onImportBlueprint(file: File): void;
}

/** 组 / 预制件的展示摘要（由引擎组装） */
export interface GroupSummary {
  id: string;
  name: string;
  objectCount: number;
}

export interface PrefabSummary {
  id: string;
  name: string;
  /** SVG data URL 缩略图，直接塞进 <img src> */
  thumbnail: string;
  objectCount: number;
  createdAt: number;
}

export interface PrefabPanelStats {
  groups: GroupSummary[];
  prefabs: PrefabSummary[];
  /** 当前选中的组（没有就是 null） */
  selectedGroupId: string | null;
  /** 当前选中的物体数量 */
  selectedCount: number;
  /** 蓝图状态提示文字 */
  blueprintStatus: string;
}

/**
 * 分组 / 预制件 / 蓝图面板。
 *
 * 三条取舍：
 * 1. **"放置"必须点按钮，点卡片只是选中** —— 手机上手指扫过列表太容易误触，
 *    而"把一整套建筑丢到光标下"这动作要么不做、要么明确做；
 * 2. **`update()` 按 200ms 节流** —— 选中数量随框选每帧都在跳，逐帧重排列表会拖慢帧率，
 *    外部改了列表后调 syncAll() 立即对齐；
 * 3. **选中的 id 每帧校验一次**（不在列表里就置 null）—— 否则组被解散后
 *    "选中组/解散"按钮会对着一个不存在的 id 生效，玩家看到的是一片沉默。
 */
export class PrefabPanel {
  private readonly groupNameInput: HTMLInputElement;
  private readonly createGroupButton: HTMLButtonElement;
  private readonly ungroupButton: HTMLButtonElement;
  private readonly selectGroupButton: HTMLButtonElement;
  private readonly groupList: HTMLElement;
  private readonly savePrefabButton: HTMLButtonElement;
  private readonly placePrefabButton: HTMLButtonElement;
  private readonly deletePrefabButton: HTMLButtonElement;
  private readonly prefabList: HTMLElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly importButton: HTMLButtonElement;
  private readonly blueprintInput: HTMLInputElement;
  private readonly blueprintStatus: HTMLElement;

  private selectedGroupId: string | null = null;
  private selectedPrefabId: string | null = null;
  private lastRefresh = 0;
  private disposed = false;

  constructor(private readonly handlers: PrefabPanelHandlers) {
    const root = must<HTMLElement>('#prefab-panel');
    this.groupNameInput = must<HTMLInputElement>('#group-name', root);
    this.createGroupButton = must<HTMLButtonElement>('#btn-group-create', root);
    this.ungroupButton = must<HTMLButtonElement>('#btn-group-ungroup', root);
    this.selectGroupButton = must<HTMLButtonElement>('#btn-group-select', root);
    this.groupList = must<HTMLElement>('#group-list', root);
    this.savePrefabButton = must<HTMLButtonElement>('#btn-prefab-save', root);
    this.placePrefabButton = must<HTMLButtonElement>('#btn-prefab-place', root);
    this.deletePrefabButton = must<HTMLButtonElement>('#btn-prefab-delete', root);
    this.prefabList = must<HTMLElement>('#prefab-list', root);
    this.exportButton = must<HTMLButtonElement>('#btn-blueprint-export', root);
    this.importButton = must<HTMLButtonElement>('#btn-blueprint-import', root);
    this.blueprintInput = must<HTMLInputElement>('#blueprint-input', root);
    this.blueprintStatus = must<HTMLElement>('#blueprint-status', root);

    this.createGroupButton.addEventListener('click', this.handleCreateGroupClick);
    this.ungroupButton.addEventListener('click', this.handleUngroupClick);
    this.selectGroupButton.addEventListener('click', this.handleSelectGroupClick);
    this.savePrefabButton.addEventListener('click', this.handleSavePrefabClick);
    this.placePrefabButton.addEventListener('click', this.handlePlacePrefabClick);
    this.deletePrefabButton.addEventListener('click', this.handleDeletePrefabClick);
    this.exportButton.addEventListener('click', this.handleExportClick);
    this.importButton.addEventListener('click', this.handleImportClick);
    this.blueprintInput.addEventListener('change', this.handleBlueprintChange);
    // 两个列表用事件委托：卡片会被整批重建，逐张绑监听会随预制件数量线性变慢
    this.groupList.addEventListener('click', this.handleGroupListClick);
    this.prefabList.addEventListener('click', this.handlePrefabListClick);

    // 先按"什么都没选"对齐一次按钮状态，免得开局按钮亮着却点不动
    this.syncGroupButtons();
    this.syncPrefabButtons();
  }

  private readonly handleCreateGroupClick = (): void => {
    this.handlers.onCreateGroup();
  };

  private readonly handleUngroupClick = (): void => {
    this.handlers.onUngroup();
  };

  private readonly handleSelectGroupClick = (): void => {
    if (this.selectedGroupId === null) return;
    this.handlers.onSelectGroup(this.selectedGroupId);
  };

  private readonly handleSavePrefabClick = (): void => {
    this.handlers.onSavePrefab();
  };

  private readonly handlePlacePrefabClick = (): void => {
    if (this.selectedPrefabId === null) return;
    this.handlers.onPlacePrefab(this.selectedPrefabId);
  };

  private readonly handleDeletePrefabClick = (): void => {
    if (this.selectedPrefabId === null) return;
    const prefabId = this.selectedPrefabId;
    this.selectedPrefabId = null;
    this.handlers.onDeletePrefab(prefabId);
    this.markPrefabSelection();
    this.syncPrefabButtons();
  };

  private readonly handleExportClick = (): void => {
    this.handlers.onExportBlueprint();
  };

  private readonly handleImportClick = (): void => {
    // 先清空，否则连续导入同一个文件不会触发 change
    this.blueprintInput.value = '';
    this.blueprintInput.click();
  };

  private readonly handleBlueprintChange = (): void => {
    const file = this.blueprintInput.files?.[0];
    if (!file) return;
    this.handlers.onImportBlueprint(file);
  };

  private readonly handleGroupListClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const chip = target.closest<HTMLElement>('[data-group-id]');
    if (!chip) return;
    const groupId = chip.dataset.groupId;
    if (!groupId) return;

    if (target.closest('[data-delete]')) {
      if (this.selectedGroupId === groupId) this.selectedGroupId = null;
      this.syncGroupButtons();
      this.handlers.onDeleteGroup(groupId);
      return;
    }

    this.selectedGroupId = groupId;
    this.handlers.onSelectGroup(groupId);
  };

  private readonly handlePrefabListClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>('[data-prefab-id]');
    if (!card) return;
    const prefabId = card.dataset.prefabId;
    if (!prefabId) return;

    if (target.closest('[data-delete]')) {
      if (this.selectedPrefabId === prefabId) this.selectedPrefabId = null;
      this.handlers.onDeletePrefab(prefabId);
      this.markPrefabSelection();
      this.syncPrefabButtons();
      return;
    }

    // 点卡片只负责"选中"，真正放置由 #btn-prefab-place 触发
    this.selectedPrefabId = prefabId;
    this.markPrefabSelection();
    this.syncPrefabButtons();
  };

  /** 每帧调用（内部按 200ms 节流） */
  update(stats: PrefabPanelStats): void {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastRefresh < 200) return;
    this.lastRefresh = now;
    this.refresh(stats);
  }

  /** 立即刷新一次（外部增删了组/预制件后调用） */
  syncAll(stats: PrefabPanelStats): void {
    if (this.disposed) return;
    this.lastRefresh = 0;
    this.refresh(stats);
  }

  /** 组名输入框的当前值（引擎建组时取它，可空） */
  getGroupName(): string {
    return this.groupNameInput.value.trim();
  }

  /** 清空组名输入框（建组成功后调用） */
  clearGroupName(): void {
    this.groupNameInput.value = '';
  }

  private refresh(stats: PrefabPanelStats): void {
    // 引擎回传的选中组优先；它为空时保留面板里点选的，
    // 否则"点 chip 选中 → 点「选中组」"之间会被一次刷新抹掉
    const engineGroupId = stats.selectedGroupId;
    if (engineGroupId !== null && stats.groups.some((item) => item.id === engineGroupId)) {
      this.selectedGroupId = engineGroupId;
    } else if (
      this.selectedGroupId !== null &&
      !stats.groups.some((item) => item.id === this.selectedGroupId)
    ) {
      this.selectedGroupId = null;
    }

    if (
      this.selectedPrefabId !== null &&
      !stats.prefabs.some((item) => item.id === this.selectedPrefabId)
    ) {
      this.selectedPrefabId = null;
    }

    this.renderGroups(stats.groups);
    this.renderPrefabs(stats.prefabs);

    this.createGroupButton.disabled = stats.selectedCount < 2;
    this.savePrefabButton.disabled = stats.selectedCount < 1;
    this.exportButton.disabled = stats.selectedCount < 1;
    this.syncGroupButtons();
    this.syncPrefabButtons();

    this.blueprintStatus.textContent = stats.blueprintStatus;
  }

  private syncGroupButtons(): void {
    const none = this.selectedGroupId === null;
    this.ungroupButton.disabled = none;
    this.selectGroupButton.disabled = none;
  }

  private syncPrefabButtons(): void {
    const none = this.selectedPrefabId === null;
    this.placePrefabButton.disabled = none;
    this.deletePrefabButton.disabled = none;
  }

  private renderGroups(groups: GroupSummary[]): void {
    this.groupList.innerHTML = '';
    if (groups.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没建组，选中若干物体后点「成组」';
      this.groupList.appendChild(empty);
      return;
    }

    for (const group of groups) {
      const chip = document.createElement('li');
      chip.className = 'chip';
      chip.dataset.groupId = group.id;
      chip.classList.toggle('active', group.id === this.selectedGroupId);
      chip.innerHTML =
        `<b>${escapeHtml(group.name)}</b>` +
        `<small>${group.objectCount} 个物体</small>` +
        `<button type="button" data-delete="1" title="解散组">✕</button>`;
      this.groupList.appendChild(chip);
    }
  }

  private renderPrefabs(prefabs: PrefabSummary[]): void {
    this.prefabList.innerHTML = '';
    if (prefabs.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没有预制件，选中物体后点「保存选中」';
      this.prefabList.appendChild(empty);
      return;
    }

    for (const prefab of prefabs) {
      const card = document.createElement('li');
      card.className = 'prefab-card';
      card.dataset.prefabId = prefab.id;
      card.classList.toggle('active', prefab.id === this.selectedPrefabId);
      const created = new Date(prefab.createdAt).toLocaleDateString('zh-CN');
      card.innerHTML =
        `<img src="${escapeHtml(prefab.thumbnail)}" alt="">` +
        `<span class="meta"><b>${escapeHtml(prefab.name)}</b>` +
        `<small>${prefab.objectCount} 个物体 · ${created}</small></span>` +
        `<button type="button" data-delete="1" title="删除预制件">✕</button>`;
      this.prefabList.appendChild(card);
    }
  }

  private markPrefabSelection(): void {
    for (const card of this.prefabList.querySelectorAll<HTMLElement>('.prefab-card')) {
      card.classList.toggle('active', card.dataset.prefabId === this.selectedPrefabId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.createGroupButton.removeEventListener('click', this.handleCreateGroupClick);
    this.ungroupButton.removeEventListener('click', this.handleUngroupClick);
    this.selectGroupButton.removeEventListener('click', this.handleSelectGroupClick);
    this.savePrefabButton.removeEventListener('click', this.handleSavePrefabClick);
    this.placePrefabButton.removeEventListener('click', this.handlePlacePrefabClick);
    this.deletePrefabButton.removeEventListener('click', this.handleDeletePrefabClick);
    this.exportButton.removeEventListener('click', this.handleExportClick);
    this.importButton.removeEventListener('click', this.handleImportClick);
    this.blueprintInput.removeEventListener('change', this.handleBlueprintChange);
    this.groupList.removeEventListener('click', this.handleGroupListClick);
    this.prefabList.removeEventListener('click', this.handlePrefabListClick);
  }
}
