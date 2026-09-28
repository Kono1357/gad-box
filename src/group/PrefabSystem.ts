import type { BuildingInstance, BuildingPiece, Prefab } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import { getBuildingDef } from '../data/buildingCatalog';

export const PREFAB_STORAGE_KEY = 'god-sandbox-prefabs-v1';
const MAX_PREFABS = 60;

/**
 * 用等轴测投影把结构画成一张 SVG 缩略图（data URL）。
 *
 * 为什么不用真渲染截图：要截图就得额外开一个 WebGL 上下文 + 离屏渲染 + 读回像素，
 * 在手机上又慢又容易触发上下文数量限制。
 * 而我们的模型本来就是"长方体拼起来的"，等轴测投影直接算 8 个顶点画多边形就行 ——
 * 几十行、零开销、离线可用，看起来还挺像样。
 */
export function renderThumbnail(pieces: readonly BuildingPiece[], size = 64): string {
  if (pieces.length === 0) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#1a2028"/></svg>`,
    )}`;
  }

  // 先算包围盒，用来居中与缩放
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const piece of pieces) {
    const def = getBuildingDef(piece.defId);
    if (!def) continue;
    const hx = (def.size[0] * piece.scale) / 2;
    const hz = (def.size[2] * piece.scale) / 2;
    minX = Math.min(minX, piece.position[0] - hx);
    maxX = Math.max(maxX, piece.position[0] + hx);
    minY = Math.min(minY, piece.position[1]);
    maxY = Math.max(maxY, piece.position[1] + def.size[1] * piece.scale);
    minZ = Math.min(minZ, piece.position[2] - hz);
    maxZ = Math.max(maxZ, piece.position[2] + hz);
  }
  if (!Number.isFinite(minX)) return renderThumbnail([], size);

  const spanX = Math.max(0.5, maxX - minX);
  const spanZ = Math.max(0.5, maxZ - minZ);
  const spanY = Math.max(0.5, maxY - minY);
  // 等轴测：屏幕 X 用 (x - z)，屏幕 Y 用 (x + z)/2 - y
  const projSpan = spanX + spanZ;
  const scale = Math.min((size - 8) / projSpan, (size - 8) / (spanY + projSpan * 0.5));

  const project = (x: number, y: number, z: number): [number, number] => {
    const sx = (x - minX - (z - minZ)) * scale;
    const sy = ((x - minX) + (z - minZ)) * 0.5 * scale - (y - minY) * scale;
    return [sx + size / 2 - ((spanX - spanZ) * scale) / 2, size - 6 - sy];
  };

  type Face = { points: string; color: string; depth: number };
  const faces: Face[] = [];

  for (const piece of pieces) {
    const def = getBuildingDef(piece.defId);
    if (!def) continue;
    const hx = (def.size[0] * piece.scale) / 2;
    const hy = (def.size[1] * piece.scale) / 2;
    const hz = (def.size[2] * piece.scale) / 2;
    const cx = piece.position[0];
    const cy = piece.position[1] + hy; // position 是底面中心，这里换成体心
    const cz = piece.position[2];

    const corner = (sx: number, sy: number, sz: number): [number, number] =>
      project(cx + sx * hx, cy + sy * hy, cz + sz * hz);

    const p000 = corner(-1, -1, -1);
    const p100 = corner(1, -1, -1);
    const p110 = corner(1, 1, -1);
    const p010 = corner(-1, 1, -1);
    const p001 = corner(-1, -1, 1);
    const p101 = corner(1, -1, 1);
    const p111 = corner(1, 1, 1);
    const p011 = corner(-1, 1, 1);

    const base = piece.defId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const tint = (factor: number): string => {
      const r = Math.min(255, (((def.color >> 16) & 0xff) * factor) | 0);
      const g = Math.min(255, (((def.color >> 8) & 0xff) * factor) | 0);
      const b = Math.min(255, ((def.color & 0xff) * factor) | 0);
      return `rgb(${r},${g},${b})`;
    };
    // 用 id 的哈希给相邻方块一点色差，缩略图更立体
    const variation = 1 + ((base % 7) - 3) * 0.02;

    const toPath = (points: Array<[number, number]>): string =>
      points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');

    // 只画三个可见面：顶面、-X 侧面、-Z 侧面
    faces.push({
      points: toPath([p010, p110, p111, p011]),
      color: tint(1.0 * variation),
      depth: cy + hy + cx + cz,
    });
    faces.push({
      points: toPath([p000, p100, p110, p010]),
      color: tint(0.72 * variation),
      depth: cy - hy + cx - cz,
    });
    faces.push({
      points: toPath([p000, p001, p101, p100]),
      color: tint(0.86 * variation),
      depth: cy - hy - cx + cz,
    });
  }

  // 画家算法：远的先画
  faces.sort((a, b) => a.depth - b.depth);

  const body = faces
    .map((face) => `<polygon points="${face.points}" fill="${face.color}" stroke="rgba(0,0,0,0.35)" stroke-width="0.5"/>`)
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="#141a21"/>${body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 预制件系统。
 *
 * 预制件 = "选中 → 保存 → 以后一键放出来"。
 * 存在**独立的 localStorage 键**里（不跟着存档走），因为它们是玩家跨世界的资产库：
 * 在新地图里也能把上次做好的房子拿出来用。
 *
 * 原点落在结构的**底面中心**，所以放置时只要给一个地面点，
 * 整个结构就会以正确的姿态"坐落"在那里。
 */
export class PrefabSystem {
  private readonly prefabs = new Map<string, Prefab>();
  private nextId = 1;

  constructor(private readonly storageKey: string = PREFAB_STORAGE_KEY) {
    this.load();
  }

  get all(): Prefab[] {
    return [...this.prefabs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get count(): number {
    return this.prefabs.size;
  }

  get(prefabId: string): Prefab | undefined {
    return this.prefabs.get(prefabId);
  }

  /**
   * 把选中的物体保存成预制件。
   * @returns 新预制件；少于 1 个物体时返回 null
   */
  createFrom(ids: readonly number[], name: string, buildings: BuildingSystem): Prefab | null {
    const instances = buildings.findMany(ids);
    if (instances.length === 0) return null;

    const pieces = toPieces(instances);
    const prefab: Prefab = {
      id: `p${Date.now().toString(36)}${this.nextId++}`,
      name: name.trim() || `预制件 ${this.prefabs.size + 1}`,
      objects: pieces,
      thumbnail: renderThumbnail(pieces, 64),
      createdAt: Date.now(),
    };

    this.prefabs.set(prefab.id, prefab);
    // 超过上限就丢掉最旧的，避免 localStorage 无限膨胀
    if (this.prefabs.size > MAX_PREFABS) {
      const oldest = this.all[this.all.length - 1];
      if (oldest) this.prefabs.delete(oldest.id);
    }
    this.save();
    return prefab;
  }

  /** 把预制件放到某个世界坐标（底面中心） */
  instantiate(
    prefabId: string,
    at: [number, number, number],
    rotationY: number,
    buildings: BuildingSystem,
  ): BuildingInstance[] {
    const prefab = this.prefabs.get(prefabId);
    if (!prefab) return [];

    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);
    const placements = prefab.objects.map((piece) => ({
      defId: piece.defId,
      position: [
        at[0] + piece.position[0] * cos + piece.position[2] * sin,
        at[1] + piece.position[1],
        at[2] - piece.position[0] * sin + piece.position[2] * cos,
      ] as [number, number, number],
      rotationY: piece.rotationY + rotationY,
      scale: piece.scale,
      mode: 'static' as const,
    }));

    return buildings.addMany(placements);
  }

  remove(prefabId: string): boolean {
    const removed = this.prefabs.delete(prefabId);
    if (removed) this.save();
    return removed;
  }

  rename(prefabId: string, name: string): boolean {
    const prefab = this.prefabs.get(prefabId);
    if (!prefab) return false;
    prefab.name = name.trim() || prefab.name;
    this.save();
    return true;
  }

  // ---------------------------------------------------------------- 持久化

  private load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed as Prefab[]) {
        if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.objects)) continue;
        if (entry.objects.length === 0) continue;
        this.prefabs.set(entry.id, entry);
      }
    } catch {
      // 存档损坏就当没有预制件，不影响主流程
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.all));
    } catch {
      // 超出配额就放弃保存这一批（下次删除旧的会恢复）
    }
  }

  clear(): void {
    this.prefabs.clear();
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* 忽略 */
    }
  }
}

/** 把实例转成"相对结构原点"的碎片列表 */
export function toPieces(instances: readonly BuildingInstance[]): BuildingPiece[] {
  if (instances.length === 0) return [];
  let minX = Infinity;
  let minZ = Infinity;
  let minY = Infinity;
  for (const instance of instances) {
    minX = Math.min(minX, instance.position[0]);
    minY = Math.min(minY, instance.position[1]);
    minZ = Math.min(minZ, instance.position[2]);
  }
  const originX = (minX + Math.max(...instances.map((i) => i.position[0]))) / 2;
  const originZ = (minZ + Math.max(...instances.map((i) => i.position[2]))) / 2;

  return instances.map((instance) => ({
    defId: instance.defId,
    position: [
      instance.position[0] - originX,
      instance.position[1] - minY,
      instance.position[2] - originZ,
    ],
    rotationY: instance.rotationY,
    scale: instance.scale,
    mode: instance.physicsMode ?? 'static',
  }));
}
