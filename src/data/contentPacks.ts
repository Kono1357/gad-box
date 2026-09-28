/**
 * 内容包系统（M4 补充 1）。
 *
 * ────────────────────────────────────────────────────────────
 * 它解决的是什么问题
 * ────────────────────────────────────────────────────────────
 * 物品库扩到 300+ 之后，物品面板一次列出全部会变成"翻不到东西"：
 * 玩家的实际用法是"我要盖房子"，而他要的是结构与门窗，不是传送门和摩天轮。
 * 内容包就是**按用途切分**这一堆内容，让面板一次只显示相关的那些。
 *
 * ────────────────────────────────────────────────────────────
 * 内容包按**一级分类**划分，而不是另立一套标签
 * ────────────────────────────────────────────────────────────
 * 理由：分类已经存在、已经被存档与断言引用、也已经覆盖了全部物品。
 * 再建一套平行体系（"包"与"分类"各说各话）必然出现"某个物品属于哪个包"说不清的情况。
 * 所以每个包就是**一组一级分类**，`packOf(def)` 由分类直接推出，不可能有歧义。
 *
 * ────────────────────────────────────────────────────────────
 * 关闭一个包之后，已放置的物品会怎样？
 * ────────────────────────────────────────────────────────────
 * **什么都不发生。** 包只影响"面板里能不能选到它"，不影响世界里已经存在的东西 ——
 * 关掉"奇幻包"不会让已经摆好的传送门消失，也不会让它失效。
 * 这条必须写清楚：如果关包会删东西，玩家是不可能敢点那个开关的。
 * 载入存档时引用了被禁用包的物品也**照常显示**（它们已经在世界里了），
 * 只是不能再新建。
 */

import type { BuildingDef } from '../building/types';

export type ContentPackId = 'base' | 'furniture' | 'vehicle' | 'magic' | 'machinery';

export interface ContentPack {
  id: ContentPackId;
  name: string;
  emoji: string;
  description: string;
  /** 这个包包含哪些一级分类 */
  categories: readonly string[];
  /** 默认是否启用。基础包必须默认开，否则玩家开局什么都没有 */
  defaultEnabled: boolean;
}

/**
 * 5 个内容包。
 *
 * 「基础包」刻意包含结构 + 门窗 + 厨卫 + 小物品 + 装饰 + 植物 ——
 * 也就是说**默认状态就是"能正常盖房子过日子"**，而载具/机械/奇幻是可选的花样。
 * 默认开全部也不是不行，但那会让新手第一次打开面板就看到 300 个物品。
 */
export const CONTENT_PACKS: readonly ContentPack[] = [
  {
    id: 'base',
    name: '基础包',
    emoji: '🧱',
    description: '结构、门窗、厨卫、装饰、小物品、植物 —— 盖房子与布置房间需要的全部内容',
    categories: ['结构', '门窗', '厨卫', '装饰', '小物品', '植物'],
    defaultEnabled: true,
  },
  {
    id: 'furniture',
    name: '家具包',
    emoji: '🛋️',
    description: '桌椅床柜沙发等室内陈设',
    categories: ['家具', '电器'],
    defaultEnabled: true,
  },
  {
    id: 'vehicle',
    name: '载具包',
    emoji: '🚗',
    description: '汽车、卡车、船、火车与道路设施',
    categories: ['交通'],
    defaultEnabled: false,
  },
  {
    id: 'machinery',
    name: '机械包',
    emoji: '⚙️',
    description: '齿轮、传送带、工程机械、流体与动力设备',
    categories: ['机械'],
    defaultEnabled: false,
  },
  {
    id: 'magic',
    name: '奇幻包',
    emoji: '✨',
    description: '传送门、水晶、浮空石、生成器与销毁器',
    categories: ['奇幻'],
    defaultEnabled: false,
  },
] as const;

export const CONTENT_PACK_STORAGE_KEY = 'god-sandbox-content-packs-v1';

/** 分类 → 包的反查表（模块加载时建一次） */
const PACK_BY_CATEGORY = new Map<string, ContentPack>();
for (const pack of CONTENT_PACKS) {
  for (const category of pack.categories) PACK_BY_CATEGORY.set(category, pack);
}

/** 某个分类属于哪个包；未知分类归到基础包（**不能返回 undefined**，否则面板会漏掉物品） */
export function packOfCategory(category: string): ContentPack {
  return PACK_BY_CATEGORY.get(category) ?? CONTENT_PACKS[0]!;
}

/**
 * 某个物品属于哪些包。
 *
 * 返回数组是因为将来可能出现"一个物品属于多个包"（例如"折叠椅"既是家具也是载具配件）。
 * 现在每个物品只属于一个包，但接口留成数组，免得以后要改所有调用点。
 */
export function packsOf(def: BuildingDef): ContentPack[] {
  return [packOfCategory(def.category)];
}

/** 默认启用状态 */
export function defaultEnabledPacks(): Set<ContentPackId> {
  return new Set(CONTENT_PACKS.filter((pack) => pack.defaultEnabled).map((pack) => pack.id));
}

/**
 * 从 localStorage 读启用状态。
 *
 * 宽容处理：读不到、JSON 坏了、存的是未知包 id、存的不是数组 —— 一律回到默认值，
 * **绝不抛异常**。这条规矩项目里已经统一（见 `physicsSandboxMode`），因为
 * "设置读坏了导致整个应用起不来"是最没必要的一类故障。
 */
export function loadEnabledPacks(): Set<ContentPackId> {
  const fallback = defaultEnabledPacks();
  try {
    // 守卫要放在 try **里面**：禁用站点数据时，读 localStorage 这个属性本身就会抛
    // SecurityError，`typeof` 只吞"未声明"、吞不掉 getter 的异常（兼容性审计 R1）
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(CONTENT_PACK_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = new Set(CONTENT_PACKS.map((pack) => pack.id));
    const enabled = parsed.filter((id): id is ContentPackId => typeof id === 'string' && valid.has(id as ContentPackId));
    // 存了空数组是合法状态（玩家关掉了所有包）—— 但那样面板就是空的，
    // 所以这里不把"空"当成"没存过"，而是如实返回空并让面板显示"所有内容包都关了"
    return new Set(enabled);
  } catch {
    return fallback;
  }
}

export function saveEnabledPacks(enabled: ReadonlySet<ContentPackId>): boolean {
  try {
    // 同 loadEnabledPacks：守卫要在 try 里面（R1）
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(CONTENT_PACK_STORAGE_KEY, JSON.stringify([...enabled]));
    return true;
  } catch {
    // 隐私模式 / 配额满：如实返回 false，调用方可以选择提示玩家
    return false;
  }
}

/**
 * 按启用状态过滤物品。
 *
 * `keepIds` 是"必须保留的物品"（存档里已经在用的、以及玩家收藏的）——
 * 关掉一个包不该让玩家手里的东西从面板上消失，否则他连"这是什么"都查不到。
 */
export function filterByPacks(
  catalog: readonly BuildingDef[],
  enabled: ReadonlySet<ContentPackId>,
  keepIds: ReadonlySet<string> = new Set(),
): BuildingDef[] {
  return catalog.filter((def) => {
    if (keepIds.has(def.id)) return true;
    return packsOf(def).some((pack) => enabled.has(pack.id));
  });
}

/** 每个包各有多少物品（面板上显示"基础包 191 项"） */
export function packCounts(catalog: readonly BuildingDef[]): Record<ContentPackId, number> {
  const counts = { base: 0, furniture: 0, vehicle: 0, magic: 0, machinery: 0 } as Record<ContentPackId, number>;
  for (const def of catalog) counts[packOfCategory(def.category).id] += 1;
  return counts;
}

/** 面板用：一行中文摘要 */
export function describePacks(enabled: ReadonlySet<ContentPackId>, catalog: readonly BuildingDef[]): string {
  const counts = packCounts(catalog);
  const visible = filterByPacks(catalog, enabled).length;
  const off = CONTENT_PACKS.filter((pack) => !enabled.has(pack.id));
  return (
    `内容包：${CONTENT_PACKS.length - off.length}/${CONTENT_PACKS.length} 个启用｜` +
    `可选物品 ${visible} / ${catalog.length}` +
    (off.length > 0 ? `｜已关闭：${off.map((pack) => pack.name).join('、')}` : '') +
    `｜（关闭的包：${CONTENT_PACKS.map((pack) => `${pack.name} ${counts[pack.id]}`).join('，')}）`
  );
}
