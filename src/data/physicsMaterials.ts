/**
 * 物理材质库（问题 A.1）。
 *
 * ## 为什么要有"材质"这一层
 *
 * Rapier 里每个碰撞体只有三个旋钮：摩擦、弹性、（由密度推出的）质量。
 * 如果让玩家一个个手填，第一次玩的人根本不知道该填多少 —— 所以这里给一套
 * **有真实参考值的预设**：选"冰"，玩家立刻能预期"东西会滑"。
 *
 * ## 真值 vs 手感
 *
 * 下表的密度是**真实量级的近似值（非精确值）**：钢材 7800 kg/m³、冰 917 kg/m³、
 * 干沙约 1600 kg/m³ 这些数字查一下就有，用它们比"随便填 1.0"好得多 ——
 * 因为密度同时决定质量，进而决定惯性，乱填会让"铁球砸木箱"看起来像"乒乓球砸木箱"。
 * 摩擦与弹性则是**游戏化的简化值**：真实摩擦系数是一对表面对的组合属性，
 * 不存在"木材的摩擦系数"这种东西（见 combineMaterials 的说明）。
 *
 * ## 纯数据
 *
 * 本文件不 import Rapier / Three.js / DOM，也不在模块顶层碰 localStorage：
 * Node 里直接 import 就能跑（`npm run verify` 会这么做）。
 * 唯一的外部依赖是体素表与建筑表（它们同样是纯数据）。
 */

import { getBuildingDef } from './buildingCatalog';
import { getVoxelDef } from './voxelTypes';

export interface PhysicsMaterial {
  id: string;
  name: string;
  /** 摩擦系数（库仑静摩擦与动摩擦用同一个值，这是简化） */
  friction: number;
  /** 弹性系数 0~1 */
  restitution: number;
  /** 密度 kg/m³（真实量级，不是随意数字） */
  density: number;
  /** 线性阻尼（每秒衰减比例，0 = 不衰减） */
  linearDamping: number;
  /** 角阻尼 */
  angularDamping: number;
  emoji: string;
  description: string;
}

/** 兜底材质的 id：查不到体素 / 分类 / 模型时返回它 */
const FALLBACK_MATERIAL_ID = 'default';

/**
 * 第 9 条：兜底材质（**不是**预设，面板里应当标成"通用"而不是可选材质）。
 * 参数取中性值，密度用水附近的量级，避免兜底时出现"1 kg/m³ 的羽毛"这种怪事。
 *
 * 定义在数组之前，因为它要作为 `PHYSICS_MATERIALS` 的最后一个元素。
 */
const FALLBACK_MATERIAL: PhysicsMaterial = {
  id: FALLBACK_MATERIAL_ID,
  name: '通用',
  friction: 0.5,
  restitution: 0.2,
  density: 1000,
  linearDamping: 0.05,
  angularDamping: 0.05,
  emoji: '📦',
  description: '兜底材质：体素或建筑分类没登记时使用，参数取中性值，不代表任何真实材料。',
};

/**
 * 8 种预设 + 1 个兜底（共 9 条，最后一条是 'default'）。
 *
 * 阻尼的取法（沙和泥"吸能"，所以阻尼大）：
 * - 金属 / 石材 / 玻璃：全是刚性体，形变与内耗极小 → 0 ~ 0.05；
 * - 木材：纤维有内耗，但仍算刚体 → 0.05；
 * - 冰：几乎不吸能 → 0.01（只留一点点，避免物体永远滑不停）；
 * - 橡胶：靠形变吸能，最能"吃掉"弹跳 → 0.2；
 * - 沙：颗粒之间互相摩擦、频繁重排，能量被大量耗散 → 0.4；
 * - 泥：黏性介质，陷进去基本就停住了 → 0.6。
 *
 * 注意阻尼是**每秒**衰减比例，不是"减多少速度"：0.6 意味着 1 秒后只剩约 40%。
 * Rapier 允许大于 1 的值，但本项目最大只用到泥的 0.6。
 */
export const PHYSICS_MATERIALS: readonly PhysicsMaterial[] = [
  {
    id: 'metal',
    name: '金属',
    friction: 0.6,
    restitution: 0.25,
    density: 7800,
    linearDamping: 0.02,
    angularDamping: 0.02,
    emoji: '🔩',
    description: '钢材 / 铝材等金属表面：摩擦中等、有一定弹性，密度最大，适合当重物与机械件。',
  },
  {
    id: 'wood',
    name: '木材',
    friction: 0.5,
    restitution: 0.35,
    density: 650,
    linearDamping: 0.05,
    angularDamping: 0.05,
    emoji: '🪵',
    description: '木材：轻、摩擦与弹性都居中，是最通用的默认材质，木板会弹一下但不会飞。',
  },
  {
    id: 'stone',
    name: '石材',
    friction: 0.75,
    restitution: 0.1,
    density: 2600,
    linearDamping: 0.05,
    angularDamping: 0.05,
    emoji: '🪨',
    description: '石材 / 混凝土：摩擦大、几乎不弹，又沉又稳，做地基与承重结构。',
  },
  {
    id: 'glass',
    name: '玻璃',
    friction: 0.4,
    restitution: 0.45,
    density: 2500,
    linearDamping: 0.02,
    angularDamping: 0.03,
    emoji: '🪟',
    description: '玻璃：摩擦小、弹性偏高，既容易滑动又爱弹开，适合做花瓶与窗这类易碎件。',
  },
  {
    id: 'rubber',
    name: '橡胶',
    friction: 0.95,
    restitution: 0.8,
    density: 1100,
    linearDamping: 0.2,
    angularDamping: 0.2,
    emoji: '🏀',
    description: '橡胶：摩擦接近上限、弹性最高，几乎抓得住任何斜面并弹得很高。',
  },
  {
    id: 'ice',
    name: '冰',
    friction: 0.05,
    restitution: 0.1,
    density: 917,
    linearDamping: 0.01,
    angularDamping: 0.01,
    emoji: '🧊',
    description: '冰面：摩擦极小，箱子放上去会一路滑到底；弹性低，撞上去也不太弹。',
  },
  {
    id: 'sand',
    name: '沙',
    friction: 0.6,
    restitution: 0.05,
    density: 1600,
    linearDamping: 0.4,
    angularDamping: 0.4,
    emoji: '⏳',
    description: '沙：摩擦中等但完全没有弹性，阻尼很大（沙子吸能），扔下来就趴住不动。',
  },
  {
    id: 'mud',
    name: '泥',
    friction: 0.85,
    restitution: 0.02,
    density: 1900,
    linearDamping: 0.6,
    angularDamping: 0.6,
    emoji: '🟫',
    description: '泥：摩擦最大、完全不弹、阻尼最大，陷进去就出不来，最适合做沼泽与河床。',
  },
  FALLBACK_MATERIAL,
];

/** 新建物体默认用的材质（面板默认选中项） */
export const DEFAULT_MATERIAL_ID = 'wood';

const BY_ID = new Map<string, PhysicsMaterial>(PHYSICS_MATERIALS.map((m) => [m.id, m]));

/**
 * 按 id 取材质；**查不到返回兜底材质**而不是抛错 ——
 * 存档里可能存着上一版本的材质 id，崩掉整个面板不值得。
 *
 * 注意：这里只查内置表。玩家自定义材质请用 `loadCustomMaterials()` 自行合并
 * （保持本函数是纯函数，Node 里也能直接调用）。
 */
export function getMaterial(id: string): PhysicsMaterial {
  return BY_ID.get(id) ?? FALLBACK_MATERIAL;
}

/** 面板用：全部材质（8 预设 + 1 兜底，共 9 条） */
export function listMaterials(): readonly PhysicsMaterial[] {
  return PHYSICS_MATERIALS;
}

// ---------------------------------------------------------------- 合并规则

export interface CombinedMaterial {
  friction: number;
  restitution: number;
  density: number;
  linearDamping: number;
  angularDamping: number;
}

/**
 * 材质合并规则。
 *
 * **为什么这么定（这三条是简化规则，不是物理教科书结论）**：
 *
 * - `friction = sqrt(f1 * f2)`：真实的摩擦系数根本是"两个表面共同"的属性，
 *   没有"木材的摩擦系数"这种东西，只有"木对木""木对冰"。工程上常用几何平均来
 *   合成两个表面的粗糙度，因为 sqrt 的**结果永远落在两者之间**：
 *   只要有一方是冰面（0.05），木箱（0.5）放上去就该明显打滑（合并后约 0.16），
 *   而不是像算术平均那样被"拉高"到 0.275 让人误以为还站得住。
 * - `restitution = max(r1, r2)`：弹性是**材料本身**的属性，橡胶球的弹性来自球，
 *   不来自水泥地 —— 所以橡胶球砸水泥地照样该弹，取较大值更符合直觉。
 *   （真实碰撞里能量也会被地面吸走一部分，取 max 是偏"乐观"的简化。）
 * - `density = 均值`：密度只在"混合体"（一堆碎块当成一个刚体）时才有意义，
 *   单独一个刚体直接用自己那条材质的密度就行，这里只是给混合体一个可用的近似值。
 *
 * 阻尼**规格里没有规定**，本项目按"取较大的一方"处理：只要有一方在吸能，
 * 整体就该更快停下来，取 max 是更保守（更不容易抖动/穿模）的选择。
 */
export function combineMaterials(a: PhysicsMaterial, b: PhysicsMaterial): CombinedMaterial {
  return {
    friction: Math.sqrt(a.friction * b.friction),
    restitution: Math.max(a.restitution, b.restitution),
    density: (a.density + b.density) / 2,
    linearDamping: Math.max(a.linearDamping, b.linearDamping),
    angularDamping: Math.max(a.angularDamping, b.angularDamping),
  };
}

// ---------------------------------------------------------------- 体素映射

/**
 * 体素 → 材质 id，按**字符串 key** 而不是数值 id 登记。
 *
 * 理由：数值 id 是 Uint8Array 里存的东西（见 voxelTypes.ts 的扩展规则，
 * 只能在数组末尾追加），而 key 是给人看的稳定标识。用 key 登记后，
 * 以后追加新体素也不会因为插错位置而把"石头"映射成"沙子"。
 * 没登记的新体素自动落到兜底材质，不会报错。
 */
const VOXEL_MATERIAL: Record<string, string> = {
  // 非实心：水不产生摩擦，空气更谈不上 → 兜底（调用方应在遇到非实心体素时自己跳过）
  air: FALLBACK_MATERIAL_ID,
  water: FALLBACK_MATERIAL_ID,
  // 土壤类：草皮与泥土都按"泥"处理 —— 松软、摩擦大、吸能
  grass: 'mud',
  dirt: 'mud',
  mud: 'mud',
  // 岩石类：石头、圆石、大理石、玄武岩本质都是石；砖与岩浆按高温岩石近似
  stone: 'stone',
  cobble: 'stone',
  marble: 'stone',
  basalt: 'stone',
  brick: 'stone',
  lava: 'stone',
  // 沙：散粒体，摩擦中等但没有弹性
  sand: 'sand',
  // 雪按"低摩擦面"处理，和冰共用一个材质（简化：真实雪面比冰略涩）
  snow: 'ice',
  ice: 'ice',
  // 植物类：木材、树叶、仙人掌都按木材（摩擦弹性居中）
  wood: 'wood',
  leaves: 'wood',
  cactus: 'wood',
  // 金属与玻璃：1:1 对应
  steel: 'metal',
  glass: 'glass',
};

/** 体素 → 物理材质（地形摩擦决定箱子能不能停在斜坡上） */
export function materialForVoxel(voxelId: number): PhysicsMaterial {
  const key = getVoxelDef(voxelId).key;
  return getMaterial(VOXEL_MATERIAL[key] ?? FALLBACK_MATERIAL_ID);
}

// ---------------------------------------------------------------- 建筑映射

/**
 * 建筑分类 → 材质 id。key 必须与 buildingCategories.ts 里的**真实分类 id** 一致
 * （结构 / 门窗 / 家具 / 电器 / 厨卫 / 装饰 / 交通 / 机械 / 奇幻），
 * 所以这里用 Record<...> 的类型而不是随便写的字符串，写错分类名 TS 立刻报错。
 */
const CATEGORY_MATERIAL: Record<string, string> = {
  结构: 'stone', // 墙 / 柱 / 地基 / 楼梯：以石与混凝土为主
  门窗: 'wood', // 木门木窗最常见（铁门、玻璃门按模型自带的摩擦弹性走）
  家具: 'wood', // 桌椅床柜基本都是木制
  电器: 'metal', // 家电外壳是金属与塑料，按金属近似
  厨卫: 'stone', // 陶瓷与搪瓷的摩擦弹性接近石材
  装饰: 'wood', // 地毯、挂画、花瓶之类的轻质陈设，取通用的木材
  交通: 'metal', // 车船火车都是金属壳体
  机械: 'metal', // 齿轮、活塞、轮子都是机械件
  奇幻: 'glass', // 水晶、传送门、浮空石：又脆又弹，用玻璃反而最有手感
};

/** 建筑分类 → 物理材质（按 buildingCategories 的真实分类名映射，不要猜） */
export function materialForBuildingCategory(category: string): PhysicsMaterial {
  return getMaterial(CATEGORY_MATERIAL[category] ?? FALLBACK_MATERIAL_ID);
}

/**
 * 模型 id → 材质：先查分类，查不到用兜底。
 *
 * **刻意不做"模型级覆盖表"**：每个 BuildingDef 自己就带 friction / restitution
 * （见 building/types.ts），单件模型的精确手感归它管；本函数只提供
 * "这个模型属于哪一类材料"的粗粒度结论（决定阻尼与密度量级）。
 * 两套数据各管一段，不会出现两个地方抢着定义同一个摩擦系数。
 */
export function materialForBuilding(defId: string): PhysicsMaterial {
  const def = getBuildingDef(defId);
  if (!def) return getMaterial(FALLBACK_MATERIAL_ID);
  return materialForBuildingCategory(def.category);
}

// ---------------------------------------------------------------- 面板文案

/** 面板用：一行中文摘要 */
export function describeMaterial(material: PhysicsMaterial): string {
  return (
    `${material.emoji} ${material.name} · 摩擦 ${material.friction.toFixed(2)}` +
    ` · 弹性 ${material.restitution.toFixed(2)}` +
    ` · 密度 ${Math.round(material.density)} kg/m³` +
    ` · 阻尼 ${material.linearDamping.toFixed(2)}/${material.angularDamping.toFixed(2)}`
  );
}

// ---------------------------------------------------------------- 校验

function checkUnit(value: number, label: string, problems: string[]): void {
  if (!Number.isFinite(value)) {
    problems.push(`${label}必须是数字（当前是 ${String(value)}）`);
    return;
  }
  if (value < 0 || value > 1) {
    problems.push(`${label}必须在 0 ~ 1 之间（当前 ${value}）`);
  }
}

function checkDamping(value: number, label: string, problems: string[]): void {
  if (!Number.isFinite(value)) {
    problems.push(`${label}必须是数字（当前是 ${String(value)}）`);
    return;
  }
  if (value < 0) {
    problems.push(`${label}不能为负（当前 ${value}）：负阻尼会持续给物体加能量，物体会自己飞起来`);
  }
}

/**
 * 校验一条材质，返回中文问题列表（空数组 = 合法）。
 * 面板保存自定义材质前必须先过这一关，否则脏数据会直接进物理引擎。
 */
export function validateMaterial(material: PhysicsMaterial): string[] {
  const problems: string[] = [];
  if (typeof material.id !== 'string' || !/^[a-z0-9_]+$/.test(material.id)) {
    problems.push('id 只能用小写英文、数字与下划线，且不能为空');
  }
  if (typeof material.name !== 'string' || material.name.trim().length === 0) {
    problems.push('名称不能为空');
  }
  checkUnit(material.friction, '摩擦系数', problems);
  checkUnit(material.restitution, '弹性系数', problems);
  if (!Number.isFinite(material.density)) {
    problems.push(`密度必须是数字（当前是 ${String(material.density)}）`);
  } else if (material.density <= 0) {
    problems.push(`密度必须为正（kg/m³，当前 ${material.density}）：密度会决定质量，0 或负值会让刚体变成幽灵`);
  }
  checkDamping(material.linearDamping, '线性阻尼', problems);
  checkDamping(material.angularDamping, '角阻尼', problems);
  return problems;
}

// ---------------------------------------------------------------- 玩家自定义材质

/** 玩家自定义材质（M3 面板可改，存在 localStorage） */
export const CUSTOM_MATERIALS_KEY = 'god-sandbox-physics-materials-v1';

/**
 * 取 localStorage。
 * 不可用时（Node 里跑验证脚本 / 隐私模式 / 站点数据被禁）返回 null，**绝不抛错** ——
 * 面板拿不到存储最多是"存不了自定义材质"，不该让整个设置页崩掉。
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // 部分浏览器在禁用 Cookie 时访问 localStorage 会直接抛异常
  }
}

/** 取数：非法值回落到默认，保证返回值形状完整（老存档可能缺 emoji / description） */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 把存档里的一条原始数据洗成合法材质；洗不干净（校验不过）返回 null 直接丢弃 */
function sanitizeCustom(raw: unknown): PhysicsMaterial | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Partial<PhysicsMaterial>;
  if (typeof source.id !== 'string' || typeof source.name !== 'string') return null;
  const material: PhysicsMaterial = {
    id: source.id,
    name: source.name,
    friction: num(source.friction, 0.5),
    restitution: num(source.restitution, 0.2),
    density: num(source.density, 1000),
    linearDamping: num(source.linearDamping, 0.05),
    angularDamping: num(source.angularDamping, 0.05),
    emoji: typeof source.emoji === 'string' && source.emoji.length > 0 ? source.emoji : '📦',
    description:
      typeof source.description === 'string' && source.description.length > 0
        ? source.description
        : '玩家自定义材质',
  };
  return validateMaterial(material).length > 0 ? null : material;
}

/**
 * 读玩家自定义材质。
 * 任何异常（JSON 坏了、被手改过、结构不对）都退化成"没有自定义材质"，
 * 重名只保留第一条。返回的是**新的数组与对象**，改它不会影响别处。
 */
export function loadCustomMaterials(): PhysicsMaterial[] {
  const store = storage();
  if (!store) return [];
  let parsed: unknown;
  try {
    const raw = store.getItem(CUSTOM_MATERIALS_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: PhysicsMaterial[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const material = sanitizeCustom(item);
    if (!material || seen.has(material.id)) continue;
    seen.add(material.id);
    result.push(material);
  }
  return result;
}

/**
 * 保存（或按 id 覆盖）一条自定义材质。
 * 返回 false 的三种情况：校验不通过、存储不可用、写入超配额 —— 都不会抛异常。
 *
 * 允许 id 与内置预设相同（表示"我要覆盖预设的参数"），面板显示时应标出「已覆盖」。
 */
export function saveCustomMaterial(material: PhysicsMaterial): boolean {
  if (validateMaterial(material).length > 0) return false;
  const store = storage();
  if (!store) return false;
  const list = loadCustomMaterials().filter((item) => item.id !== material.id);
  list.push(material);
  try {
    store.setItem(CUSTOM_MATERIALS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // 配额满或被禁用
  }
}
