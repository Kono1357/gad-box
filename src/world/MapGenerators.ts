import { WORLD_CONFIG } from '../config';
import { getVoxelId } from '../data/voxelTypes';
import type { MapDefinition } from '../data/maps';
import { getWorldSize } from '../worldSize';
import { mulberry32 } from '../core/random';
import {
  MapPlanner,
  createEmptyReport,
  type MapGenerationReport,
} from './MapPlanner';
import type { VoxelGrid } from '../voxel/VoxelGrid';
import {
  fillFromHeightmap,
  generateHeightmap,
  GridWriter,
  makeFbm,
  makeValueNoise,
  placeSlab,
  plantTree,
  shapeColumn,
  type TerrainParams,
} from '../voxel/TerrainGenerator';

/** 地图生成时顺带摆好的建筑（由 Engine 交给 BuildingSystem 落地） */
export interface MapBuildingPlacement {
  defId: string;
  /** 底面中心的世界坐标（米） */
  position: [number, number, number];
  rotationY: number;
}

export interface MapBuildResult {
  buildings: MapBuildingPlacement[];
  /** 生成耗时（毫秒） */
  ms: number;
  /**
   * 生成报告（问题 3.5：输出"清除多少树、跳过多少树、新建多少建筑"）。
   * 有重叠被修掉时 `overlapsFixed > 0`。
   */
  report: MapGenerationReport;
}

/** 把体素坐标的列中心转成世界坐标 */
function worldX(grid: VoxelGrid, vx: number): number {
  return vx - grid.halfX + 0.5;
}

function worldZ(grid: VoxelGrid, vz: number): number {
  return vz - grid.halfZ + 0.5;
}

/** 某列地表顶部（世界 Y，米），没有地形返回 0 */
function groundY(grid: VoxelGrid, vx: number, vz: number): number {
  const h = grid.solidSurfaceHeight(vx, vz);
  return h < 0 ? 0 : h + 1;
}

/** 基础地形参数（从世界尺寸档位取，再按地图微调） */
function baseParams(map: MapDefinition, overrides: Partial<TerrainParams> = {}): TerrainParams {
  const preset = getWorldSize(map.size);
  return {
    seed: map.seed,
    waterLevel: preset.terrain.waterLevel,
    baseHeight: preset.terrain.baseHeight,
    amplitude: preset.terrain.amplitude,
    minHeight: preset.terrain.minHeight,
    maxHeight: preset.terrain.maxHeight,
    snowLine: preset.terrain.snowLine,
    noiseScale: preset.terrain.noiseScale,
    ...overrides,
  };
}

/**
 * 参考地图生成器。
 *
 * 每张地图都复用 `TerrainGenerator` 的底层步骤（高度图 → 分层 → 灌水），
 * 再叠加自己的"雕刻"。所有随机数都来自 `mulberry32(map.seed)`，
 * 所以同一张地图每次生成的结果完全一致 —— 玩家改坏了可以重新载入复原。
 */
export class MapGenerators {
  static build(grid: VoxelGrid, map: MapDefinition): MapBuildResult {
    const started = performance.now();
    const report = createEmptyReport();
    const planner = new MapPlanner(grid, report);
    let buildings: MapBuildingPlacement[] = [];

    switch (map.id) {
      case 'valley_village':
        buildings = this.valleyVillage(grid, map, planner);
        break;
      case 'desert_oasis':
        buildings = this.desertOasis(grid, map, planner);
        break;
      case 'castle_hill':
        buildings = this.castleHill(grid, map, planner);
        break;
      case 'novice_island':
      default:
        buildings = this.noviceIsland(grid, map, planner);
        break;
    }

    report.buildingsPlaced = buildings.length;
    report.ms = performance.now() - started;
    report.log.unshift(
      `生成完成：自然物体 ${report.naturePlaced} 个（跳过 ${report.natureSkipped}）｜` +
        `清冲突 ${report.natureCleared} 处｜建筑 ${report.buildingsPlaced} 个｜耗时 ${report.ms.toFixed(0)} ms`,
    );
    return { buildings, ms: report.ms, report };
  }

  // ------------------------------------------------------------------ 新手岛

  private static noviceIsland(
    grid: VoxelGrid,
    map: MapDefinition,
    planner: MapPlanner,
  ): MapBuildingPlacement[] {
    const params = baseParams(map, { waterLevel: 6, baseHeight: 8, amplitude: 8, sharpness: 0.3 });
    const writer = new GridWriter(grid);
    const heights = generateHeightmap(grid, params);

    // 径向衰减：越靠边越低，最终沉到水下 → 变成一座环水的岛
    const cx = (grid.sizeX - 1) / 2;
    const cz = (grid.sizeZ - 1) / 2;
    const maxRadius = Math.min(grid.sizeX, grid.sizeZ) / 2;
    const waterFloor = params.waterLevel - 3;

    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const d = Math.hypot(x - cx, z - cz) / maxRadius;
        // 0.55 以内是完整陆地，0.95 之外完全沉入水下
        const t = Math.max(0, Math.min(1, (d - 0.5) / 0.45));
        const mask = 1 - t * t * (3 - 2 * t);
        const inland = heights[z * grid.sizeX + x]!;
        heights[z * grid.sizeX + x] = Math.round(waterFloor + (inland - waterFloor) * mask);
      }
    }

    fillFromHeightmap(grid, writer, heights, params);

    const rand = mulberry32(map.seed ^ 0x5a5a);

    // 中央加一座缓坡山
    const hillTop = Math.min(params.maxHeight - 1, params.waterLevel + 7);
    for (let dz = -9; dz <= 9; dz++) {
      for (let dx = -9; dx <= 9; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > 9) continue;
        const h = Math.round(hillTop - (d / 9) * (hillTop - params.waterLevel - 2));
        shapeColumn(writer, grid, Math.round(cx) + dx, Math.round(cz) + dz, h, getVoxelId('grass'), 3);
      }
    }
    // 山顶铺雪，用来展示材质区分
    placeSlab(writer, grid, Math.round(cx), Math.round(cz), 3, hillTop, getVoxelId('snow'));
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        if (grid.surfaceHeight(x, z) >= params.snowLine) writer.set(x, grid.surfaceHeight(x, z), z, getVoxelId('snow'));
      }
    }

    // ------------------------------------------------ 第三步：自然物体
    // 植树改成"先问规划器能不能种" —— 不满足条件就跳过，而不是种了再删。
    // 新手岛没有建筑，所以规划区为空，但间距/水边/悬崖规则照样生效。
    const treeAttempts = Math.round((grid.sizeX * grid.sizeZ) / 22);
    const hillGuard = Math.round(Math.min(grid.sizeX, grid.sizeZ) * 0.22);
    for (let i = 0; i < treeAttempts; i++) {
      const x = Math.floor(rand() * grid.sizeX);
      const z = Math.floor(rand() * grid.sizeZ);
      if (Math.hypot(x - cx, z - cz) < hillGuard) continue;

      const verdict = planner.canPlaceNature(x, z, 1.6, {
        minSpacing: 2.4,
        forbidSand: true,
      });
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      const h = grid.solidSurfaceHeight(x, z);
      if (h < 0 || h <= params.waterLevel + 1) {
        planner.skipNature('水位以下');
        continue;
      }
      plantTree(writer, grid, x, z, rand, { kind: rand() < 0.3 ? 'pine' : 'oak' });
      planner.registerNature(x, z, 1.6, 'tree');
    }

    // 第四步：没有规划区，跳过清理；第五步：没有建筑
    planner.clearNatureInPlots(writer);
    planner.validateBuildings([], writer);
    planner.countFloating([]);

    writer.finish();
    return [];
  }

  // ------------------------------------------------------------------ 山谷村落

  private static valleyVillage(
    grid: VoxelGrid,
    map: MapDefinition,
    planner: MapPlanner,
  ): MapBuildingPlacement[] {
    // M2.5：标准档变小了（96×24×96），参数按新尺寸重调，避免山谷顶到世界天花板
    const params = baseParams(map, { waterLevel: 7, baseHeight: 12, amplitude: 8, sharpness: 0.4 });
    const writer = new GridWriter(grid);
    const heights = generateHeightmap(grid, params);

    const midZ = (grid.sizeZ - 1) / 2;
    const valleyHalfWidth = grid.sizeZ * 0.16;

    // 沿 Z 方向切出一条山谷，并让谷底略微起伏
    const noise = makeValueNoise(map.seed ^ 0x1234);
    const river = makeFbm(noise, 1 / 60, 2);
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const index = z * grid.sizeX + x;
        const distance = Math.abs(z - midZ);
        // 谷底：中心最低，向两侧抬升
        const t = Math.max(0, Math.min(1, (distance - valleyHalfWidth) / (grid.sizeZ * 0.3)));
        const ridge = t * t * (3 - 2 * t);
        const floor = params.waterLevel + 1 + Math.round(river(x, z) * 2);
        const original = heights[index]!;
        heights[index] = Math.round(floor + (original - floor) * ridge);
      }
    }

    fillFromHeightmap(grid, writer, heights, params);

    // 河道：谷底再压低一点并灌水，形成一条弯弯的河
    const riverLevel = params.waterLevel + 1;
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const bend = Math.sin(z * 0.06) * 6;
        const distance = Math.abs(x - (grid.sizeX / 2 + bend));
        if (distance > 3.5) continue;
        shapeColumn(writer, grid, x, z, riverLevel - 2, getVoxelId('mud'), 2);
        for (let y = riverLevel - 1; y <= riverLevel; y++) writer.setWater(x, y, z, 1);
        // 河岸铺沙
        if (distance > 2.5) {
          const h = grid.solidSurfaceHeight(x, z);
          if (h >= 0) writer.set(x, h, z, getVoxelId('sand'));
        }
      }
    }

    const rand = mulberry32(map.seed ^ 0x9999);

    // ------------------------------------------------ 第四步（提前）：先定建筑规划区
    //
    // 顺序很关键：**规划区必须在种树之前定好**，
    // 这样第三步种树时就能避开村子，而不是"种满了再一刀切推平"。
    const houseSpots: Array<{ vx: number; vz: number; rotation: number }> = [];
    for (let attempt = 0; attempt < 400 && houseSpots.length < 4; attempt++) {
      const x = 10 + Math.floor(rand() * (grid.sizeX - 20));
      const z = 10 + Math.floor(rand() * (grid.sizeZ - 20));
      const h = grid.solidSurfaceHeight(x, z);
      if (h < 0) continue;
      if (Math.abs(x - grid.sizeX / 2) < 10) continue; // 让开河道

      // 一块 9×9 是否够平（房屋占地 4×4，留出余量）
      let flat = true;
      for (let dz = -4; dz <= 4 && flat; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nh = grid.solidSurfaceHeight(x + dx, z + dz);
          if (nh < 0 || Math.abs(nh - h) > 1) {
            flat = false;
            break;
          }
        }
      }
      if (!flat) continue;
      if (houseSpots.some((spot) => Math.hypot(spot.vx - x, spot.vz - z) < 16)) continue;
      houseSpots.push({ vx: x, vz: z, rotation: (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.2 });
    }

    for (const spot of houseSpots) {
      const wx = worldX(grid, spot.vx);
      const wz = worldZ(grid, spot.vz);
      planner.addPlot({
        minX: wx - 5,
        maxX: wx + 5,
        minZ: wz - 5,
        maxZ: wz + 5,
        label: `山谷村落 · 木屋 @(${wx.toFixed(0)}, ${wz.toFixed(0)})`,
      });
    }

    // ------------------------------------------------ 第三步：自然物体（避开规划区）
    const treeAttempts = Math.round((grid.sizeX * grid.sizeZ) / 26);
    for (let i = 0; i < treeAttempts; i++) {
      const x = Math.floor(rand() * grid.sizeX);
      const z = Math.floor(rand() * grid.sizeZ);
      if (Math.abs(x - grid.sizeX / 2) < 8) {
        planner.skipNature('河道');
        continue;
      }
      const verdict = planner.canPlaceNature(x, z, 1.6, { minSpacing: 2.6 });
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      const h = grid.solidSurfaceHeight(x, z);
      if (h < 0 || h <= params.waterLevel + 2) {
        planner.skipNature('水位以下');
        continue;
      }
      if (grid.getVoxel(x, h, z) !== getVoxelId('grass')) {
        planner.skipNature('不是草地');
        continue;
      }
      plantTree(writer, grid, x, z, rand, { kind: rand() < 0.3 ? 'pine' : 'oak' });
      planner.registerNature(x, z, 1.6, 'tree');
    }

    // 第四步兜底：规划区内万一还有自然物体就清掉（只删树叶/木头，地形不动）
    planner.clearNatureInPlots(writer);

    // ------------------------------------------------ 第五步：建筑
    const buildings: MapBuildingPlacement[] = [];
    const placedBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
    for (const spot of houseSpots) {
      const h = groundY(grid, spot.vx, spot.vz);
      const wx = worldX(grid, spot.vx);
      const wz = worldZ(grid, spot.vz);
      const verdict = planner.canPlaceBuilding(wx - 3, wx + 3, wz - 3, wz + 3, [], 2.5);
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      // 房屋之间保持最小间距（用包围盒而不是中心点）
      if (
        placedBoxes.some(
          (box) => wx - 3 < box.maxX + 2 && wx + 3 > box.minX - 2 && wz - 3 < box.maxZ + 2 && wz + 3 > box.minZ - 2,
        )
      ) {
        continue;
      }
      placedBoxes.push({ minX: wx - 3, maxX: wx + 3, minZ: wz - 3, maxZ: wz + 3 });
      buildings.push(...this.makeHouse(wx, wz, h, spot.rotation));
    }

    writer.finish();
    return buildings;
  }

  /** 用建筑模型拼一栋 4×4 的小屋：地板 + 四面墙 + 门 + 屋顶 + 烟囱 */
  private static makeHouse(
    centerWorldX: number,
    centerWorldZ: number,
    groundHeight: number,
    rotationY: number,
  ): MapBuildingPlacement[] {
    const result: MapBuildingPlacement[] = [];
    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);

    /** 局部坐标（米，相对屋子中心）→ 世界坐标 */
    const place = (lx: number, lz: number, y: number, defId: string, extraRotation = 0): void => {
      result.push({
        defId,
        position: [
          centerWorldX + (lx * cos - lz * sin),
          y,
          centerWorldZ + (lx * sin + lz * cos),
        ],
        rotationY: rotationY + extraRotation,
      });
    };

    // 地板 4×4
    place(0, 0, groundHeight, 'floor_wood');
    // 四面墙（墙模型是 4 米宽 × 3 米高 × 0.4 米厚，原点在底面中心）
    place(0, -2, groundHeight, 'wall_stone');
    place(0, 2, groundHeight, 'wall_stone', Math.PI);
    place(-2, 0, groundHeight, 'wall_stone', Math.PI / 2);
    place(2, 0, groundHeight, 'wall_stone', -Math.PI / 2);
    // 门开在南面，窗户开在西面
    place(0, 2, groundHeight, 'door_wood', Math.PI);
    place(-2, 0, groundHeight, 'window_single', Math.PI / 2);
    // 屋顶与烟囱
    place(0, 0, groundHeight + 3, 'roof_tile');
    place(-1.5, -1.5, groundHeight + 3.6, 'pillar_stone');
    return result;
  }

  // ------------------------------------------------------------------ 沙漠绿洲

  private static desertOasis(
    grid: VoxelGrid,
    map: MapDefinition,
    planner: MapPlanner,
  ): MapBuildingPlacement[] {
    const params = baseParams(map, {
      waterLevel: 7,
      baseHeight: 10,
      amplitude: 3,
      sharpness: 0.2,
      minHeight: 5,
      fillWater: false,
      snowLine: 999,
    });
    const writer = new GridWriter(grid);
    const heights = generateHeightmap(grid, params);

    // 沙丘：在基础高度上叠一层规则的沙脊
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const index = z * grid.sizeX + x;
        const dune =
          Math.sin(x * 0.21 + z * 0.07) * 2.2 +
          Math.cos(z * 0.17 - x * 0.05) * 1.8 +
          Math.sin((x + z) * 0.09) * 1.2;
        heights[index] = Math.max(
          params.minHeight,
          Math.min(params.maxHeight, Math.round(heights[index]! + dune)),
        );
      }
    }

    const sand = getVoxelId('sand');
    // 整张地图先压成"沙 + 石头底"
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const h = heights[z * grid.sizeX + x]!;
        for (let y = 0; y <= h; y++) {
          writer.set(x, y, z, y === WORLD_CONFIG.bedrockY ? getVoxelId('stone') : y > h - 4 ? sand : getVoxelId('stone'));
        }
      }
    }

    // 绿洲：挖一个碗形凹坑，然后灌水（水被沙坑托住，正好演示"容器"）
    const oasisX = Math.round(grid.sizeX * 0.42);
    const oasisZ = Math.round(grid.sizeZ * 0.58);
    // 绿洲半径按世界尺寸缩放（标准档从 128 缩到 96，半径也跟着收）
    const oasisRadius = Math.max(6, Math.round(Math.min(grid.sizeX, grid.sizeZ) * 0.115));
    const oasisFloor = params.waterLevel - 2;
    for (let dz = -oasisRadius; dz <= oasisRadius; dz++) {
      for (let dx = -oasisRadius; dx <= oasisRadius; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > oasisRadius) continue;
        const t = d / oasisRadius;
        const target = Math.round(oasisFloor + t * t * 6);
        shapeColumn(writer, grid, oasisX + dx, oasisZ + dz, target, sand, 2);
      }
    }
    for (let dz = -oasisRadius + 2; dz <= oasisRadius - 2; dz++) {
      for (let dx = -oasisRadius + 2; dx <= oasisRadius - 2; dx++) {
        if (Math.hypot(dx, dz) > oasisRadius - 2) continue;
        const x = oasisX + dx;
        const z = oasisZ + dz;
        const h = grid.solidSurfaceHeight(x, z);
        for (let y = h + 1; y <= params.waterLevel; y++) writer.setWater(x, y, z, 1);
        // 水边铺草地
        if (h <= params.waterLevel + 1) {
          const top = grid.solidSurfaceHeight(x, z);
          if (top >= 0) writer.set(x, top, z, getVoxelId('grass'));
        }
      }
    }

    const rand = mulberry32(map.seed ^ 0x7777);

    // ------------------------------------------------ 第三步：自然物体
    // 棕榈树围绕绿洲（沙地上允许，因为绿洲边就是沙）
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + rand() * 0.2;
      const r = oasisRadius + 1 + rand() * 4;
      const x = Math.round(oasisX + Math.cos(angle) * r);
      const z = Math.round(oasisZ + Math.sin(angle) * r);
      const verdict = planner.canPlaceNature(x, z, 1.4, { minSpacing: 2.0, forbidSand: false });
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      if (grid.solidSurfaceHeight(x, z) <= params.waterLevel) {
        planner.skipNature('在水里');
        continue;
      }
      plantTree(writer, grid, x, z, rand, { kind: 'palm', trunkHeight: 4 + Math.floor(rand() * 3) });
      planner.registerNature(x, z, 1.4, 'palm');
    }

    // 仙人掌散布到沙丘上（沙地允许）
    const cactus = getVoxelId('cactus');
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(rand() * grid.sizeX);
      const z = Math.floor(rand() * grid.sizeZ);
      if (Math.hypot(x - oasisX, z - oasisZ) < oasisRadius + 5) {
        planner.skipNature('绿洲区太湿');
        continue;
      }
      const verdict = planner.canPlaceNature(x, z, 0.6, { minSpacing: 1.8, forbidSand: false });
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      const h = grid.solidSurfaceHeight(x, z);
      if (h < 0 || grid.getVoxel(x, h, z) !== sand) {
        planner.skipNature('不是沙地');
        continue;
      }
      const height = 2 + Math.floor(rand() * 3);
      for (let y = 1; y <= height; y++) writer.set(x, h + y, z, cactus);
      if (rand() < 0.5) {
        writer.set(x + 1, h + height - 1, z, cactus);
        writer.set(x - 1, h + height - 1, z, cactus);
      }
      planner.registerNature(x, z, 0.6, 'cactus');
    }

    // ------------------------------------------------ 第四步 + 第五步：营地
    const campX = oasisX - oasisRadius - 8;
    const campZ = oasisZ + oasisRadius + 4;
    const campY = groundY(grid, campX, campZ);
    planner.addPlot({
      minX: worldX(grid, campX) - 6,
      maxX: worldX(grid, campX) + 6,
      minZ: worldZ(grid, campZ) - 6,
      maxZ: worldZ(grid, campZ) + 6,
      label: '沙漠绿洲 · 营地',
    });
    planner.clearNatureInPlots(writer);
    placeSlab(writer, grid, campX, campZ, 4, campY - 1, getVoxelId('marble'));

    const buildings: MapBuildingPlacement[] = [
      { defId: 'fountain', position: [worldX(grid, campX), campY, worldZ(grid, campZ)], rotationY: 0 },
      { defId: 'potted_plant', position: [worldX(grid, campX + 3), campY, worldZ(grid, campZ - 2)], rotationY: 0.4 },
      { defId: 'flag', position: [worldX(grid, campX - 3), campY, worldZ(grid, campZ + 2)], rotationY: -0.3 },
    ];

    writer.finish();
    return buildings;
  }

  // ------------------------------------------------------------------ 城堡山

  private static castleHill(
    grid: VoxelGrid,
    map: MapDefinition,
    planner: MapPlanner,
  ): MapBuildingPlacement[] {
    const params = baseParams(map, { waterLevel: 7, baseHeight: 11, amplitude: 9, sharpness: 0.5 });
    const writer = new GridWriter(grid);
    const heights = generateHeightmap(grid, params);

    const cx = Math.round(grid.sizeX / 2);
    const cz = Math.round(grid.sizeZ / 2);
    // 高台留出至少 4 米空间给城墙与角楼旗子，不能顶到世界天花板
    const plateauY = Math.min(params.maxHeight - 5, params.waterLevel + 10);
    const hillRadius = Math.round(Math.min(grid.sizeX, grid.sizeZ) * 0.32);

    // 把中央推成一座平顶山：外圈缓、接近山顶时变陡，顶上留一块平台
    for (let z = 0; z < grid.sizeZ; z++) {
      for (let x = 0; x < grid.sizeX; x++) {
        const d = Math.hypot(x - cx, z - cz);
        const index = z * grid.sizeX + x;
        if (d > hillRadius) continue;
        const t = d / hillRadius;
        // 平台半径占比 0.35
        const rise = t < 0.35 ? 1 : 1 - Math.pow((t - 0.35) / 0.65, 1.6);
        const target = Math.round(params.waterLevel + 1 + rise * (plateauY - params.waterLevel - 1));
        heights[index] = Math.max(heights[index]!, target);
      }
    }
    fillFromHeightmap(grid, writer, heights, params);

    // 山顶平台：铺大理石
    placeSlab(writer, grid, cx, cz, 13, plateauY, getVoxelId('marble'), true);
    const marble = getVoxelId('marble');
    const cobble = getVoxelId('cobble');
    for (let dz = -13; dz <= 13; dz++) {
      for (let dx = -13; dx <= 13; dx++) {
        if (Math.hypot(dx, dz) > 13) continue;
        writer.set(cx + dx, plateauY, cz + dz, dx * dx + dz * dz > 100 ? cobble : marble);
      }
    }

    // 一条盘旋而上的登山阶梯（用体素砍出台阶，比堆建筑模型更稳）
    const stairSteps = 44;
    for (let step = 0; step < stairSteps; step++) {
      const angle = (step / stairSteps) * Math.PI * 2.2;
      const r = hillRadius * (1 - step / (stairSteps * 1.15));
      const x = Math.round(cx + Math.cos(angle) * r);
      const z = Math.round(cz + Math.sin(angle) * r);
      const target = Math.round(params.waterLevel + 1 + (plateauY - params.waterLevel - 1) * (step / stairSteps));
      // 把这一格整平成一阶平台
      for (let dz2 = -1; dz2 <= 1; dz2++) {
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          shapeColumn(writer, grid, x + dx2, z + dz2, target, cobble, 2);
        }
      }
    }

    // ------------------------------------------------ 第四步（提前）：城堡规划区
    // 城墙半径 9 米、再加 4 米余量 → 山腰以上不留树，避免树穿过城墙
    const castleHalf = 14;
    planner.addPlot({
      minX: worldX(grid, cx - castleHalf),
      maxX: worldX(grid, cx + castleHalf),
      minZ: worldZ(grid, cz - castleHalf),
      maxZ: worldZ(grid, cz + castleHalf),
      label: '城堡山 · 城堡与阶梯',
    });
    planner.addPlot({
      minX: worldX(grid, cx - 3),
      maxX: worldX(grid, cx + 3),
      minZ: worldZ(grid, cz - 3),
      maxZ: worldZ(grid, cz + 3),
      label: '城堡山 · 山顶平台',
    });

    // ------------------------------------------------ 第三步：自然物体（避开城堡区）
    const rand = mulberry32(map.seed ^ 0xabcd);
    const treeAttempts = Math.round((grid.sizeX * grid.sizeZ) / 30);
    for (let i = 0; i < treeAttempts; i++) {
      const x = Math.floor(rand() * grid.sizeX);
      const z = Math.floor(rand() * grid.sizeZ);
      if (Math.hypot(x - cx, z - cz) < hillRadius * 0.85) {
        planner.skipNature('山坡太陡/城堡区');
        continue;
      }
      const verdict = planner.canPlaceNature(x, z, 1.6, { minSpacing: 2.6 });
      if (!verdict.ok) {
        planner.skipNature(verdict.reason);
        continue;
      }
      const h = grid.solidSurfaceHeight(x, z);
      if (h < 0 || h <= params.waterLevel + 1) {
        planner.skipNature('水位以下');
        continue;
      }
      if (grid.getVoxel(x, h, z) !== getVoxelId('grass')) {
        planner.skipNature('不是草地');
        continue;
      }
      plantTree(writer, grid, x, z, rand, { kind: rand() < 0.5 ? 'pine' : 'oak' });
      planner.registerNature(x, z, 1.6, 'tree');
    }

    // 第四步兜底清理
    planner.clearNatureInPlots(writer);

    // 城堡：四面城墙 + 四座角楼 + 一道门
    const buildings: MapBuildingPlacement[] = [];
    const wallY = plateauY + 1;
    const half = 9;

    // 南北两面沿 X 方向铺（rotation 0 / π），东西两面沿 Z 方向铺（rotation ±π/2）
    const sides: Array<{ rot: number; segments: Array<[number, number]> }> = [
      {
        // 北墙：z = -half，段沿 X 排开
        rot: 0,
        segments: [
          [cx - 4, cz - half],
          [cx, cz - half],
          [cx + 4, cz - half],
        ],
      },
      {
        // 南墙：z = +half，中间那段换成门框
        rot: Math.PI,
        segments: [
          [cx - 4, cz + half],
          [cx, cz + half],
          [cx + 4, cz + half],
        ],
      },
      {
        // 西墙：x = -half，段沿 Z 排开，需要转 90°
        rot: Math.PI / 2,
        segments: [
          [cx - half, cz - 4],
          [cx - half, cz],
          [cx - half, cz + 4],
        ],
      },
      {
        // 东墙
        rot: -Math.PI / 2,
        segments: [
          [cx + half, cz - 4],
          [cx + half, cz],
          [cx + half, cz + 4],
        ],
      },
    ];

    for (const side of sides) {
      side.segments.forEach(([vx, vz], index) => {
        const isGate = side.rot === Math.PI && index === 1;
        buildings.push({
          defId: isGate ? 'door_frame' : 'wall_stone',
          position: [worldX(grid, vx), wallY, worldZ(grid, vz)],
          rotationY: side.rot,
        });
      });
    }

    // 角楼 + 旗子
    for (const [sx, sz] of [
      [-half, -half],
      [half, -half],
      [-half, half],
      [half, half],
    ] as const) {
      buildings.push({
        defId: 'pillar_stone',
        position: [worldX(grid, cx + sx), wallY, worldZ(grid, cz + sz)],
        rotationY: 0,
      });
      buildings.push({
        defId: 'flag',
        position: [worldX(grid, cx + sx), wallY + 4, worldZ(grid, cz + sz)],
        rotationY: 0,
      });
    }

    // 城堡内院：地基、拱门、雕像、喷泉、上下台阶、施工道具
    const inner: Array<[string, number, number, number]> = [
      ['foundation_concrete', cx, cz, 0],
      ['pillar_stone', cx - 4, cz - 3, 0],
      ['pillar_stone', cx + 4, cz - 3, 0],
      ['arch_stone', cx, cz - 3, 0],
      ['sculpture', cx, cz + 4, 0.3],
      ['fountain', cx + 5, cz + 5, 0],
      ['stairs_stone', cx, cz + half - 1, Math.PI],
      ['crane', cx - 8, cz + 6, 0.6],
      ['scaffold', cx + 8, cz - 6, 0],
      ['lever', cx - 6, cz - 6, 0],
      ['light_block', cx + 2, cz - 2, 0],
      ['gear', cx - 2, cz + 6, 0],
    ];
    for (const [defId, vx, vz, rot] of inner) {
      buildings.push({
        defId,
        position: [worldX(grid, vx), wallY, worldZ(grid, vz)],
        rotationY: rot,
      });
    }

    writer.finish();
    return buildings;
  }
}
