/**
 * 碰撞体工厂 + 碰撞分组（M3 第 2 批，但地形碰撞体也要用它，所以先落地）。
 *
 * ────────────────────────────────────────────────────────────
 * 一、碰撞分组为什么必须有
 * ────────────────────────────────────────────────────────────
 * M2 里所有东西都在默认分组里，于是出现了三个真实问题：
 * 1. **触发区会把地形一直算成"里面有东西"** —— 因为地形的 AABB 压在触发盒上，
 *    所以门永远处于"有人经过"的状态；
 * 2. **水体的格子如果参与碰撞，会像砖头一样挡住物体**；
 * 3. **拿起物体时它和自己脚下的支撑面互相挤压**，产生抖动。
 *
 * 所以 M3 明确分成 5 层，并用一张**碰撞矩阵**说清谁跟谁作用：
 *
 * | 层 | 成员 | 作用对象 |
 * |---|---|---|
 * | `terrain` | 静态地形 | 建筑、物体 |
 * | `building` | 建筑与家具 | 地形、建筑、物体 |
 * | `object` | 可动小物件 / 载具 | 全部实体层 |
 * | `water` | 水（只做浮力，不参与碰撞求解） | **无**（靠 BuoyancySystem 施力） |
 * | `trigger` | 传感器 | 建筑、物体（只报事件，不产生碰撞响应） |
 *
 * 编码是 Rapier 的约定：**高 16 位 = 我属于哪些层，低 16 位 = 我跟哪些层作用**。
 *
 * ────────────────────────────────────────────────────────────
 * 二、形状的取舍（诚实说明）
 * ────────────────────────────────────────────────────────────
 * - `cuboid` / `ball` / `cylinder` / `capsule`：解析形状，最便宜，优先用。
 * - `convexHull`：从模型顶点集算凸包。**只对"凸的或近似凸的"模型准确** ——
 *   椅子、桌子这种带腿带洞的模型，凸包会把腿之间的空隙填满，
 *   于是"能从椅子底下钻过去"这件事就没了。所以本项目对带腿家具一律用**多个 cuboid 组合**，
 *   而不是一个凸包。这条是刻意的取舍，不是漏做。
 * - `trimesh`：逐三角形精确，但**只能静态**（Rapier 明确不支持动态三角网）。
 *   本项目的建筑几何本来就是少量三角形拼的，所以只在"静态的大型复杂模型"上用。
 * - 凸包退化（顶点共线 / 顶点数不足 4）时 `ColliderDesc.convexHull` 返回 `null`，
 *   这里会**自动回退成包围盒**并记录一次告警 —— 宁可粗略，也不能没有碰撞体。
 */

import type { PhysicsMaterial } from '../data/physicsMaterials';

/** 我们用到的 Rapier 形状子集（避免 import 4 MB 的 d.ts） */
export interface RapierColliderDesc {
  setTranslation(x: number, y: number, z: number): RapierColliderDesc;
  setRotation(rot: { x: number; y: number; z: number; w: number }): RapierColliderDesc;
  setDensity(density: number): RapierColliderDesc;
  setFriction(friction: number): RapierColliderDesc;
  setRestitution(restitution: number): RapierColliderDesc;
  setSensor(sensor: boolean): RapierColliderDesc;
  setCollisionGroups(groups: number): RapierColliderDesc;
  setSolverGroups(groups: number): RapierColliderDesc;
  setActiveEvents(events: number): RapierColliderDesc;
  setActiveCollisionTypes?(types: number): RapierColliderDesc;
}

export interface RapierColliderDescStatic {
  cuboid(hx: number, hy: number, hz: number): RapierColliderDesc;
  ball(radius: number): RapierColliderDesc;
  cylinder(halfHeight: number, radius: number): RapierColliderDesc;
  capsule(halfHeight: number, radius: number): RapierColliderDesc;
  convexHull(points: Float32Array): RapierColliderDesc | null;
  trimesh(vertices: Float32Array, indices: Uint32Array, flags?: number): RapierColliderDesc;
  heightfield(nrows: number, ncols: number, heights: Float32Array, scale: { x: number; y: number; z: number }, flags?: number): RapierColliderDesc;
}

// ------------------------------------------------------------------ 碰撞层

/** 5 个物理层 */
export const PHYSICS_LAYERS = ['terrain', 'building', 'object', 'water', 'trigger'] as const;
export type PhysicsLayer = (typeof PHYSICS_LAYERS)[number];

/** 层 → 位序号（0..4） */
export const LAYER_BIT: Record<PhysicsLayer, number> = {
  terrain: 0,
  building: 1,
  object: 2,
  water: 3,
  trigger: 4,
};

/**
 * 碰撞矩阵：`COLLISION_MATRIX[a]` 里包含的层表示 **a 会和它发生碰撞**。
 *
 * 注意这里写的是"会碰撞"，不是"会报事件"：
 * - `trigger` 层不产生碰撞响应（它是 sensor），它"作用"的对象由传感器事件负责；
 * - `water` 一行全是空的：水**不参与碰撞求解**，浮力由 `BuoyancySystem` 每帧施力实现。
 *   如果把水做成碰撞体，物体掉进水里会像撞到凝胶一样停住，那是错的。
 */
export const COLLISION_MATRIX: Record<PhysicsLayer, PhysicsLayer[]> = {
  terrain: ['building', 'object'],
  building: ['terrain', 'building', 'object', 'trigger'],
  object: ['terrain', 'building', 'object', 'trigger'],
  water: [],
  trigger: ['building', 'object'],
};

/** 生成 Rapier 的 InteractionGroups 值：高 16 位成员，低 16 位过滤器 */
export function interactionGroups(layer: PhysicsLayer, overrides?: PhysicsLayer[]): number {
  const memberships = 1 << LAYER_BIT[layer];
  const partners = overrides ?? COLLISION_MATRIX[layer];
  let filter = 0;
  for (const partner of partners) filter |= 1 << LAYER_BIT[partner];
  // 自己也必须在过滤器里，否则同一层的两个箱子不会互相碰撞
  if (partners.includes(layer)) filter |= memberships;
  return ((memberships & 0xffff) << 16) | (filter & 0xffff);
}

/** 反解：从 InteractionGroups 里读出成员层（调试面板显示用） */
export function layersOf(groups: number): { memberships: PhysicsLayer[]; filter: PhysicsLayer[] } {
  const membershipBits = (groups >>> 16) & 0xffff;
  const filterBits = groups & 0xffff;
  const read = (bits: number): PhysicsLayer[] =>
    PHYSICS_LAYERS.filter((layer) => (bits & (1 << LAYER_BIT[layer])) !== 0);
  return { memberships: read(membershipBits), filter: read(filterBits) };
}

/** 供面板显示：一行中文摘要 */
export function describeCollisionMatrix(): string[] {
  return PHYSICS_LAYERS.map((layer) => {
    const partners = COLLISION_MATRIX[layer];
    return `${layerLabel(layer)}：${
      partners.length === 0 ? '不与任何层碰撞（水靠浮力施力，触发器靠事件）' : partners.map(layerLabel).join('、')
    }`;
  });
}

export function layerLabel(layer: PhysicsLayer): string {
  switch (layer) {
    case 'terrain':
      return '地形';
    case 'building':
      return '建筑';
    case 'object':
      return '物体';
    case 'water':
      return '水体';
    case 'trigger':
      return '触发器';
    default:
      return layer;
  }
}

// ------------------------------------------------------------------ 形状规格

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 六种形状（`heightfield` 是地形专用，正好第六种 + 地形特例） */
export type ShapeKind = 'box' | 'ball' | 'cylinder' | 'capsule' | 'convexHull' | 'trimesh';

export interface BoxShape {
  kind: 'box';
  halfExtents: [number, number, number];
}
export interface BallShape {
  kind: 'ball';
  radius: number;
}
export interface CylinderShape {
  kind: 'cylinder';
  halfHeight: number;
  radius: number;
}
export interface CapsuleShape {
  kind: 'capsule';
  halfHeight: number;
  radius: number;
}
export interface ConvexHullShape {
  kind: 'convexHull';
  /** 扁平顶点数组 [x,y,z, x,y,z, ...] */
  points: Float32Array;
}
export interface TrimeshShape {
  kind: 'trimesh';
  vertices: Float32Array;
  indices: Uint32Array;
}

export type ShapeSpec = BoxShape | BallShape | CylinderShape | CapsuleShape | ConvexHullShape | TrimeshShape;

/** 一个碰撞体的完整描述 */
export interface ColliderSpecFull {
  shape: ShapeSpec;
  /** 相对刚体原点的偏移 */
  offset?: Vec3Like;
  /** 相对刚体的旋转（四元数） */
  rotation?: { x: number; y: number; z: number; w: number };
  /** 物理材质（不传就用传入的默认材质） */
  material?: PhysicsMaterial;
  /** 所属层，默认 'building' */
  layer?: PhysicsLayer;
  /** 是不是传感器（触发器用） */
  sensor?: boolean;
  /** 覆盖碰撞矩阵（特殊物体用，例如"只和地形碰撞的传送带"） */
  partners?: PhysicsLayer[];
  /**
   * 允许三角网用在动态刚体上。
   *
   * 默认 false，因为 Rapier 不支持动态 trimesh，硬上会得到"物体不动"或 wasm 抛异常。
   * 保留这个开关是为了让"传送带"这类**运动学**物体能用三角网（kinematic 是被支持的），
   * 调用方必须自己确保刚体是 kinematic/fixed。
   */
  allowDynamicTrimesh?: boolean;
}

export interface ColliderCreationResult {
  /** 是否成功建了碰撞体 */
  ok: boolean;
  /** 实际用到的形状（可能与请求的不同 —— 凸包退化时会回退成盒子） */
  usedShape: ShapeKind | 'heightfield';
  /** 是否发生了回退 */
  fellBack: boolean;
  /** 告警原因（中文），用于日志 */
  warning?: string;
}

/**
 * 建一个碰撞体并挂到刚体上。
 *
 * `world` / `body` 用最小结构类型而不是 Rapier 的类型，这样这个文件在 Node 里能被 import
 * 并做形状规格的单元测试（不需要真的加载 wasm）。
 */
export function createCollider(
  api: { ColliderDesc: RapierColliderDescStatic },
  world: { createCollider(desc: RapierColliderDesc, body: unknown): { handle: number } },
  body: unknown,
  spec: ColliderSpecFull,
  fallbackMaterial: PhysicsMaterial,
): ColliderCreationResult {
  const layer = spec.layer ?? 'building';
  const material = spec.material ?? fallbackMaterial;

  // 只有固定的东西才能用三角网：Rapier 不支持动态 trimesh，
  // 硬上会得到"物体不动"或者整个 wasm 抛异常 —— 两种都很难排查，所以在这里直接拦下
  let shape = spec.shape;
  let warning: string | undefined;
  let fellBack = false;
  if (shape.kind === 'trimesh' && spec.sensor !== true && spec.allowDynamicTrimesh !== true) {
    const box = boundsOfVertices(shape.vertices);
    shape = { kind: 'box', halfExtents: box };
    fellBack = true;
    warning = '三角网碰撞体只能用于静态物体，已自动回退为包围盒（这是 Rapier 的硬限制）';
  }

  const desc = descForShape(api, shape);
  if (!desc) {
    // 凸包退化（顶点不足 4 个或全部共线）
    const points = shape.kind === 'convexHull' ? shape.points : new Float32Array(0);
    const box = boundsOfVertices(points);
    fellBack = true;
    warning = '凸包退化（顶点不足或共线），已回退为包围盒';
    return finishCollider(api, world, body, api.ColliderDesc.cuboid(box[0], box[1], box[2]), spec, material, layer, 'box', fellBack, warning);
  }

  return finishCollider(api, world, body, desc, spec, material, layer, shape.kind, fellBack, warning);
}

function finishCollider(
  api: { ColliderDesc: RapierColliderDescStatic },
  world: { createCollider(desc: RapierColliderDesc, body: unknown): { handle: number } },
  body: unknown,
  desc: RapierColliderDesc,
  spec: ColliderSpecFull,
  material: PhysicsMaterial,
  layer: PhysicsLayer,
  usedShape: ShapeKind,
  fellBack: boolean,
  warning?: string,
): ColliderCreationResult {
  void api;
  if (spec.offset) desc.setTranslation(spec.offset.x, spec.offset.y, spec.offset.z);
  if (spec.rotation) desc.setRotation(spec.rotation);

  desc.setDensity(Math.max(0.01, material.density));
  desc.setFriction(clamp01(material.friction));
  desc.setRestitution(clamp01(material.restitution));
  desc.setCollisionGroups(interactionGroups(layer, spec.partners));
  if (spec.sensor) {
    desc.setSensor(true);
    // 事件在 TriggerSystem 里按需打开；这里只保证传感器不产生碰撞响应
    desc.setSolverGroups(0);
  }

  world.createCollider(desc, body);
  return { ok: true, usedShape, fellBack, warning };
}

function descForShape(
  api: { ColliderDesc: RapierColliderDescStatic },
  shape: ShapeSpec,
): RapierColliderDesc | null {
  switch (shape.kind) {
    case 'box':
      return api.ColliderDesc.cuboid(
        Math.max(0.01, shape.halfExtents[0]),
        Math.max(0.01, shape.halfExtents[1]),
        Math.max(0.01, shape.halfExtents[2]),
      );
    case 'ball':
      return api.ColliderDesc.ball(Math.max(0.01, shape.radius));
    case 'cylinder':
      return api.ColliderDesc.cylinder(Math.max(0.01, shape.halfHeight), Math.max(0.01, shape.radius));
    case 'capsule':
      return api.ColliderDesc.capsule(Math.max(0, shape.halfHeight), Math.max(0.01, shape.radius));
    case 'convexHull':
      return dedupePoints(shape.points).length >= 12
        ? api.ColliderDesc.convexHull(dedupePoints(shape.points))
        : null;
    case 'trimesh':
      return api.ColliderDesc.trimesh(shape.vertices, shape.indices);
    default:
      return null;
  }
}

// ------------------------------------------------------------------ 顶点工具

/**
 * 去掉重复顶点。
 *
 * 为什么必须做：建筑几何里的三角形是**逐面展开**的，一个立方体箱子里同一个角点会出现 3 次。
 * 直接把这些点喂给 `convexHull` 会让 Rapier 的快速凸包算法做三倍无用功；
 * 更糟的是**共线点过多时凸包会退化失败**（返回 null），于是物体就没有碰撞体了。
 */
export function dedupePoints(points: Float32Array, epsilon = 1e-4): Float32Array {
  if (points.length < 3) return new Float32Array(0);
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const z = points[i + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const key = `${Math.round(x / epsilon)},${Math.round(y / epsilon)},${Math.round(z / epsilon)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x, y, z);
  }
  return new Float32Array(out);
}

/** 顶点集的包围盒半尺寸；空集返回最小盒（避免 0 尺寸的碰撞体让 Rapier 报错） */
export function boundsOfVertices(points: Float32Array): [number, number, number] {
  if (points.length < 3) return [0.05, 0.05, 0.05];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const z = points[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const half = (a: number, b: number): number => Math.max(0.01, (b - a) / 2);
  return [half(minX, maxX), half(minY, maxY), half(minZ, maxZ)];
}

/** 顶点集的中心（凸包可能不以原点为中心，做偏移用） */
export function centerOfVertices(points: Float32Array): Vec3Like {
  if (points.length < 3) return { x: 0, y: 0, z: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const z = points[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * 从 Three.js 的几何顶点算凸包输入。
 *
 * 这一步**不 import three**：只要求传进来的对象有 `position.array`（BufferAttribute 的形状）。
 * 这样这个函数能在 Node 里用普通 `Float32Array` 测试。
 */
export function convexHullPointsFromGeometry(geometry: {
  attributes?: { position?: { array: ArrayLike<number> } };
}): Float32Array {
  const array = geometry.attributes?.position?.array;
  if (!array) return new Float32Array(0);
  return dedupePoints(new Float32Array(Array.from(array)));
}

/** 从几何的索引与顶点生成三角网输入 */
export function trimeshFromGeometry(geometry: {
  attributes?: { position?: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> } | null;
}): { vertices: Float32Array; indices: Uint32Array } | null {
  const position = geometry.attributes?.position?.array;
  if (!position) return null;
  const vertices = new Float32Array(Array.from(position));
  const indexArray = geometry.index?.array;
  if (indexArray && indexArray.length >= 3) {
    return { vertices, indices: new Uint32Array(Array.from(indexArray)) };
  }
  // 没有索引：按"每三个顶点一个三角形"展开
  const indices = new Uint32Array(Math.floor(vertices.length / 3));
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { vertices, indices };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
