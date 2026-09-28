import type { BuildingDef } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import type { StackContext, StackResult, StackSystem } from '../physics/StackSystem';
import type { StackAxis, AlignMode } from '../building/StackingSystem';
import { aabbOfDef } from '../physics/CollisionDetect';
import { findAnchorMatches } from './SnapPoints';

/** 候选点来源 */
export type PlacementSource =
  | 'surface'
  | 'anchor'
  | 'row'
  | 'wall'
  | 'ground'
  | 'grid'
  | 'free';

export interface PlacementCandidate {
  position: [number, number, number];
  rotation: [number, number, number];
  score: number;
  source: PlacementSource;
  label: string;
  valid: boolean;
  reason?: string;
  stack: StackResult;
}

export interface SmartPlacementResult {
  position: [number, number, number];
  rotation: [number, number, number];
  valid: boolean;
  reason?: string;
  candidates: Array<{
    position: [number, number, number];
    rotation: [number, number, number];
    score: number;
    source: PlacementSource;
    label: string;
    valid: boolean;
    reason?: string;
  }>;
}

export interface SmartPlacementOptions {
  snapToGrid: boolean;
  snapStep: number;
  rotationDegrees: number;
  allowAnchors: boolean;
  allowSurface: boolean;
  allowWall: boolean;
  maxCandidates: number;
  /** 支撑面上划分成几×几的小网格（需求：桌面划成 4×4 小格） */
  surfaceGrid?: number;
  /** 堆叠方向：Y = 叠罗汉，X/Z = 排成一堵墙 */
  axis?: StackAxis;
  /** 对齐方式：center = 居中，free = 自由偏移（Alt），nearest = 吸附最近物体（Ctrl） */
  align?: AlignMode;
}

export type SmartPlacementContext = StackContext;

/** 各来源的基础分 */
const SOURCE_BONUS: Record<PlacementSource, number> = {
  surface: 30,
  anchor: 24,
  row: 22,
  wall: 22,
  ground: 14,
  grid: 6,
  free: 0,
};

const SOURCE_LABELS: Record<PlacementSource, string> = {
  surface: '支撑面',
  anchor: '堆叠',
  row: '排列',
  wall: '贴墙',
  ground: '地面',
  grid: '网格',
  free: '空中',
};

const DEDUPE_DISTANCE = 0.1;

/**
 * 智能放置建议。
 *
 * M2.5 的两处关键改动（对应问题 1 与问题 2）：
 *
 * 1. **所有候选都过一遍 StackingSystem.resolve**：落点不再由"锚点坐标"直接决定，
 *    而是"贴到下方最高的支撑面上"。于是叠罗汉是默认行为，
 *    也不会再出现"按地面高度放下去、结果和已有物体重叠"的情况。
 * 2. **支撑面上生成小网格候选**（`surface` 来源）：这是"一个接触面能放多个物体"的核心 ——
 *    之前的锚点永远指向顶面中心，所以同一张桌子上只能放同一个位置的东西，
 *    第二个必然与第一个重叠而被拒绝。现在把顶面按 4×4（可调）划格，
 *    每个空闲格子都是一个候选点，桌面上就能整齐地摆一排杯子。
 *
 * 耗时也顺带压下来了：M2 用 Rapier 形状查询逐个候选点真检，
 * 200 个物体时 31.8 ms；现在纯 AABB 计算，同场景降到个位数毫秒。
 */
export class SmartPlacement {
  private lastMs = 0;
  private lastCandidateCount = 0;

  constructor(private readonly stackSystem: StackSystem) {}

  get elapsedMs(): number {
    return this.lastMs;
  }

  get candidateCount(): number {
    return this.lastCandidateCount;
  }

  /** 底层堆叠系统（Engine 想直接调 resolve/analyze 时用） */
  get stacking() {
    return this.stackSystem.core;
  }

  suggest(
    def: BuildingDef,
    cursor: [number, number, number],
    surfaceY: number,
    options: SmartPlacementOptions,
    context: SmartPlacementContext,
  ): SmartPlacementResult {
    const started = performance.now();
    const { buildings, surfaces } = context;
    const intendedRotation = (options.rotationDegrees * Math.PI) / 180;
    const align = options.align ?? 'center';
    const axis = options.axis ?? 'y';
    const gridSize = Math.max(1, Math.min(options.surfaceGrid ?? 4, 8));

    interface Raw {
      position: [number, number, number];
      rotationY: number;
      source: PlacementSource;
      label: string;
      supportId?: number;
    }
    const raw: Raw[] = [];

    // ---------------------------------------------------------------- 支撑面小网格
    //
    // 本轮修复的重点：把一个顶面划成 gridSize×gridSize 个格子，
    // 每个空格子都是一个候选点 —— "一个接触面放多个物体"自然成立。
    if (options.allowSurface) {
      const probe = aabbOfDef(def, [cursor[0], surfaceY, cursor[2]], intendedRotation);
      const nearby = surfaces.surfacesUnder(probe, surfaceY + 0.12, 4);

      for (const surface of nearby) {
        const width = surface.maxX - surface.minX;
        const depth = surface.maxZ - surface.minZ;
        if (width <= 0.05 || depth <= 0.05) continue;

        const cellW = width / gridSize;
        const cellD = depth / gridSize;
        const reach = Math.max(width, depth) * 0.9;

        for (let ix = 0; ix < gridSize; ix++) {
          for (let iz = 0; iz < gridSize; iz++) {
            const x = surface.minX + cellW * (ix + 0.5);
            const z = surface.minZ + cellD * (iz + 0.5);
            if (Math.hypot(x - cursor[0], z - cursor[2]) > reach) continue;
            raw.push({
              position: [x, surface.topY, z],
              rotationY: intendedRotation,
              source: 'surface',
              label: `放在 #${surface.objectId} 顶面（${ix + 1},${iz + 1}）`,
              supportId: surface.objectId,
            });
          }
        }
      }
    }

    // ---------------------------------------------------------------- 地面
    if (options.allowSurface) {
      raw.push({
        position: [cursor[0], surfaceY, cursor[2]],
        rotationY: intendedRotation,
        source: 'ground',
        label: '贴地放置',
      });
    }

    // ---------------------------------------------------------------- 网格吸附
    if (options.snapToGrid) {
      const step = Math.max(0.25, options.snapStep);
      raw.push({
        position: [Math.round(cursor[0] / step) * step, surfaceY, Math.round(cursor[2] / step) * step],
        rotationY: intendedRotation,
        source: 'grid',
        label: `网格吸附 ${step} m`,
      });
    }

    // ---------------------------------------------------------------- 空中
    raw.push({
      position: [cursor[0], Math.max(surfaceY, cursor[1]), cursor[2]],
      rotationY: intendedRotation,
      source: 'free',
      label: '按光标高度放置（悬空会掉）',
    });

    // ---------------------------------------------------------------- 沿轴排列（成墙）
    if (axis !== 'y') {
      const reference = this.stackSystem.core.nearestObject(cursor, context, 4);
      if (reference) {
        const next = this.stackSystem.core.nextAlongAxis(def, reference, axis, context);
        if (next) {
          raw.push({
            position: next,
            rotationY: reference.rotationY,
            source: 'row',
            label: `沿 ${axis.toUpperCase()} 轴接着 #${reference.id} 排`,
          });
        }
      }
    }

    // ---------------------------------------------------------------- 吸附点
    if (options.allowAnchors) {
      const matches = findAnchorMatches(def, intendedRotation, cursor, buildings.all, 6, 6);
      for (const match of matches) {
        raw.push({
          position: match.position,
          rotationY: match.rotationY,
          source: 'anchor',
          label: match.label,
        });
      }
    }

    // ---------------------------------------------------------------- 贴墙（门窗）
    if (options.allowWall && isOpening(def)) {
      const wall = this.findNearbyWall(cursor, buildings.all, 8);
      if (wall && wall.size) {
        const nx = Math.sin(wall.rotationY);
        const nz = Math.cos(wall.rotationY);
        const toward = (cursor[0] - wall.position[0]) * nx + (cursor[2] - wall.position[2]) * nz;
        const side = toward >= 0 ? 1 : -1;
        const offset = wall.size[2] / 2 + 0.015;
        raw.push({
          position: [
            wall.position[0] + nx * side * offset,
            wall.position[1],
            wall.position[2] + nz * side * offset,
          ],
          rotationY: wall.rotationY,
          source: 'wall',
          label: `贴到 ${wall.name ?? wall.defId} 墙面`,
        });
      }
    }

    // ---------------------------------------------------------------- 去重
    //
    // 排序策略：来源权重优先，同权重时取离光标近的。
    // 这样"支撑面上离光标最近的那个格子"会被优先保留。
    raw.sort((a, b) => {
      const bonusDiff = SOURCE_BONUS[b.source] - SOURCE_BONUS[a.source];
      if (Math.abs(bonusDiff) > 4) return bonusDiff;
      return distanceTo(a.position, cursor) - distanceTo(b.position, cursor);
    });

    const deduped: Raw[] = [];
    for (const candidate of raw) {
      if (deduped.some((kept) => distanceTo(kept.position, candidate.position) < DEDUPE_DISTANCE)) continue;
      deduped.push(candidate);
    }

    // 支撑面网格可能产生上百个候选，但玩家只关心光标附近那几个 —— 只真检前 N 个
    const evaluated = deduped.slice(0, Math.max(4, options.maxCandidates) + 8);

    // ---------------------------------------------------------------- 逐个解析落点
    const candidates: PlacementCandidate[] = [];
    for (const candidate of evaluated) {
      let position = candidate.position;

      // 居中堆叠：只在光标已经很接近支撑物中心时才强行居中，
      // 否则玩家想放在桌面边缘时会被硬拉回中心，反而更难用
      if (align === 'center' && candidate.supportId !== undefined) {
        const supporter = buildings.findById(candidate.supportId);
        if (supporter) {
          const dx = cursor[0] - supporter.position[0];
          const dz = cursor[2] - supporter.position[2];
          const half = Math.max((supporter.size?.[0] ?? 1) / 2, (supporter.size?.[2] ?? 1) / 2);
          if (Math.hypot(dx, dz) < half * 0.6) {
            position = [supporter.position[0], position[1], supporter.position[2]];
          }
        }
      }

      const resolution = this.stackSystem.core.resolve(def, position, candidate.rotationY, context, {
        autoLift: true,
        maxLift: 3,
        allowFloating: true,
      });

      const stack: StackResult = {
        supported: resolution.valid && resolution.supportArea > 0,
        supportId: resolution.supportId < 0 ? 'terrain' : String(resolution.supportId),
        layer: resolution.layer,
        stability: resolution.stability,
        contactRatio: resolution.contactRatio,
        centerMargin: resolution.contactRect
          ? Math.min(
              resolution.position[0] - resolution.contactRect.minX,
              resolution.contactRect.maxX - resolution.position[0],
              resolution.position[2] - resolution.contactRect.minZ,
              resolution.contactRect.maxZ - resolution.position[2],
            )
          : -Infinity,
        reason: resolution.reason,
        gap: Math.max(0, resolution.supportTopY - position[1]),
      };

      let score = 50 + SOURCE_BONUS[candidate.source];
      if (!resolution.valid) {
        score *= 0.12;
      } else {
        score += resolution.contactRatio * 30;
        if (resolution.stability === 'stable') score += 16;
        else if (resolution.stability === 'critical') score += 4;
        else score -= 18;
        if (resolution.layer > 20) score -= 8;
      }

      const distToCursor = distanceTo(resolution.position, cursor);
      score -= Math.min(34, distToCursor * 4);
      if (Math.abs(candidate.rotationY - intendedRotation) < 1e-3) score += 8;
      // 自动上移过的候选点要扣分，否则玩家会觉得"它怎么自己飞上去了"
      score -= resolution.liftedLayers * 6;

      candidates.push({
        position: resolution.position,
        rotation: [0, candidate.rotationY, 0],
        score,
        source: candidate.source,
        label: `${SOURCE_LABELS[candidate.source]} · ${candidate.label}｜第 ${resolution.layer} 层`,
        valid: resolution.valid,
        reason: resolution.valid ? undefined : resolution.reason,
        stack,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const limited = candidates.slice(0, Math.max(1, options.maxCandidates));

    this.lastMs = performance.now() - started;
    this.lastCandidateCount = limited.length;

    const best = limited[0];
    if (!best) {
      return {
        position: [cursor[0], surfaceY, cursor[2]],
        rotation: [0, intendedRotation, 0],
        valid: false,
        reason: '附近没有合适的落点',
        candidates: [],
      };
    }

    return {
      position: best.position,
      rotation: best.rotation,
      valid: best.valid,
      reason: best.valid ? undefined : best.reason,
      candidates: limited.map((candidate) => ({
        position: candidate.position,
        rotation: candidate.rotation,
        score: Math.round(candidate.score),
        source: candidate.source,
        label: candidate.label,
        valid: candidate.valid,
        reason: candidate.reason,
      })),
    };
  }

  /** 找光标附近最近的"薄板结构"，用于门窗贴墙 */
  private findNearbyWall(
    cursor: [number, number, number],
    buildings: BuildingSystem['all'],
    radius: number,
  ) {
    let best: (typeof buildings)[number] | null = null;
    let bestDistance = radius;
    for (const instance of buildings) {
      if (!instance.size) continue;
      if (!looksLikeWall(instance)) continue;
      const distance = Math.hypot(
        instance.position[0] - cursor[0],
        instance.position[1] - cursor[1],
        instance.position[2] - cursor[2],
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = instance;
      }
    }
    return best;
  }
}

function distanceTo(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 门窗类物件（按分类与标签判断，不写死 id 列表） */
function isOpening(def: BuildingDef): boolean {
  return def.category === '门窗' || def.tags.some((tag) => tag.includes('门') || tag.includes('窗'));
}

/** 看起来像墙：某个水平方向很薄、且有一定高度 */
function looksLikeWall(instance: { size?: [number, number, number] }): boolean {
  const size = instance.size;
  if (!size) return false;
  const thinX = size[0] < 0.9 && size[2] > size[0];
  const thinZ = size[2] < 0.9 && size[0] > size[2];
  return (thinX || thinZ) && size[1] >= 1.5;
}
