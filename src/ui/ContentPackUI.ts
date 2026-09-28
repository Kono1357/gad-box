/**
 * 内容包面板（M4 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它与 `CatalogPanel` 里的那组开关是什么关系
 * ────────────────────────────────────────────────────────────
 * `CatalogPanel` 在 `#catalog-packs` 里已经有一份很简短的开关（一行一个），
 * 那是给"正在翻物品、顺手关掉一个包"用的。这个面板是**详情版**：
 * 每个包显示图标、包含哪些一级分类、本包共多少项、**开启之后目录里会多出多少物品** ——
 * 玩家在决定"要不要为了一次搭建打开机械包"时需要的就是最后那个数字。
 *
 * 两边写的是**同一个 localStorage 键**（`CONTENT_PACK_STORAGE_KEY`），所以：
 * `refresh()` 每次都重新 `loadEnabledPacks()`，**绝不缓存状态**。
 * 缓存的话，玩家在物品面板里关掉交通包、再切到这个面板，会看到交通包还开着 ——
 * 那种"两个界面说的不一样"的 bug 查起来最费时间。
 *
 * ────────────────────────────────────────────────────────────
 * 关掉一个包不会删任何东西（这条必须写在界面上）
 * ────────────────────────────────────────────────────────────
 * `contentPacks.ts` 的文件头把语义定得很死：包只影响"面板里能不能选到"。
 * 但玩家看不见代码，他只会担心"我关掉奇幻包，已经摆好的传送门会不会消失"。
 * 所以这句话以**一行小字**的形式直接写进面板，而不是藏在文档里。
 *
 * ────────────────────────────────────────────────────────────
 * 一个口径上的小差异（如实写明）
 * ────────────────────────────────────────────────────────────
 * 这里的"会多出多少个"用 `filterByPacks` 前后各算一次得到，**不传 `keepIds`** ——
 * 也就是不算 Engine 手里那份"收藏 / 存档已用"的保留名单。后果是：
 * 如果玩家收藏了交通包里的船，引擎实际过滤会连船一起保留，而这里显示的数量会少 1。
 * 这是刻意的：面板不该猜 Engine 的保留名单（猜了就会出现"面板说的和面板实际给的不一样"），
 * 所以数字是**面板视角**的数量，注释里说清这一点。
 */

import { BUILDING_CATALOG } from '../data/buildingCatalog';
import {
  CONTENT_PACKS,
  defaultEnabledPacks,
  describePacks,
  filterByPacks,
  loadEnabledPacks,
  packCounts,
  saveEnabledPacks,
  type ContentPackId,
} from '../data/contentPacks';

export interface ContentPackUIHandlers {
  /** 启用状态变化（Engine 需要重新过滤物品面板）。用 Set<string> 而不是 ContentPackId，避免调用方再 import 一次类型 */
  onPacksChange(enabled: ReadonlySet<string>): void;
}

/** 关包的语义说明：这句话是玩家敢不敢碰这个开关的前提 */
const SEMANTICS_NOTE =
  '关掉一个内容包只会把它从物品面板里隐藏起来 —— 世界里已经放好的物体不会被删除，也不会失效。';

/** 全部启用 / 恢复默认 / 全部关闭三个批量动作 */
type BulkAction = 'all' | 'default' | 'none';
const BULK_LABELS: readonly { action: BulkAction; label: string; title: string }[] = [
  { action: 'all', label: '全部启用', title: '把 5 个内容包全部打开（目录里 300+ 项一次全列出来）' },
  { action: 'default', label: '恢复默认', title: '回到初始状态：只开基础包与家具包' },
  { action: 'none', label: '全部关闭', title: '全部关掉。物品面板会变空，但世界里的东西不受影响' },
];

export class ContentPackUI {
  private readonly container: HTMLElement | null;
  private readonly handlers: ContentPackUIHandlers;
  private readonly listeners: { target: EventTarget; type: string; handler: EventListener }[] = [];
  /** 当前启用状态：唯一来源是 `loadEnabledPacks()`，这里只是最近一次读到的结果 */
  private enabled: Set<ContentPackId> = defaultEnabledPacks();
  /** 上一次 `saveEnabledPacks` 是否成功（隐私模式会失败），失败时面板要如实说明 */
  private saveOk = true;
  private disposed = false;

  constructor(container: HTMLElement | null, handlers: ContentPackUIHandlers) {
    this.container = container;
    this.handlers = handlers;

    // container 允许为 null：HTML 片段还没接上时不该抛异常（构造点会在接之前就跑起来）
    if (container) {
      this.on(container, 'change', (ev) => this.onChange(ev));
      this.on(container, 'click', (ev) => this.onClick(ev));
    }
    this.refresh();
  }

  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push({ target, type, handler });
  }

  /**
   * 重新从 localStorage 读状态并整块重画。
   *
   * 整块重画（而不是逐个更新）是刻意的：一共 5 个包 + 3 个按钮，重建的节点不到 30 个，
   * 而"逐个更新"要维护"哪个 DOM 对应哪个包"的映射，是这类面板最常见的不同步来源。
   */
  refresh(): void {
    if (this.disposed) return;
    this.enabled = loadEnabledPacks();
    const container = this.container;
    if (!container) return;

    const counts = packCounts(BUILDING_CATALOG);
    const visibleNow = filterByPacks(BUILDING_CATALOG, this.enabled).length;

    container.textContent = '';

    for (const pack of CONTENT_PACKS) {
      const on = this.enabled.has(pack.id);
      // 「开启后会多出多少」= 真实过滤函数前后各算一次。
      // 不用 counts[pack.id] 顶替：`packsOf` 返回的是数组（将来一物可属多包），
      // 那时"本包总数"就不等于"新多出来的数量"了 —— 用真实函数算，将来也不会错。
      const withPack = new Set<ContentPackId>(this.enabled);
      withPack.add(pack.id);
      const delta = filterByPacks(BUILDING_CATALOG, withPack).length - visibleNow;

      const row = document.createElement('div');
      row.className = 'pack-row';

      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.packId = pack.id;
      input.checked = on;
      label.appendChild(input);

      const title = document.createElement('span');
      title.textContent = `${pack.emoji} ${pack.name}`;
      label.appendChild(title);

      const count = document.createElement('span');
      count.style.opacity = '0.62';
      count.style.marginLeft = 'auto';
      count.textContent = `${counts[pack.id]} 项`;
      label.appendChild(count);
      row.appendChild(label);

      const detail = document.createElement('div');
      detail.style.opacity = '0.62';
      detail.style.fontSize = '11px';
      detail.textContent =
        `分类：${pack.categories.join('、')}｜本包 ${counts[pack.id]} 项｜` +
        (on ? `已启用（开启后不会再变多）` : `开启后目录里会多出 ${delta} 个物品`);
      row.appendChild(detail);

      const desc = document.createElement('div');
      desc.style.opacity = '0.45';
      desc.style.fontSize = '11px';
      desc.textContent = pack.description;
      row.appendChild(desc);

      container.appendChild(row);
    }

    const summary = document.createElement('p');
    summary.className = 'inline-label dim';
    // 摘要直接用 contentPacks.ts 的那一句，面板不再自己拼一份数字 —— 两份数字必然有一天不一致
    summary.textContent = describePacks(this.enabled, BUILDING_CATALOG);
    container.appendChild(summary);

    const buttons = document.createElement('div');
    buttons.className = 'row-buttons';
    for (const { action, label, title } of BULK_LABELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.packAction = action;
      button.title = title;
      button.textContent = label;
      buttons.appendChild(button);
    }
    container.appendChild(buttons);

    const note = document.createElement('p');
    note.className = 'inline-label dim';
    note.textContent = SEMANTICS_NOTE;
    container.appendChild(note);

    if (!this.saveOk) {
      // 存不下来时必须说：玩家会以为"我这次关了，下次打开还是关的"
      const warn = document.createElement('p');
      warn.className = 'inline-label';
      warn.style.color = '#ff8a6b';
      warn.textContent = '⚠ 无法写入本地存储（可能是隐私模式或配额已满）：这次改动只在本次会话里有效。';
      container.appendChild(warn);
    }
  }

  /** 复选框变化：只认已知的包 id（DOM 被改过 / 旧版页面残留的开关不该能写进状态） */
  private onChange(ev: Event): void {
    const input = ev.target as HTMLInputElement | null;
    if (!input || input.type !== 'checkbox') return;
    const packId = input.dataset.packId;
    if (!packId) return;
    if (!CONTENT_PACKS.some((pack) => pack.id === packId)) return;

    const next = new Set(this.enabled);
    if (input.checked) next.add(packId as ContentPackId);
    else next.delete(packId as ContentPackId);
    this.apply(next);
  }

  private onClick(ev: Event): void {
    const button = (ev.target as HTMLElement | null)?.closest('button');
    const action = button?.dataset.packAction;
    if (action !== 'all' && action !== 'default' && action !== 'none') return;

    if (action === 'all') this.apply(new Set(CONTENT_PACKS.map((pack) => pack.id)));
    else if (action === 'default') this.apply(defaultEnabledPacks());
    else this.apply(new Set<ContentPackId>());
  }

  /**
   * 落盘 → 重画 → 通知 Engine。
   *
   * 顺序不能反：`onPacksChange` 里 Engine 会去读一遍 localStorage 再刷新物品面板，
   * 先通知后保存的话，Engine 读到的还是上一次的状态（表现是"要开关两次才生效"）。
   */
  private apply(next: Set<ContentPackId>): void {
    if (this.disposed) return;
    this.enabled = next;
    this.saveOk = saveEnabledPacks(next);
    this.refresh();
    this.handlers.onPacksChange(new Set<string>(next));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, type, handler } of this.listeners) target.removeEventListener(type, handler);
    this.listeners.length = 0;
    if (this.container) this.container.textContent = '';
  }
}
