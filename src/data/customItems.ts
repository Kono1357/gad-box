/**
 * 自定义物品（M4 补充 2）。
 *
 * ────────────────────────────────────────────────────────────
 * 玩家能造出什么样的物品（以及**造不出**什么）
 * ────────────────────────────────────────────────────────────
 * 自定义的范围刻意收窄到"**用基本几何体拼一个东西**"：
 * 选形状（box / cylinder / sphere / cone）、尺寸、颜色、质量与物理参数，
 * 最多 8 个 part。这与内置物品用的是**同一套数据结构**（`BuildingDef`），
 * 所以自定义物品能参与放置、堆叠、物理、存档、逻辑连线 —— 沒有任何特殊路径。
 *
 * 做不到的（写清楚免得玩家期待落空）：
 * - **不能上传模型**（纯前端、不能用付费存储，也没有模型解析器）；
 * - **不能自定义碰撞体形状**（碰撞体由 parts 拼出来，与内置物品一致）；
 * - **不能加新的物理组件类型**（组件类型是代码里定的枚举，玩家只能选参数）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么必须做完整校验
 * ────────────────────────────────────────────────────────────
 * 自定义物品是**玩家输入**，而它会被写进 localStorage 并参与物理。
 * 一条坏数据（NaN 尺寸、负密度、parts 超过 8 个、id 撞上内置物品）能造成的后果
 * 从"面板显示乱码"到"物理求解器收到 NaN 直接崩掉整个 wasm"都有。
 * 所以 `validateCustomItem()` 是**唯一的入口**：任何自定义物品在保存前都必须过它，
 * 不过就拒绝并返回中文原因。
 */

import type { BuildingDef, BuildingPart, BuildingPartShape } from '../building/types';
import { getBuildingDef } from './buildingCatalog';

export const CUSTOM_ITEM_STORAGE_KEY = 'god-sandbox-custom-items-v1';
/** 最多存多少个自定义物品（localStorage 有配额，太多了会写不进去） */
export const CUSTOM_ITEM_LIMIT = 120;
/** parts 上限与内置物品一致 */
export const CUSTOM_ITEM_MAX_PARTS = 8;

export interface CustomItemDraft {
  name: string;
  /** 一级分类：允许玩家自己选，但只能从既有分类里选（否则面板分不到栏） */
  category: string;
  subcategory: string;
  icon: string;
  color: number;
  /** 质量（kg）。不填时按"体积 × 密度"算 */
  mass?: number;
  density: number;
  friction: number;
  restitution: number;
  isStatic: boolean;
  stackable: boolean;
  parts: BuildingPart[];
}

export interface CustomItemValidation {
  ok: boolean;
  /** 中文问题列表（空数组 = 合法） */
  problems: string[];
  /** 校验通过时的规范化结果 */
  normalized?: BuildingDef;
}

/** 允许玩家选择的形状（与内置物品同一套） */
export const CUSTOM_SHAPES: readonly BuildingPartShape[] = ['box', 'cylinder', 'sphere', 'cone'] as const;

/**
 * 校验并规范化一份草稿。
 *
 * @param draft 玩家输入
 * @param existingIds 已占用的 id 集合（内置 + 已有自定义），用于避免撞 id
 */
export function validateCustomItem(
  draft: CustomItemDraft,
  existingIds: ReadonlySet<string> = new Set(),
): CustomItemValidation {
  const problems: string[] = [];

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name.length === 0) problems.push('名称不能为空');
  if (name.length > 24) problems.push('名称太长（最多 24 个字）');

  if (typeof draft.category !== 'string' || draft.category.trim() === '') {
    problems.push('必须选择一个分类');
  }
  if (typeof draft.icon !== 'string' || draft.icon.trim() === '') {
    problems.push('必须选一个图标（emoji）');
  }
  if (!Number.isFinite(draft.color) || draft.color < 0 || draft.color > 0xffffff) {
    problems.push('颜色必须是 0x000000 ~ 0xffffff 之间的整数');
  }
  if (!Number.isFinite(draft.density) || draft.density <= 0 || draft.density > 30000) {
    problems.push('密度必须在 1 ~ 30000 kg/m³ 之间（钢材约 7800）');
  }
  if (!Number.isFinite(draft.friction) || draft.friction < 0 || draft.friction > 1) {
    problems.push('摩擦必须在 0 ~ 1 之间');
  }
  if (!Number.isFinite(draft.restitution) || draft.restitution < 0 || draft.restitution > 1) {
    problems.push('弹性必须在 0 ~ 1 之间');
  }

  const parts = Array.isArray(draft.parts) ? draft.parts : [];
  if (parts.length === 0) problems.push('至少要有一个几何体');
  if (parts.length > CUSTOM_ITEM_MAX_PARTS) {
    problems.push(`最多 ${CUSTOM_ITEM_MAX_PARTS} 个几何体（现在有 ${parts.length} 个）`);
  }

  // 逐个 part 检查：尺寸必须为正有限值、位置必须有限、形状必须在白名单里
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const label = `第 ${index + 1} 个几何体`;
    if (!CUSTOM_SHAPES.includes(part.shape)) {
      problems.push(`${label} 的形状不合法（只能是 box / cylinder / sphere / cone）`);
      continue;
    }
    if (!Array.isArray(part.size) || part.size.length !== 3 || part.size.some((value) => !Number.isFinite(value) || value <= 0)) {
      problems.push(`${label} 的尺寸必须是三个正数`);
      continue;
    }
    if (part.size.some((value) => value > 50)) {
      problems.push(`${label} 太大了（单边最多 50 米）`);
    }
    if (
      !Array.isArray(part.position) ||
      part.position.length !== 3 ||
      part.position.some((value) => !Number.isFinite(value))
    ) {
      problems.push(`${label} 的位置必须是三个有限数`);
      continue;
    }
    if (part.position.some((value) => Math.abs(value) > 200)) {
      problems.push(`${label} 的位置太远（离原点最多 200 米）`);
    }
    if (!Number.isFinite(part.color) || part.color < 0 || part.color > 0xffffff) {
      problems.push(`${label} 的颜色不合法`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  // ---- 规范化：算包围盒、底面贴到 y=0、算质量、生成 id
  const bounds = boundsOfParts(parts);
  const normalizedParts = parts.map((part) => ({
    ...part,
    // 把整个模型抬到"最低点贴 y=0"：原点在底面中心是项目的硬约定，
    // 玩家画的时候不会去想这件事，所以由这里统一纠正
    position: [part.position[0], part.position[1] - bounds.minY, part.position[2]] as [number, number, number],
  }));

  const size: [number, number, number] = [bounds.size[0], bounds.size[1], bounds.size[2]];
  const volume = size[0] * size[1] * size[2];
  const mass = Number.isFinite(draft.mass) && (draft.mass ?? 0) > 0
    ? (draft.mass as number)
    : Math.max(0.01, volume * draft.density);

  const id = uniqueId(name, existingIds);
  const normalized: BuildingDef = {
    id,
    name,
    category: draft.category,
    subcategory: draft.subcategory && draft.subcategory.trim() !== '' ? draft.subcategory.trim() : '自定义',
    type: 'prop',
    shape: 'composite',
    size,
    mass,
    friction: draft.friction,
    restitution: draft.restitution,
    color: draft.color,
    icon: draft.icon,
    isStatic: draft.isStatic,
    isDestructible: true,
    isPlaceable: true,
    stackable: draft.stackable,
    tags: ['自定义'],
    description: '玩家自己拼的物品',
    parts: normalizedParts,
    lodLevels: 1,
  };

  return { ok: true, problems: [], normalized };
}

/**
 * 由名称生成一个不撞车的 id。
 *
 * 做法：把中文名转成可读的 slug（保留中文，因为存档是 JSON、中文键完全合法），
 * 撞车就加后缀。**不用随机后缀** —— 那样同一个名字每次生成不同 id，
 * 存档里会出现一堆看不出区别的 `custom_桌_8f3a`。
 */
export function uniqueId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'item';
  let candidate = `custom_${slug}`;
  let suffix = 2;
  while (existingIds.has(candidate) || getBuildingDef(candidate) !== undefined) {
    candidate = `custom_${slug}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** 按 parts 算包围盒（与 buildingCatalog.partsBounds 同一套语义：旋转感知） */
function boundsOfParts(parts: readonly BuildingPart[]): {
  minY: number;
  size: [number, number, number];
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const half = rotateHalf(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2, part);
    minX = Math.min(minX, part.position[0] - half[0]);
    maxX = Math.max(maxX, part.position[0] + half[0]);
    minY = Math.min(minY, part.position[1] - half[1]);
    maxY = Math.max(maxY, part.position[1] + half[1]);
    minZ = Math.min(minZ, part.position[2] - half[2]);
    maxZ = Math.max(maxZ, part.position[2] + half[2]);
  }
  if (!Number.isFinite(minX)) return { minY: 0, size: [0.1, 0.1, 0.1] };
  return {
    minY,
    size: [Math.max(0.02, maxX - minX), Math.max(0.02, maxY - minY), Math.max(0.02, maxZ - minZ)],
  };
}

function rotateHalf(hx: number, hy: number, hz: number, part: BuildingPart): [number, number, number] {
  const rx = part.rotationX ?? 0;
  const ry = part.rotationY ?? 0;
  const rz = part.rotationZ ?? 0;
  if (rx === 0 && ry === 0 && rz === 0) return [hx, hy, hz];
  const cosX = Math.abs(Math.cos(rx));
  const sinX = Math.abs(Math.sin(rx));
  const cosY = Math.abs(Math.cos(ry));
  const sinY = Math.abs(Math.sin(ry));
  const cosZ = Math.abs(Math.cos(rz));
  const sinZ = Math.abs(Math.sin(rz));
  const ax = hx;
  const ay = hy * cosX + hz * sinX;
  const az = hy * sinX + hz * cosX;
  const bx = ax * cosY + az * sinY;
  const by = ay;
  const bz = ax * sinY + az * cosY;
  return [bx * cosZ + by * sinZ, bx * sinZ + by * cosZ, bz];
}

// ------------------------------------------------------------------ 持久化

export interface CustomItemStore {
  items: BuildingDef[];
  /** 保存失败的原因（中文）；成功为 null */
  lastError: string | null;
}

/**
 * 读取自定义物品。
 *
 * **逐条校验**：存档可能被手改过、也可能是旧版本写的。逐条过 `validateCustomItem` 的
 * 简化版（不重算 id）能挡掉坏数据，而不是让一条 NaN 把整个物理世界带崩。
 */
export function loadCustomItems(): CustomItemStore {
  if (typeof localStorage === 'undefined') return { items: [], lastError: null };
  try {
    const raw = localStorage.getItem(CUSTOM_ITEM_STORAGE_KEY);
    if (!raw) return { items: [], lastError: null };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { items: [], lastError: '自定义物品存档格式不对（不是数组），已忽略' };
    const items: BuildingDef[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      const def = entry as Partial<BuildingDef>;
      if (!def || typeof def.id !== 'string' || typeof def.name !== 'string') continue;
      if (seen.has(def.id)) continue;
      if (!Array.isArray(def.parts) || def.parts.length === 0) continue;
      if (!Array.isArray(def.size) || def.size.length !== 3 || def.size.some((v) => !Number.isFinite(v))) continue;
      seen.add(def.id);
      items.push(def as BuildingDef);
    }
    return { items, lastError: null };
  } catch (error) {
    return { items: [], lastError: `读取自定义物品失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function saveCustomItems(items: readonly BuildingDef[]): { ok: boolean; reason?: string } {
  if (typeof localStorage === 'undefined') return { ok: false, reason: '当前环境没有 localStorage（隐私模式？）' };
  if (items.length > CUSTOM_ITEM_LIMIT) {
    return { ok: false, reason: `最多保存 ${CUSTOM_ITEM_LIMIT} 个自定义物品（现在 ${items.length} 个）` };
  }
  try {
    localStorage.setItem(CUSTOM_ITEM_STORAGE_KEY, JSON.stringify(items));
    return { ok: true };
  } catch (error) {
    // 配额满是最常见的失败：如实说，并给出可行的下一步
    return {
      ok: false,
      reason: `保存失败（可能是浏览器存储配额满了）：${error instanceof Error ? error.message : String(error)}。可以删掉一些自定义物品或导出后清理。`,
    };
  }
}

/** 导出成可分享的 JSON */
export function exportCustomItems(items: readonly BuildingDef[]): string {
  return JSON.stringify({ version: 1, kind: 'god-sandbox-custom-items', items }, null, 2);
}

/** 导入：逐条校验，返回成功导入的与失败的原因 */
export function importCustomItems(
  text: string,
  existingIds: ReadonlySet<string>,
): { imported: BuildingDef[]; problems: string[] } {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { imported: [], problems: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown }).items;
  if (!Array.isArray(list)) return { imported: [], problems: ['文件里没有 items 数组'] };

  const imported: BuildingDef[] = [];
  const taken = new Set(existingIds);
  for (let index = 0; index < list.length; index += 1) {
    const def = list[index] as BuildingDef;
    // 重新校验（导入的文件可能来自别的版本），并强制换 id 以免覆盖本地同名物品
    // 注意质量与密度的关系：导出文件里带的是**算好的质量**，
    // 所以要把它作为 `mass` 传进去（`validateCustomItem` 会优先用 mass）。
    // 第一版我把"有 mass 时 density 传 0"当成了"不用重算"的写法 ——
    // 结果 0 不是一个合法密度，导入被自己的校验拒绝，往返直接断了。
    // 正确做法是：mass 照传，density 给一个合法值兜底（只在 mass 缺失时才会用到它）。
    const check = validateCustomItem(
      {
        name: def?.name ?? '',
        category: def?.category ?? '装饰',
        subcategory: def?.subcategory ?? '自定义',
        icon: def?.icon ?? '📦',
        color: def?.color ?? 0xaaaaaa,
        mass: Number.isFinite(def?.mass) && (def?.mass ?? 0) > 0 ? def?.mass : undefined,
        density: 700,
        friction: def?.friction ?? 0.5,
        restitution: def?.restitution ?? 0.2,
        isStatic: def?.isStatic ?? false,
        stackable: def?.stackable ?? true,
        parts: def?.parts ?? [],
      },
      taken,
    );
    if (!check.ok || !check.normalized) {
      problems.push(`第 ${index + 1} 个（${def?.name ?? '无名'}）：${check.problems.join('；')}`);
      continue;
    }
    taken.add(check.normalized.id);
    imported.push(check.normalized);
  }
  return { imported, problems };
}
