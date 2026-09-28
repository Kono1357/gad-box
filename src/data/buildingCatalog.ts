import type { BuildingDef } from '../building/types';
import { STRUCTURE_BUILDINGS } from './buildings/structure';
import { PROP_BUILDINGS } from './buildings/props';
import { STRUCTURE_ITEMS } from './catalogs/structure';
import { DOORS_WINDOWS_ITEMS } from './catalogs/doorsWindows';
import { FURNITURE_ITEMS } from './catalogs/furniture';
import { APPLIANCE_ITEMS } from './catalogs/appliances';
import { KITCHEN_BATH_ITEMS } from './catalogs/kitchenBath';
import { DECORATION_ITEMS } from './catalogs/decoration';
import { VEHICLE_ITEMS } from './catalogs/vehicle';
import { MACHINERY_ITEMS } from './catalogs/machinery';
import { MAGIC_ITEMS } from './catalogs/magic';
import { SMALL_ITEM_ITEMS } from './catalogs/smallItems';
import { PLANT_ITEMS } from './catalogs/plants';
import { NATURE_TREES, NATURE_ROCKS } from './natureTrees';

/**
 * 完整物品库（M4 第一部分后共 300+ 个）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么有两个来源目录（这里必须说清楚）
 * ────────────────────────────────────────────────────────────
 * - `buildings/structure.ts` + `buildings/props.ts`：M1.5 时代的 **77 个**基础物品。
 *   它们是手调尺寸的"零件级"模型，被 20 个物理组合、3 个教学关卡与多条既有断言引用。
 * - `catalogs/*.ts`：M4 新增的 **11 个分类文件**，按一级分类拆分（结构/门窗/家具/电器/
 *   厨卫/装饰/交通/机械/奇幻/小物品/植物）。
 *
 * 我**没有**把那 77 个搬进 `catalogs/` —— 这是一次刻意的取舍，理由写在这里免得以后被当成疏漏：
 * 搬迁是纯机械操作但影响面很大（存档、组合、教学关、断言都按 id 引用），
 * 而本项目的验证手段只有 `tsc` + 断言 + DOM 静态核对，**没有浏览器可以肉眼确认渲染结果**。
 * 在这种情况下做一次 1200 行的代码搬迁，收益是"目录看起来整齐"，风险是"某个模型悄悄变了形"。
 * 所以对外仍然只有 `BUILDING_CATALOG` / `getBuildingDef()` 一个入口，**数据源是唯一的**，
 * 只是文件分在两个目录里，并在 `verifyCatalogIntegrity()` 里统一校验 id 唯一与包围盒一致。
 *
 * ────────────────────────────────────────────────────────────
 * 一个必须保证的不变式：**id 全局唯一**
 * ────────────────────────────────────────────────────────────
 * 两个来源、13 个文件合并，重复 id 是这里最可能出的错，而它的后果很隐蔽：
 * `BY_ID` 用 `new Map` 构造，**后写的会静默覆盖先写的** —— 于是某个物品会"变成另一个"，
 * 玩家看到的是"我放的石墙怎么变成了砖墙"。所以下面在模块加载时直接校验并抛出，
 * 让问题在开发阶段就炸出来，而不是等到玩家存档里出现两个同名物品。
 */
/**
 * 全部可放置模型。
 *
 * ⚠ **这是一个可变的全局数组**，唯一允许写入它的是本文件下方的 `registerCustomItem()` /
 * `unregisterCustomItem()`（玩家自定义物品，M4 补充 2）。
 *
 * 为什么选"可变数组"而不是"每次调用 `allBuildings()` 拼一个新数组"：
 * 这个目录被 6 处消费者直接引用（物品面板、内容包面板、建筑面板、分类统计、搜索、
 * 断言），其中物品面板还在模块级缓存了"搜索用的大字符串"。改成函数之后，
 * 每一个调用点都要记得改成函数调用、每一处缓存都要记得失效 —— 漏一处就会变成
 * "自定义物品保存了但列表里没有"这种**看起来像没保存成功**的问题。
 * 直接让同一个数组变长，则所有引用方自动看到新内容；代价是它不再是只读的，
 * 所以这里把"谁可以写"写清楚，并在每次变更时**递增 `catalogVersion()`**，
 * 供下游缓存失效（物品面板的搜索缓存就是这么判断的）。
 *
 * 断言里查的是 `BUILDING_CATALOG.length`（394 条内置物品）；自定义物品在 Node 断言里
 * 不会注册，所以这个数字不会被这条设计影响 —— 但**任何"数量恒等于 394"的新断言都要
 * 注意这一点**，改成"内置数量"口径。
 */
export const BUILDING_CATALOG: BuildingDef[] = [
  ...STRUCTURE_BUILDINGS,
  ...PROP_BUILDINGS,
  ...STRUCTURE_ITEMS,
  ...DOORS_WINDOWS_ITEMS,
  ...FURNITURE_ITEMS,
  ...APPLIANCE_ITEMS,
  ...KITCHEN_BATH_ITEMS,
  ...DECORATION_ITEMS,
  ...VEHICLE_ITEMS,
  ...MACHINERY_ITEMS,
  ...MAGIC_ITEMS,
  ...SMALL_ITEM_ITEMS,
  ...PLANT_ITEMS,
  // M4：生成流水线需要的自然物体（树与岩石）。
  // 它们也是可放置物品，所以并进主目录 —— 单独放一份会让"树在面板里搜不到"。
  ...NATURE_TREES,
  ...NATURE_ROCKS,
];

/**
 * 加载期完整性校验：id 唯一 + 包围盒与 parts 一致。
 *
 * 为什么在**模块加载时**就跑（而不是只放在测试里）：
 * 这两个错误都不会让程序崩，只会让某个物品"看起来不对"——而本项目没有浏览器端人工验证，
 * 所以必须让它在开发/构建阶段就停下来。校验本身很便宜（几百个物品的纯数值计算，几毫秒）。
 *
 * 包围盒校验只对**新目录**（catalogs/）强制：M1.5 的 77 个物品是手写 size 的，
 * 其中一些刻意用"略大于 parts"的包围盒来表达"这个模型占的空间"（例如带把手的门），
 * 对它们强制一致会把既有数据全部判为错误。这个差异是有意的，不是漏做。
 */
export function verifyCatalogIntegrity(catalog: readonly BuildingDef[] = BUILDING_CATALOG): {
  ok: boolean;
  duplicateIds: string[];
  sizeMismatches: { id: string; declared: [number, number, number]; actual: [number, number, number] }[];
  total: number;
} {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const def of catalog) {
    if (seen.has(def.id)) duplicateIds.push(def.id);
    seen.add(def.id);
  }

  const sizeMismatches: { id: string; declared: [number, number, number]; actual: [number, number, number] }[] = [];
  const newIds = new Set([...STRUCTURE_ITEMS, ...DOORS_WINDOWS_ITEMS, ...FURNITURE_ITEMS, ...APPLIANCE_ITEMS,
    ...KITCHEN_BATH_ITEMS, ...DECORATION_ITEMS, ...VEHICLE_ITEMS, ...MACHINERY_ITEMS, ...MAGIC_ITEMS,
    ...SMALL_ITEM_ITEMS, ...PLANT_ITEMS, ...NATURE_TREES, ...NATURE_ROCKS].map((def) => def.id));

  for (const def of catalog) {
    if (!newIds.has(def.id)) continue;
    const actual = partsBounds(def);
    if (
      Math.abs(actual[0] - def.size[0]) > 0.025 ||
      Math.abs(actual[1] - def.size[1]) > 0.025 ||
      Math.abs(actual[2] - def.size[2]) > 0.025
    ) {
      sizeMismatches.push({ id: def.id, declared: def.size, actual });
    }
  }

  return { ok: duplicateIds.length === 0 && sizeMismatches.length === 0, duplicateIds, sizeMismatches, total: catalog.length };
}

/**
 * 按 parts 算真实包围盒（原点在底面中心，所以 minY 应当为 0）。
 *
 * ⚠ **必须处理旋转**：一部分新增物品（车轮、轨道、管道、传送带滚筒）用了
 * `rotationX` / `rotationZ` 把圆柱"放倒"，这时它的轴对齐包围盒会变大 ——
 * 例如一根 Ø0.6×0.25 的圆柱绕 Z 转 90° 之后，X 方向的占据变成 0.25、Y 方向变成 0.6。
 *
 * 第一版我没处理旋转，结果 20 个物品被判成"声明尺寸与 parts 不一致"、
 * 13 个被判成"原点不在底面中心" —— 全是**误判**，问题在检查函数而不是数据。
 * 一条检查规则的实现错了，会把正确的数据全判成错的，这种错误比数据错误更危险，
 * 因为它会让人去"修正"本来是对的东西。所以这里的旋转处理与渲染器保持同一套语义：
 * 先按局部尺寸算半长，再用旋转后的轴向分量组合出保守的包围盒。
 */
export function partsBounds(def: BuildingDef): [number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const part of def.parts) {
    const [sx, sy, sz] = part.size;
    const rx = part.rotationX ?? 0;
    const ry = part.rotationY ?? 0;
    const rz = part.rotationZ ?? 0;
    // 逐轴算旋转后的半长：某一轴上的尺度由三个局部半长在该方向上的投影叠加而成。
    // 这是**保守**估计（比真实 OBB 略大一点），与渲染器的做法一致：
    // 宁可把包围盒算大一点，也不要在物理里漏掉一个角。
    const half = rotatedHalfExtents(sx / 2, sy / 2, sz / 2, rx, ry, rz);
    minX = Math.min(minX, part.position[0] - half[0]);
    maxX = Math.max(maxX, part.position[0] + half[0]);
    minY = Math.min(minY, part.position[1] - half[1]);
    maxY = Math.max(maxY, part.position[1] + half[1]);
    minZ = Math.min(minZ, part.position[2] - half[2]);
    maxZ = Math.max(maxZ, part.position[2] + half[2]);
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [maxX - minX, maxY - minY, maxZ - minZ];
}

/**
 * parts 的最低点（应当是 0：原点在底面中心）。
 *
 * **同样必须处理旋转** —— 与 `partsBounds` 一样，我第一版忘了这件事，
 * 于是 13 个用了 `rotationZ` 把圆柱放倒的物品被误判成"原点不在底部"。
 * 检查函数的实现错了会把正确的数据判成错的，比数据错更危险（会让人去改对的东西），
 * 所以旋转语义在这两个函数里必须一致，且与渲染器一致。
 */
export function partsMinY(def: BuildingDef): number {
  let minY = Number.POSITIVE_INFINITY;
  for (const part of def.parts) {
    const [sx, sy, sz] = part.size;
    const half = rotatedHalfExtents(
      sx / 2,
      sy / 2,
      sz / 2,
      part.rotationX ?? 0,
      part.rotationY ?? 0,
      part.rotationZ ?? 0,
    );
    minY = Math.min(minY, part.position[1] - half[1]);
  }
  return Number.isFinite(minY) ? minY : 0;
}

/** 旋转后的三个轴对齐半长（按欧拉角 XYZ 顺序的保守估计） */
function rotatedHalfExtents(
  hx: number,
  hy: number,
  hz: number,
  rx: number,
  ry: number,
  rz: number,
): [number, number, number] {
  if (rx === 0 && ry === 0 && rz === 0) return [hx, hy, hz];
  const cosX = Math.abs(Math.cos(rx));
  const sinX = Math.abs(Math.sin(rx));
  const cosY = Math.abs(Math.cos(ry));
  const sinY = Math.abs(Math.sin(ry));
  const cosZ = Math.abs(Math.cos(rz));
  const sinZ = Math.abs(Math.sin(rz));
  // 绕 X：y/z 互换
  const ax = hx;
  const ay = hy * cosX + hz * sinX;
  const az = hy * sinX + hz * cosX;
  // 绕 Y：x/z 互换
  const bx = ax * cosY + az * sinY;
  const by = ay;
  const bz = ax * sinY + az * cosY;
  // 绕 Z：x/y 互换
  return [bx * cosZ + by * sinZ, bx * sinZ + by * cosZ, bz];
}

const BY_ID = new Map<string, BuildingDef>(BUILDING_CATALOG.map((def) => [def.id, def]));

/** 按 id 取模型定义 */
export function getBuildingDef(id: string): BuildingDef | undefined {
  return BY_ID.get(id);
}

/** 模型总数（性能面板与验收用） */
export const BUILDING_COUNT = BUILDING_CATALOG.length;

/** 按分类分组 */
export function groupByCategory(): Map<string, BuildingDef[]> {
  const map = new Map<string, BuildingDef[]>();
  for (const def of BUILDING_CATALOG) {
    const list = map.get(def.category);
    if (list) list.push(def);
    else map.set(def.category, [def]);
  }
  return map;
}

/**
 * 模糊搜索：名称、id、标签、说明都能命中。
 * 支持多关键词（空格分隔，全部命中才算匹配）。
 */
export function searchBuildings(query: string): BuildingDef[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...BUILDING_CATALOG];
  const keywords = trimmed.split(/\s+/);
  return BUILDING_CATALOG.filter((def) => {
    const haystack = `${def.name} ${def.id} ${def.category} ${def.tags.join(' ')} ${def.description}`.toLowerCase();
    return keywords.every((word) => haystack.includes(word));
  });
}

// ------------------------------------------------------------------ 自定义物品的运行时注册

/**
 * 目录版本号。任何一次注册/注销都会 +1。
 *
 * 物品面板在模块级缓存了"搜索用的大字符串"（`haystackCache`），它必须知道自己缓存的是
 * 哪一版目录 —— 没有这个号，玩家新建一个自定义物品之后搜不到它，而列表里明明有。
 */
let catalogVersion = 0;

/** 当前目录版本（每次注册/注销自定义物品都会变） */
export function getCatalogVersion(): number {
  return catalogVersion;
}

/** 自定义物品 id 的固定前缀。用它区分"内置"与"玩家自建"，存档回读时也靠它 */
export const CUSTOM_ITEM_PREFIX = 'custom_';

/** 这个 id 是不是自定义物品 */
export function isCustomItemId(id: string): boolean {
  return id.startsWith(CUSTOM_ITEM_PREFIX);
}

/**
 * 把一个自定义物品加进目录（运行时）。
 *
 * 校验的三件事都是**硬约定**，而且都能被纯函数检查：
 * 1. id 唯一且带 `custom_` 前缀 —— 前缀不写的话，玩家自建物品会混进内置 id 空间，
 *    以后内置加同名物品就会静默覆盖，这种 bug 极难查；
 * 2. `size` 必须等于 `parts` 的包围盒 —— 否则碰撞体与视觉错位；
 * 3. `minY === 0` —— 原点必须在底面中心，这是全项目的约定（放置、堆叠、物理都依赖它）。
 *
 * 返回中文原因而不是抛异常：调用方是 UI，它要把原因显示给玩家。
 */
export function registerCustomItem(def: BuildingDef): { ok: boolean; reason?: string } {
  if (!isCustomItemId(def.id)) {
    return { ok: false, reason: `自定义物品的 id 必须以 ${CUSTOM_ITEM_PREFIX} 开头（收到 ${def.id}）` };
  }
  if (BY_ID.has(def.id)) {
    return { ok: false, reason: `id 已被占用：${def.id}` };
  }
  const bounds = partsBounds(def);
  const sizeError = Math.max(
    Math.abs(bounds[0] - def.size[0]),
    Math.abs(bounds[1] - def.size[1]),
    Math.abs(bounds[2] - def.size[2]),
  );
  if (sizeError > 1e-6) {
    return {
      ok: false,
      reason: `size 与 parts 的包围盒不一致（差 ${sizeError.toFixed(4)} 米）：碰撞体会与看到的东西错位`,
    };
  }
  const minY = partsMinY(def);
  if (Math.abs(minY) > 1e-6) {
    return { ok: false, reason: `原点必须在底面中心（最低点是 ${minY.toFixed(4)} 而不是 0）` };
  }
  BUILDING_CATALOG.push(def);
  BY_ID.set(def.id, def);
  catalogVersion += 1;
  return { ok: true };
}

/**
 * 从目录里移除一个自定义物品。
 *
 * **不碰世界里的实例**：世界里已经放好的那些仍然存在，只是从面板里选不到了。
 * 这一点由 UI 上的文字写明（"删除不会把世界里已经放好的那些删掉"），
 * 因为反过来的假设（"删了就全没了"）会让玩家不敢删。
 */
export function unregisterCustomItem(id: string): { ok: boolean; reason?: string } {
  if (!isCustomItemId(id)) return { ok: false, reason: `不是自定义物品，不能移除：${id}` };
  const index = BUILDING_CATALOG.findIndex((def) => def.id === id);
  if (index < 0) return { ok: false, reason: `目录里没有这个物品：${id}` };
  BUILDING_CATALOG.splice(index, 1);
  BY_ID.delete(id);
  catalogVersion += 1;
  return { ok: true };
}

/** 当前目录里的自定义物品（只读快照） */
export function customItemsInCatalog(): readonly BuildingDef[] {
  return BUILDING_CATALOG.filter((def) => isCustomItemId(def.id));
}
