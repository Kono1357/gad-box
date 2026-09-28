/**
 * 内容使用统计（M4 第 7 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 它回答什么问题
 * ────────────────────────────────────────────────────────────
 * 物品库涨到 300+ 之后，"我到底用了多少内容"变成了一个看得见的问题：
 * 玩家摆了 800 个物体，其中 600 个是"石墙"—— 那说明内容包开了一堆但没用上，
 * 而热力图能立刻指出"东西全挤在西南角"。
 * 所以这份统计只做三件事：**用了几种、各用了多少、堆在哪里**。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么是纯逻辑（不 import 任何 Three.js / DOM）
 * ────────────────────────────────────────────────────────────
 * 这个文件要能在 Node 里被断言直接跑（`scripts/checks/contentstats.check.ts`），
 * 所以它只依赖 `buildingCatalog` 这份纯数据。绘制热力图是 `ui/ContentStatsUI.ts` 的事：
 * 统计与显示分开之后，"数字算错了"和"画错了"是两个能单独定位的问题。
 *
 * ────────────────────────────────────────────────────────────
 * 口径（哪里准、哪里不准，全部写在这里）
 * ────────────────────────────────────────────────────────────
 * 1. **coverage 只算 `isPlaceable !== false` 的模型**：目录里有极少数"不可放置"的
 *    内部模型（它们只作为部件/生成物出现），把它们算进分母会让覆盖率永远到不了 100%，
 *    而玩家根本没有任何办法去"用"它们 —— 那个数字会变成一句永远无法达成的指责。
 * 2. **categories 的 ratio 是"占世界里全部物体的比例"，不是"占目录里该分类的比例"**。
 *    两种算法都说得通，混用才是灾难，所以这里定死一种并写在字段注释里。
 * 3. **物体坐标超出世界范围时被夹进最近的边界格，不丢弃**。
 *    丢弃会让 `sum(bins[i].count) === totalObjects` 这个不变量失效，而它是分箱统计
 *    唯一的自检手段。代价是边界格会偏热 —— 这条取舍如实写在 `binIndexOf` 上。
 * 4. **查不到模型的物体仍然计入 `totalObjects` 与分箱**（旧版本存档会出现），
 *    只是没有分类可归，所以 `categories` 的合计可能小于 `totalObjects`。
 *    差额等于 `unknownIds` 里的物体数，这是如实反映，不硬塞一个"未知"分类。
 * 5. **`minY` / `maxY` 当前不参与计算**。俯视分箱只需要 X / Z；留这两个字段是为了
 *    调用方能原样把自己的世界尺寸对象传进来，而不是"这里漏读了高度"。
 *
 * ────────────────────────────────────────────────────────────
 * 坐标系：默认按 [0, sizeX) 解释，Engine 的世界要传 origin
 * ────────────────────────────────────────────────────────────
 * `WorldBoundsLike` 只给尺寸时，分箱按 `x ∈ [0, sizeX)`、`z ∈ [0, sizeZ)` 切格。
 * 但 **Engine 的世界是"以原点为中心"的**（`World.originX = -sizeX / 2`，物体的
 * `position` 也在 ±sizeX/2 之间），所以接线时必须把 `originX` / `originZ` 一起传进来
 * （见文件末尾的用法注释）。不传的话所有负坐标会被夹进第 0 列 —— 热力图会左半边全热，
 * 那种图比没有图更糟。
 */

import { BUILDING_CATALOG } from './buildingCatalog';
import type { BuildingDef } from '../building/types';

/** 世界里一个已放置物体的最小信息（`BuildingInstance` 结构上满足它） */
export interface PlacedObjectLike {
  defId: string;
  position: readonly [number, number, number];
}

/**
 * 世界范围（米）。
 *
 * `originX` / `originZ` 是可选的：不填按 0 处理，也就是坐标本身就是 `0 .. sizeX`。
 * 之所以允许额外的这两个字段，而不是要求调用方自己平移坐标 ——
 * 平移是"每调用一次都可能写错一次"的一行代码，放在这里做一次更安全。
 */
export interface WorldBoundsLike {
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly minY?: number;
  readonly maxY?: number;
  /** 分箱原点 X（世界坐标，通常传 -sizeX / 2）。不填按 0 */
  readonly originX?: number;
  /** 分箱原点 Z（世界坐标，通常传 -sizeZ / 2）。不填按 0 */
  readonly originZ?: number;
}

export interface CategoryCount {
  /** 一级分类名（`subcategories` 里这一项是「一级 · 二级」的复合名，见下） */
  category: string;
  /** 世界里属于它的物体数 */
  count: number;
  /** 目录里属于它的模型数 */
  catalogCount: number;
  /** `count / totalObjects`；世界是空的时候为 0（不是 NaN） */
  ratio: number;
}

/** 俯视网格里的一个格子。坐标是**世界坐标**（含 origin），不是格子序号 */
export interface SpatialBin {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  count: number;
}

export interface ContentStats {
  totalObjects: number;
  /** 目录里可放置的物品总数 */
  totalCatalog: number;
  /** 世界里出现过至少一次的**可放置**模型数（与 `coverage` 同口径，见文件头第 1 条） */
  usedCatalogIds: number;
  /** `usedCatalogIds / totalCatalog`（只按可放置口径，见文件头第 1 条） */
  coverage: number;
  /** 世界用到的分类，按数量降序 */
  categories: CategoryCount[];
  /** 世界用到的二级分类，按数量降序 */
  subcategories: CategoryCount[];
  /** 俯视网格分箱；行主序（row 0 = z 最小端），**含 0 个物体的空箱** */
  bins: SpatialBin[];
  /** 分箱列数；**0 表示这次没有分箱**（与 `bins` 为空一致） */
  binCols: number;
  binRows: number;
  /** 最大的箱子有几个物体；0 表示所有箱子都是空的 */
  maxBinCount: number;
  /** 出现最多的前 N 个（默认 10），按数量降序 */
  top: { defId: string; name: string; count: number }[];
  /** 目录里有、世界里一个都没放的分类 */
  unusedCategories: string[];
  /** 世界里放了但目录里查不到的 defId（旧版本存档会出现）。如实报出，不静默丢弃 */
  unknownIds: string[];
  /** 统计不出来时为 null。例如世界尺寸未知时无法分箱 */
  binsUnavailableReason: string | null;
}

/** 默认 8×8：手机上一格 ≈ 24px，既看得清密集区又不至于每格都空着 */
const DEFAULT_COLS = 8;
const DEFAULT_ROWS = 8;
const DEFAULT_TOP_N = 10;

/**
 * 单边格子数上限。
 * 这不是口径问题而是防呆：`cols = 1e9` 会在分配 bins 数组时直接把页面卡死，
 * 而调用方拿到的是"浏览器崩了"这种毫无线索的现场。夹到 512（= 26 万个箱子）足够任何用途。
 */
const MAX_BINS_DIM = 512;

/** 目录查不到模型时 `top` 里显示的占位名。**不编造名字**，只说查不到 */
const UNKNOWN_NAME = '（目录里查不到这个模型）';

/**
 * 目录索引：id → 模型、分类 → 目录条数、二级分类 → 目录条数。
 *
 * 建一次就缓存：`computeContentStats` 可能被每帧调用，而目录是模块级常量、不会变。
 * 这个 Map 就是"单趟 O(n)"的关键 —— 有了它，统计时**不需要**对每个物体去
 * `BUILDING_CATALOG.find()`（那是 O(n·m)，800 个物体 × 387 个模型 ≈ 31 万次比较/帧）。
 * 懒建而不是模块加载时建：没人打开统计面板就不该付这份钱。
 */
interface CatalogIndex {
  byId: Map<string, BuildingDef>;
  /** 可放置物品数（coverage 的分母） */
  placeableTotal: number;
  categoryCatalog: Map<string, number>;
  subcategoryCatalog: Map<string, number>;
  /** 目录里出现过的一级分类，按目录声明顺序 —— 这个顺序是"最常用的先出现"，比字母序有用 */
  categoryOrder: string[];
}

let indexCache: CatalogIndex | null = null;

function catalogIndex(): CatalogIndex {
  if (indexCache) return indexCache;
  const byId = new Map<string, BuildingDef>();
  const categoryCatalog = new Map<string, number>();
  const subcategoryCatalog = new Map<string, number>();
  const categoryOrder: string[] = [];
  let placeableTotal = 0;

  for (const def of BUILDING_CATALOG) {
    byId.set(def.id, def);
    // 用 `!== false` 而不是 `=== true`：M1.5 时代的 77 个物品字段齐全，
    // 但将来的程序化模型可能省略这个字段，省略时按"可放置"处理（与 BuildingDef 的注释一致）
    if (def.isPlaceable !== false) placeableTotal += 1;
    if (!categoryCatalog.has(def.category)) categoryOrder.push(def.category);
    categoryCatalog.set(def.category, (categoryCatalog.get(def.category) ?? 0) + 1);
    if (def.subcategory) {
      const key = subcategoryKey(def.category, def.subcategory);
      subcategoryCatalog.set(key, (subcategoryCatalog.get(key) ?? 0) + 1);
    }
  }

  indexCache = { byId, placeableTotal, categoryCatalog, subcategoryCatalog, categoryOrder };
  return indexCache;
}

/**
 * 二级分类的键：`一级 · 二级`。
 *
 * 为什么带上一级分类 —— 「门」在"门窗"里有、「柜门」在"家具"里可能也叫"门"，
 * 只按二级名合并会把两个互不相干的组并成一行，数字看着没问题、含义是错的。
 * 复合名在面板上一眼能看出层级，代价只是长一点。
 */
function subcategoryKey(category: string, subcategory: string): string {
  return `${category} · ${subcategory}`;
}

/**
 * 正整数化：非法值一律回落到默认（宁可给一张 8×8 的图，也不要 NaN 尺寸的图）。
 *
 * ⚠ 必须**先取整再判大小**：`cols = 0.5` 取整后是 0，而 0 会让 `sizeX / cols` 变成
 * Infinity、格子宽度全变 NaN。先判 `value < 1` 是拦不住 0.5 的。
 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  return Math.min(MAX_BINS_DIM, floored);
}

/** 尺寸能不能用来分箱（0 / 负数 / NaN / Infinity 都不行） */
function usableSize(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

/**
 * 某个坐标落在第几格（0 .. cells-1）。
 *
 * 三种越界处理，取舍写在下面：
 * - `NaN` / `Infinity`（存档坏掉或物体没初始化）→ 放进第 0 格；
 * - 小于原点 → 第 0 格；大于等于原点 + 尺寸（**包括正好等于 sizeX**）→ 最后一格；
 * - 其余按 `floor((value - origin) / size * cells)`。
 *
 * 为什么夹住而不是丢弃：丢弃会让 `sum(bins) === totalObjects` 失效，
 * 而那正是分箱唯一能自检的地方。**代价如实说**：越界物体落在边界格上，
 * 会让那张格子比实际更热。正常世界里没有越界物体，所以这是"坏数据时不骗人"的兜底。
 *
 * 边界语义（正好 `x = sizeX`）：属于**最后一格**，不会溢出成 cells（下一格）。
 * 这与坐标区间是左闭右开 `[origin, origin+size)` 一致。
 */
function binIndexOf(value: number, origin: number, size: number, cells: number): number {
  if (!Number.isFinite(value)) return 0;
  const ratio = (value - origin) / size;
  if (!Number.isFinite(ratio)) return 0;
  const cell = Math.floor(ratio * cells);
  if (cell < 0) return 0;
  if (cell >= cells) return cells - 1;
  return cell;
}

/** 降序排：数量相同按名字排，保证同样的输入永远得到同样的输出（断言与截图对比都靠这个） */
function byCountDesc(a: CategoryCount, b: CategoryCount): number {
  return b.count - a.count || a.category.localeCompare(b.category, 'zh');
}

/**
 * 统计世界里的内容使用情况。
 *
 * 复杂度：对物体是**一趟 O(n)**（查 Map、加计数、落格子），
 * 只在最后对"出现过的分类/二级分类"（数量级是十几个）做排序。
 * 不在这里做节流 —— 调用频率由 UI 决定（见 `ContentStatsUI`），纯函数保持可断言的简单语义。
 */
export function computeContentStats(
  objects: readonly PlacedObjectLike[],
  bounds: WorldBoundsLike,
  opts?: { cols?: number; rows?: number; topN?: number },
): ContentStats {
  const index = catalogIndex();
  const cols = positiveInt(opts?.cols, DEFAULT_COLS);
  const rows = positiveInt(opts?.rows, DEFAULT_ROWS);
  const topN = positiveInt(opts?.topN, DEFAULT_TOP_N);

  const canBin = usableSize(bounds.sizeX) && usableSize(bounds.sizeZ);
  const originX = Number.isFinite(bounds.originX) ? (bounds.originX as number) : 0;
  const originZ = Number.isFinite(bounds.originZ) ? (bounds.originZ as number) : 0;

  // 分箱只在尺寸可用时才建；不然"一层假箱子"比空数组更容易骗人（见 binsUnavailableReason）
  const bins: SpatialBin[] = [];
  let binCols = 0;
  let binRows = 0;
  let cellW = 0;
  let cellD = 0;
  if (canBin) {
    binCols = cols;
    binRows = rows;
    cellW = bounds.sizeX / cols;
    cellD = bounds.sizeZ / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        bins.push({
          x0: originX + col * cellW,
          z0: originZ + row * cellD,
          x1: originX + (col + 1) * cellW,
          z1: originZ + (row + 1) * cellD,
          count: 0,
        });
      }
    }
  }

  const defCounts = new Map<string, number>();
  const unknownIds: string[] = [];
  const unknownSeen = new Set<string>();
  const usedIds = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const subcategoryCounts = new Map<string, number>();
  let totalObjects = 0;
  let maxBinCount = 0;

  // ---------------- 单趟主循环：这里不许出现任何按 defId 的线性查找 ----------------
  for (const object of objects) {
    totalObjects += 1;
    const defId = object.defId;
    defCounts.set(defId, (defCounts.get(defId) ?? 0) + 1);

    const def = index.byId.get(defId);
    if (def === undefined) {
      // 旧版本存档：这里**不丢**、也不编一个分类，只记下 id 让面板原样报出来
      if (!unknownSeen.has(defId)) {
        unknownSeen.add(defId);
        unknownIds.push(defId);
      }
    } else {
      // usedCatalogIds 与 coverage 同口径（只数可放置的）：混用会让"覆盖了 105%"这种
      // 荒谬数字出现，而它一眼看不出错在哪
      if (def.isPlaceable !== false) usedIds.add(def.id);
      categoryCounts.set(def.category, (categoryCounts.get(def.category) ?? 0) + 1);
      if (def.subcategory) {
        const key = subcategoryKey(def.category, def.subcategory);
        subcategoryCounts.set(key, (subcategoryCounts.get(key) ?? 0) + 1);
      }
    }

    if (canBin) {
      const col = binIndexOf(object.position[0], originX, bounds.sizeX, cols);
      const row = binIndexOf(object.position[2], originZ, bounds.sizeZ, rows);
      const bin = bins[row * cols + col];
      // bins 按上面的双重循环建满，索引必然有效；这里只是让 TS 的 noUncheckedIndexedAccess 语义明确
      if (bin) {
        bin.count += 1;
        if (bin.count > maxBinCount) maxBinCount = bin.count;
      }
    }
  }

  // ---------------- 汇总 ----------------
  const ratioOf = (count: number): number => (totalObjects > 0 ? count / totalObjects : 0);

  const categories: CategoryCount[] = [];
  for (const [category, count] of categoryCounts) {
    categories.push({
      category,
      count,
      catalogCount: index.categoryCatalog.get(category) ?? 0,
      ratio: ratioOf(count),
    });
  }
  categories.sort(byCountDesc);

  const subcategories: CategoryCount[] = [];
  for (const [category, count] of subcategoryCounts) {
    subcategories.push({
      category,
      count,
      catalogCount: index.subcategoryCatalog.get(category) ?? 0,
      ratio: ratioOf(count),
    });
  }
  subcategories.sort(byCountDesc);

  // 没用过的分类按"目录声明顺序"排：那是按盖房子最常用的先排的，
  // 玩家扫一眼就知道"还差哪几类完全没碰过"
  const unusedCategories = index.categoryOrder.filter((category) => !categoryCounts.has(category));

  const top = [...defCounts]
    .map(([defId, count]) => ({ defId, name: index.byId.get(defId)?.name ?? UNKNOWN_NAME, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh') || a.defId.localeCompare(b.defId))
    .slice(0, topN);

  const totalCatalog = index.placeableTotal;
  return {
    totalObjects,
    totalCatalog,
    usedCatalogIds: usedIds.size,
    // 目录为空时给 0 而不是 NaN：NaN 会在面板上显示成"NaN%"，比 0% 难看得多也难查得多
    coverage: totalCatalog > 0 ? usedIds.size / totalCatalog : 0,
    categories,
    subcategories,
    bins,
    binCols,
    binRows,
    maxBinCount,
    top,
    unusedCategories,
    unknownIds,
    binsUnavailableReason: canBin
      ? null
      : `世界尺寸不可用（sizeX=${describeNumber(bounds.sizeX)}、sizeZ=${describeNumber(bounds.sizeZ)}），` +
        '分箱需要两个方向都是大于 0 的有限数；这里不会画一张假的分箱图',
  };
}

/**
 * 尺寸文案：NaN / Infinity 直接写出来。
 * 不写成"未知尺寸"是因为调试时真正有用的是**到底是哪个值坏了**。
 */
function describeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}

/*
 * ────────────────────────────────────────────────────────────
 * 接线示例（Engine 里怎么用；不在这里执行，只作为文档）
 * ────────────────────────────────────────────────────────────
 * ```ts
 * const stats = computeContentStats(
 *   this.buildings.all.map((it) => ({ defId: it.defId, position: it.position })),
 *   {
 *     sizeX: this.world.sizeX,
 *     sizeZ: this.world.sizeZ,
 *     minY: 0,
 *     maxY: this.world.sizeY,
 *     originX: this.world.originX, // ⚠ 必须传：世界以原点为中心
 *     originZ: this.world.originZ,
 *   },
 *   { cols: 8, rows: 8, topN: 10 },
 * );
 * this.contentStatsUI.update(stats);
 * ```
 * `originX/originZ` 不传的后果在文件头写了：左半边会全被夹进第 0 列。
 */
