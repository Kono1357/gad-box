import {
  BoxGeometry,
  Color,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { BuildingDef, BuildingInstance, MirrorAxis } from './types';
import { getBuildingDef } from '../data/buildingCatalog';
import { instanceBounds } from './BuildingSystem';

interface Disposable {
  dispose(): void;
}

/**
 * 把一个建筑模型的所有 part 合成**一个** BufferGeometry（顶点色）。
 *
 * 为什么要合并：一个墙模型有 1~8 个 part，如果每个 part 一个 Mesh，
 * 放 200 面墙就是 1600 次 draw call。合并之后，
 * 每个**模型**只需要一个 InstancedMesh —— 200 面墙就是 1 次 draw call。
 *
 * 颜色烘焙进顶点色，于是所有建筑还能共用**一个**材质。
 */
export function buildBuildingGeometry(def: BuildingDef): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const part of def.parts) {
    const geometry = createPartGeometry(part);
    if (part.rotationX) geometry.rotateX(part.rotationX);
    if (part.rotationY) geometry.rotateY(part.rotationY);
    if (part.rotationZ) geometry.rotateZ(part.rotationZ);
    geometry.translate(part.position[0], part.position[1], part.position[2]);

    const base = positions.length / 3;
    const positionAttr = geometry.getAttribute('position');
    const normalAttr = geometry.getAttribute('normal');
    const indexAttr = geometry.getIndex();

    const r = ((part.color >> 16) & 0xff) / 255;
    const g = ((part.color >> 8) & 0xff) / 255;
    const b = (part.color & 0xff) / 255;

    for (let i = 0; i < positionAttr.count; i++) {
      positions.push(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      normals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
      colors.push(r, g, b);
    }
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i++) indices.push(base + indexAttr.getX(i));
    } else {
      for (let i = 0; i < positionAttr.count; i++) indices.push(base + i);
    }

    geometry.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  merged.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  merged.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  merged.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * 生成镜像几何体。
 *
 * 镜像复制要成立，光把位置和角度取镜像是不够的（那只是"转过去"，不是"照镜子"）：
 * 数学上是 `Translate(Mp) · RotY(-θ) · M · geometry`，最后那个 M 作用在**几何体**上。
 * 所以这里把顶点沿某个轴取反，并且**反转三角形绕序** ——
 * 不反转的话所有面的正面朝向会翻过来，渲染出来是一堆黑面。
 * 法线由 three 的 applyMatrix4 一并处理（用的是逆转置矩阵，正是镜像需要的）。
 */
export function mirrorGeometry(source: BufferGeometry, axis: 'x' | 'z'): BufferGeometry {
  const geometry = source.clone();
  if (axis === 'x') geometry.scale(-1, 1, 1);
  else geometry.scale(1, 1, -1);

  const index = geometry.getIndex();
  if (index) {
    const count = index.count;
    const array = new Uint32Array(count);
    for (let i = 0; i < count; i += 3) {
      array[i] = index.getX(i);
      array[i + 1] = index.getX(i + 2);
      array[i + 2] = index.getX(i + 1);
    }
    geometry.setIndex(new BufferAttribute(array, 1));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

/** 单个 part → 基本几何体（贴合 types.ts 里的尺寸约定） */
function createPartGeometry(part: BuildingDef['parts'][number]): BufferGeometry {
  const [sx, sy, sz] = part.size;
  switch (part.shape) {
    case 'cylinder':
      return new CylinderGeometry(sx / 2, sx / 2, sy, 12);
    case 'cone':
      return new ConeGeometry(sx / 2, sy, 12);
    case 'sphere':
      return new SphereGeometry(sx / 2, 12, 8).scale(sz / sx, sy / sx, 1);
    case 'box':
    default:
      return new BoxGeometry(sx, sy, sz);
  }
}

/** 合批的键：同一模型的"正常体 / X 镜像体 / Z 镜像体"要分开成三个实例批次 */
function batchKey(defId: string, mirror: MirrorAxis): string {
  return `${defId}|${mirror}`;
}

/**
 * 建筑渲染器：按（模型 id + 镜像方式）合批成 InstancedMesh。
 *
 * M2 的两处变化：
 * 1. **每帧同步**（有动态刚体时）：M1.5 只在集合变化时重算矩阵，
 *    现在可能有物体在翻滚，所以 `sync(instances, force)` 支持逐帧更新；
 * 2. **选择高亮合并成一个 LineSegments**：500 个选中的物体也只占 1 次 draw call，
 *    这是"选择高亮不影响帧率"的实现方式（而不是给每个选中物体加一个描边 Mesh）。
 */
export class BuildingRenderer {
  readonly group = new Group();

  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly meshes = new Map<string, InstancedMesh>();
  private readonly material: MeshLambertMaterial;
  private readonly selectionMaterial: LineBasicMaterial;
  private readonly hoverMaterial: LineBasicMaterial;
  private readonly selectionLines: LineSegments;
  private readonly hoverLines: LineSegments;
  private readonly disposables: Disposable[] = [];
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
  private readonly axisY = new Vector3(0, 1, 0);

  private dirty = true;
  private lastInstances: readonly BuildingInstance[] = [];
  /** 稳定性着色开关：不稳的染红、勉强的染黄（补充 2） */
  private stabilityTint = true;
  private readonly tintColor = new Color();
  /**
   * 外部着色提供者（M3 应力可视化用）。
   *
   * 为什么不直接改 `tintForStability`：稳定性着色（不稳染红/临界染黄）是**内建语义**，
   * 而应力是**可选的分析视图**。用提供者注入，两边就都不用知道对方的存在；
   * 返回 `null` 表示"这次不接管"，退回内建稳定性着色。
   */
  private tintProvider: ((instance: BuildingInstance) => [number, number, number] | null) | null = null;

  /**
   * 设置外部着色提供者（传 null 恢复内建稳定性着色）。
   *
   * ⚠ 两者共用同一条 `instanceColor` 通道，所以**语义上互斥**：
   * 同时打开会让人分不清"红色"代表不稳还是代表应力高。调用方负责只开一个。
   */
  setTintProvider(provider: ((instance: BuildingInstance) => [number, number, number] | null) | null): void {
    this.tintProvider = provider;
  }
  /** 选择高亮的几何体版本号，避免每帧重建 */
  private highlightVersion = -1;

  constructor() {
    this.group.name = 'buildings';
    this.material = this.track(new MeshLambertMaterial({ vertexColors: true, flatShading: true }));

    this.selectionMaterial = this.track(
      new LineBasicMaterial({ color: 0xffcc4d, transparent: true, opacity: 0.95 }),
    );
    this.hoverMaterial = this.track(
      new LineBasicMaterial({ color: 0x7fd06a, transparent: true, opacity: 0.7 }),
    );

    this.selectionLines = new LineSegments(this.track(new BufferGeometry()), this.selectionMaterial);
    this.selectionLines.name = 'selection-highlight';
    this.selectionLines.frustumCulled = false;
    this.group.add(this.selectionLines);

    this.hoverLines = new LineSegments(this.track(new BufferGeometry()), this.hoverMaterial);
    this.hoverLines.name = 'hover-highlight';
    this.hoverLines.frustumCulled = false;
    this.group.add(this.hoverLines);
  }

  private track<T extends Disposable>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  /** 标记需要重算实例矩阵（放置 / 删除 / 移动 / 旋转后调用） */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * 开关稳定性着色。
   * 打开时：稳固 = 原色（不染），勉强 = 偏黄，不稳 = 偏红。
   * 用的是 InstancedMesh 的 instanceColor（逐实例乘法着色），
   * 所以不需要第二套材质，也不会增加 draw call。
   */
  setStabilityTint(enabled: boolean): void {
    if (this.stabilityTint === enabled) return;
    this.stabilityTint = enabled;
    this.dirty = true;
  }

  /**
   * 同步实例到场景。
   * @param force true 时无视 dirty 标记强制重算（有动态刚体在动时必须每帧调用）
   */
  sync(instances: readonly BuildingInstance[], force = false): void {
    this.lastInstances = instances;
    if (!this.dirty && !force) return;
    this.dirty = false;

    // 1) 按（模型 + 镜像）分组
    const groups = new Map<string, BuildingInstance[]>();
    for (const instance of instances) {
      const key = batchKey(instance.defId, instance.mirror ?? 'none');
      const list = groups.get(key);
      if (list) list.push(instance);
      else groups.set(key, [instance]);
    }

    // 2) 不再使用的批次：实例数归零（几何体留着，回来时不用重建）
    for (const [key, mesh] of this.meshes) {
      if (!groups.has(key)) mesh.count = 0;
    }

    // 3) 逐批写矩阵
    for (const [key, list] of groups) {
      const [defId, mirrorRaw] = key.split('|') as [string, MirrorAxis];
      const mesh = this.ensureMesh(defId, mirrorRaw, list.length);
      if (!mesh) continue;

      // 稳定性着色：只有"需要提醒玩家"的物体才染色，稳固的保持原色
      const wantsColor = this.stabilityTint;
      if (wantsColor && !mesh.instanceColor) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3).fill(1), 3);
      }

      for (let i = 0; i < list.length; i++) {
        const instance = list[i]!;
        const scaleValue = instance.scale ?? 1;
        this.position.set(instance.position[0], instance.position[1], instance.position[2]);
        const quaternion = instance.quaternion;
        if (quaternion) {
          this.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
        } else {
          this.quaternion.setFromAxisAngle(this.axisY, instance.rotationY);
        }
        this.scale.set(scaleValue, scaleValue, scaleValue);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        mesh.setMatrixAt(i, this.matrix);

        if (wantsColor) {
          // 外部提供者优先；它返回 null 就退回内建稳定性着色
          const tint = this.tintProvider?.(instance) ?? tintForStability(instance.stability);
          this.tintColor.setRGB(tint[0], tint[1], tint[2]);
          mesh.setColorAt(i, this.tintColor);
        }
      }
      if (wantsColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /**
   * 更新选择高亮。用**一个合并的线框几何体**表达所有选中物体，
   * 所以选 500 个和选 1 个的 draw call 都是 1 次。
   */
  setSelection(instances: readonly BuildingInstance[], hovered: BuildingInstance | null, version: number): void {
    if (version === this.highlightVersion && this.selectionLines.geometry.getAttribute('position')) {
      // 版本没变就只更新悬停框（悬停变化很频繁，但只有一个）
      this.updateHover(hovered);
      return;
    }
    this.highlightVersion = version;

    const positions: number[] = [];
    for (const instance of instances) appendBoxEdges(positions, instance);
    setLinePositions(this.selectionLines, positions);
    this.updateHover(hovered);
  }

  private updateHover(hovered: BuildingInstance | null): void {
    if (!hovered) {
      this.hoverLines.visible = false;
      return;
    }
    const positions: number[] = [];
    appendBoxEdges(positions, hovered);
    setLinePositions(this.hoverLines, positions);
    this.hoverLines.visible = true;
  }

  private ensureMesh(defId: string, mirror: MirrorAxis, required: number): InstancedMesh | null {
    const key = batchKey(defId, mirror);
    let mesh = this.meshes.get(key);
    if (mesh && mesh.instanceMatrix.count >= required) return mesh;

    let geometry = this.geometries.get(key);
    if (!geometry) {
      const def = getBuildingDef(defId);
      if (!def) return null;
      const base = buildBuildingGeometry(def);
      if (mirror === 'none') {
        geometry = base;
      } else {
        geometry = mirrorGeometry(base, mirror);
        base.dispose();
      }
      this.geometries.set(key, geometry);
      this.disposables.push(geometry);
    }

    const capacity = Math.max(16, nextPowerOfTwo(required));
    if (mesh) {
      this.group.remove(mesh);
      mesh.dispose();
    }

    mesh = new InstancedMesh(geometry, this.material, capacity);
    mesh.name = `buildings-${key}`;
    // 实例位置不影响几何体的包围球，关掉自动剔除避免整批被误剔除
    mesh.frustumCulled = false;
    this.meshes.set(key, mesh);
    this.group.add(mesh);
    return mesh;
  }

  /** 当前渲染的实例总数 */
  get renderedInstances(): number {
    let total = 0;
    for (const mesh of this.meshes.values()) total += mesh.count;
    return total;
  }

  /** 当前活跃的批次 = draw call 数 */
  get drawCalls(): number {
    let total = 0;
    for (const mesh of this.meshes.values()) if (mesh.count > 0) total++;
    return total;
  }

  get geometryCount(): number {
    return this.geometries.size;
  }

  /** 供幽灵预览使用（不镜像） */
  getGeometry(defId: string): BufferGeometry | null {
    const key = batchKey(defId, 'none');
    const cached = this.geometries.get(key);
    if (cached) return cached;
    const def = getBuildingDef(defId);
    if (!def) return null;
    const geometry = buildBuildingGeometry(def);
    this.geometries.set(key, geometry);
    this.disposables.push(geometry);
    return geometry;
  }

  clear(): void {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes.clear();
    this.dirty = true;
    this.highlightVersion = -1;
    void this.lastInstances;
  }

  dispose(): void {
    this.clear();
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    this.geometries.clear();
  }
}

/** 往顶点数组里追加一个实例包围盒的 12 条边 */
function appendBoxEdges(target: number[], instance: BuildingInstance): void {
  const box = instanceBounds(instance);
  const x0 = box.minX - 0.02;
  const x1 = box.maxX + 0.02;
  const y0 = box.minY - 0.02;
  const y1 = box.maxY + 0.02;
  const z0 = box.minZ - 0.02;
  const z1 = box.maxZ + 0.02;

  const corners: Array<[number, number, number]> = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [a, b] of edges) {
    const pa = corners[a]!;
    const pb = corners[b]!;
    target.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
  }
}

function setLinePositions(lines: LineSegments, positions: number[]): void {
  const geometry = lines.geometry;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingSphere();
  lines.visible = positions.length > 0;
}

/**
 * 稳定性 → 逐实例着色的乘数。
 * 稳固用纯白（等于不染色），这样一眼扫过去只有"有问题的"是彩色的。
 */
function tintForStability(stability: BuildingInstance['stability']): [number, number, number] {
  if (stability === 'unstable') return [1, 0.52, 0.48];
  if (stability === 'critical') return [1, 0.88, 0.55];
  return [1, 1, 1];
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}
