/**
 * 生成内容提供者（M4 第 3 批）：把"物品库 + 模板参数"翻译成流水线要的东西。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要这一层
 * ────────────────────────────────────────────────────────────
 * `GenerationPipeline` 刻意**不认识物品库** —— 它只知道"有一批自然物体规格、
 * 一套建筑套件、一批小物品候选"。这样做的好处是流水线可以在 Node 里用假数据测透
 * （`verify.ts` 里就是这么做的），而不必把整个目录拉进去。
 *
 * 但真跑的时候必须有人把"物品库里的 id"接上去，这就是本文件的职责。
 * 它同时承担三件容易散落各处的事：
 * 1. **id 的存在性校验**：这里列出的每个 defId 都要真的在目录里，
 *    否则生成出来的世界里会出现"看得见摸不着"的空物体。启动时校验一次并抛错，
 *    比在玩家机器上生成出一堆空壳要好；
 * 2. **半尺寸的换算**：流水线要的是 AABB 半长，而目录里存的是 `size`（三个全长）。
 *    换算只有一处，就没人会写错轴；
 * 3. **内容包联动**：被玩家关掉的内容包里的物品不该出现在新生成的地图里 ——
 *    否则"我关掉了载具包，怎么地图上还是全是车"。
 */

import type { BuildingDef } from '../building/types';
import { getWorldSize } from '../worldSize';
import { BUILDING_CATALOG, getBuildingDef } from '../data/buildingCatalog';
import { getVoxelId } from '../data/voxelTypes';
import { getMapTemplate, TEMPLATE_PARAM_LIMITS, type MapTemplate, type MapTemplateParams } from '../data/mapTemplates';
import { CONTENT_PACKS, loadEnabledPacks, packOfCategory, type ContentPackId } from '../data/contentPacks';
import type { TerrainParams } from '../voxel/TerrainGenerator';
import type { BuildingKit, ItemKit } from './BuildingPlanner';
import type { NatureKindSpec, PlacementWorld } from './ObjectPlacer';
import type { GenerationParams } from './GenerationPipeline';

/** 自然物规格：kind 名 → 用目录里的哪些 id */
const NATURE_KINDS: readonly { kind: string; defIds: readonly string[]; weight: number; crown: number }[] = [
  { kind: '阔叶树', defIds: ['tree_broadleaf'], weight: 1, crown: 2.1 },
  { kind: '针叶树', defIds: ['tree_conifer'], weight: 0.7, crown: 1.7 },
  { kind: '白桦', defIds: ['tree_birch'], weight: 0.4, crown: 1.8 },
  { kind: '棕榈', defIds: ['tree_palm'], weight: 0.25, crown: 2.3 },
  { kind: '枯木', defIds: ['tree_deadwood'], weight: 0.2, crown: 1.2 },
  { kind: '灌木', defIds: ['bush_shrub'], weight: 1.2, crown: 0.8 },
  { kind: '巨石', defIds: ['rock_boulder'], weight: 0.35, crown: 0 },
];

/** 启动期校验：本文件引用的 defId 必须都存在 */
export function verifyGenerationDefIds(): string[] {
  const missing: string[] = [];
  for (const kind of NATURE_KINDS) {
    for (const id of kind.defIds) if (!getBuildingDef(id)) missing.push(`${kind.kind}:${id}`);
  }
  for (const id of ['floor_wood', 'wall_stone', 'door_wood', 'window_single', 'roof_tile', 'pillar_stone']) {
    if (!getBuildingDef(id)) missing.push(`buildingKit:${id}`);
  }
  return missing;
}

/**
 * 自然物规格（含距建筑 2 米避让、树间距按**树冠**算 —— 用户给的硬约束，写在这里而不是散在流水线里）。
 *
 * ── 为什么树间距不写死 3 米 ──
 * 第一版写死 3 米。但阔叶树的树冠半径是 2.1 米（直径 4.2 米），
 * 于是相邻两棵树的树冠必然互相穿进去 —— 端到端跑一遍实测出 391 处"重叠"冲突，
 * 其中绝大部分是树冠 vs 树冠。这事儿**不能靠提高检测容差掩盖**：
 * 容差一放，建筑与物品的真实重叠也一起被放过了。
 * 所以正确的位置是**生成规则**：间距 = max(类别下限, 树冠半径 × 2 × 0.95)。
 * 系数 0.95 而不是 1.0：树冠是不规则的球体近似，允许贴着长一点点，
 * 完全不让碰会显得像人工林。
 *
 * 灌木与巨石不按树冠算（它们没有树冠），各给一个固定下限：
 * 灌木 1.2 米（林下灌木本来成片长）、巨石 2.5 米。
 */
export function buildNatureSpecs(template: MapTemplate, enabledPacks: ReadonlySet<ContentPackId>): NatureKindSpec[] {
  const specs: NatureKindSpec[] = [];
  for (const kind of NATURE_KINDS) {
    const def = getBuildingDef(kind.defIds[0]!);
    if (!def) continue;
    // 内容包过滤：关掉的包里不该出现东西
    if (!enabledPacks.has(packOfCategory(def.category).id)) continue;
    const isTree = kind.crown > 0;
    const halfX = def.size[0] / 2;
    const halfZ = def.size[2] / 2;
    // 最小间距 = max(类别下限, 两个包围盒恰好不相碰所需的距离)。
    //
    // ── 这条公式是被两次实测逼出来的，写清楚免得又被"优化"回去 ──
    // 第一次写死 3 米：阔叶树树冠直径 4.2 米 → 相邻树冠必然互相穿进去。
    // 第二次改成 `crownRadius × 2 × 0.95`：系数 0.95 是"允许贴着长一点"的意思，
    // 但它恰好**保证了**相邻树的包围盒必然相交（0.95 < 1）——
    // 于是冲突检测每张图都报几十处重叠，修复器挪不动就删，
    // 实测 high_mountain 有 30 棵树被删掉 21 棵（删除是最后手段，不该变成主路径）。
    // 所以系数改成 1.02（略大于 1）：包围盒之间留 2% 余量，
    // 比检测器的 0.12 米重叠容差更宽，从源头上就不会产生"重叠"这条冲突。
    const boxSpacing = 2 * Math.max(halfX, halfZ) * 1.02;
    const kindFloor = isTree ? 3 : kind.kind === '灌木' ? 1.2 : 2.5;
    specs.push({
      kind: kind.kind,
      defIds: kind.defIds.filter((id) => getBuildingDef(id) !== undefined),
      // 树的权重整体乘模板的树密度；岩石不受树密度影响（沙漠里也该有石头）
      weight: isTree ? kind.weight * template.params.treeDensity : kind.weight,
      half: [halfX, halfZ],
      height: def.size[1],
      crownRadius: kind.crown,
      minSpacing: Math.max(kindFloor, boxSpacing),
      // 树与建筑之间 2 米（用户要求）；灌木可以贴着房子长，所以给 0.8
      buildingClearance: isTree ? 2 : 0.8,
      // 巨石可以长在沙地上（沙漠里也有石头），树不行
      forbidSand: isTree,
    });
  }
  return specs;
}

/** 建筑套件（房 = 地板 + 四墙 + 门 + 两窗 + 四柱 + 屋顶） */
export function buildBuildingKit(enabledPacks: ReadonlySet<ContentPackId>): BuildingKit | null {
  const ids = {
    floor: 'floor_wood',
    wall: 'wall_stone',
    door: 'door_wood',
    window: 'window_single',
    roof: 'roof_tile',
    pillar: 'pillar_stone',
  };
  const defs = Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [key, getBuildingDef(id)]),
  ) as Record<keyof typeof ids, BuildingDef | undefined>;
  if (!defs.floor || !defs.wall || !defs.door || !defs.roof) return null;
  // 结构类被关掉时就没有可用的建筑套件 —— 如实返回 null，让流水线跳过建筑阶段
  if (!enabledPacks.has(packOfCategory(defs.wall.category).id)) return null;
  return {
    floor: ids.floor,
    wall: ids.wall,
    door: ids.door,
    window: defs.window ? ids.window : undefined,
    roof: ids.roof,
    pillar: defs.pillar ? ids.pillar : undefined,
    sizes: {
      wall: defs.wall.size,
      door: defs.door.size,
      window: defs.window?.size,
      roof: defs.roof.size,
      pillar: defs.pillar?.size,
    },
  };
}

/**
 * 小物品候选。
 *
 * 只取**真正小**的东西（最长边 ≤ 0.6 米）—— 否则"小物品生成"会把沙发和冰箱
 * 当成杯子一样往房间里塞，看起来像搬家现场而不是布置。
 * 而且只取 `stackable !== false` 的：会滚的东西（球、乐器）摆在随机位置会到处乱滚。
 */
export function buildItemKit(enabledPacks: ReadonlySet<ContentPackId>, limit = 24): ItemKit[] {
  const candidates: ItemKit[] = [];
  for (const def of BUILDING_CATALOG) {
    if (def.category !== '小物品' && def.category !== '装饰' && def.category !== '植物') continue;
    if (!enabledPacks.has(packOfCategory(def.category).id)) continue;
    const longest = Math.max(def.size[0], def.size[1], def.size[2]);
    if (longest > 0.6 || longest <= 0.02) continue;
    if (def.stackable === false) continue;
    candidates.push({ defId: def.id, size: def.size, preferSurface: def.size[1] <= 0.3 });
  }
  // 取前 limit 个（目录顺序已经按分类聚在一起，取前面的是"最典型的小物品"）
  return candidates.slice(0, limit);
}

/**
 * 把模板 + 可选覆盖合成一套生成参数。
 *
 * `overrides` 是玩家在面板上拖的滑块 —— 它**覆盖**模板值，而不是相乘。
 * 这一点与"模板参数是倍率"不冲突：模板给的是倍率的默认值，玩家调的是最终倍率。
 */
export function buildGenerationParams(
  templateId: string,
  overrides: Partial<MapTemplateParams> = {},
  seedOverride?: number,
): GenerationParams | null {
  const template = getMapTemplate(templateId);
  if (!template) return null;
  const params: MapTemplateParams = { ...template.params, ...overrides };
  // 越界一律夹回范围（面板的滑块本来就在范围内，但存档与 URL 参数可能不是）
  for (const [key, limit] of Object.entries(TEMPLATE_PARAM_LIMITS)) {
    const value = params[key as keyof MapTemplateParams] as number;
    if (!Number.isFinite(value)) continue;
    (params as unknown as Record<string, number>)[key] = Math.min(limit.max, Math.max(limit.min, value));
  }
  const seed = seedOverride ?? params.seed;

  // 地形基准参数：**取世界档的完整 preset**，只换 seed。
  //
  // ── 这里踩过一次坑，写下来防止再犯 ──
  // 第一版我在这里写的是占位值 `minHeight: 1, maxHeight: 1, snowLine: 1`，
  // 想的是"反正 GenerationPipeline.terrainParamsWithRatios() 会用 preset 覆盖掉"。
  // 但它只覆盖 `amplitude` 与 `waterLevel`，其余原样透传 —— 而
  // `TerrainGenerator.generateHeightmap()` 会对每一列做 `clamp(h, minHeight, maxHeight)`，
  // 于是 min===max===1 把**所有**高度压成 1。
  // 后果：8 个模板生成出来全是"1 格高的平地 + 5 层海水"，地表全是沙，
  // 而且因为没有任何起伏，树/建筑/小物品的冲突检测也就全都测不出问题 —— 
  // 一个占位常量能让后面四五个阶段的断言全部"通过"。
  //
  // 教训：**"下游会覆盖"这种假设必须在下游代码里核对**。参数对象里不要放
  // 任何"显然会被改掉"的占位值 —— 一旦下游没改，它就是静默的错误数据，
  // 而不是报错。
  const preset = getWorldSize(params.size);
  const terrain: TerrainParams = {
    ...preset.terrain,
    // 种子必须与本次生成一致，否则地形噪声与物体摆放用的是两套随机
    seed,
    // waterLevel / amplitude 由 pipeline 依据「水体比例」「山地比例」重算，
    // 这里保留 preset 值只是为了对象完整（TerrainParams 的字段都是必填）
  };
  return {
    seed,
    size: params.size,
    terrain,
    treeDensity: params.treeDensity,
    buildingDensity: params.buildingDensity,
    itemDensity: params.itemDensity,
    mountainRatio: params.heightScale,
    waterRatio: params.waterRatio,
  };
}

/** 判断某个体素能不能长东西 / 是不是水（流水线的 PlacementWorld 与 TerrainParams 都要） */
export function buildPlacementWorld(): Pick<PlacementWorld, 'isAllowedSurface' | 'isWater'> {
  const grass = getVoxelId('grass');
  const dirt = getVoxelId('dirt');
  const snow = getVoxelId('snow');
  const water = getVoxelId('water');
  return {
    // 树只长在草/泥/雪上：沙地（沙漠）不长树是刻意的，靠 forbidSand 再挡一层
    isAllowedSurface: (id) => id === grass || id === dirt || id === snow,
    isWater: (id) => id === water,
  };
}

/** 面板用：一行中文摘要 */
export function describeGenerationContent(templateId: string): string {
  const template = getMapTemplate(templateId);
  if (!template) return `找不到模板：${templateId}`;
  const enabled = loadEnabledPacks();
  const specs = buildNatureSpecs(template, enabled);
  const items = buildItemKit(enabled);
  const kit = buildBuildingKit(enabled);
  return (
    `生成内容（${template.name}）：自然物 ${specs.length} 种（树密度 ×${template.params.treeDensity.toFixed(2)}）｜` +
    `建筑套件 ${kit ? '可用' : '不可用（结构包被关）'}｜小物品候选 ${items.length} 个｜` +
    `内容包 ${enabled.size}/${CONTENT_PACKS.length} 启用`
  );
}
