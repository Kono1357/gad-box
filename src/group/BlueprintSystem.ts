import type { Blueprint, BuildingInstance, BuildingPiece } from '../building/types';
import type { BuildingSystem } from '../building/BuildingSystem';
import { toPieces } from './PrefabSystem';
import { getBuildingDef } from '../data/buildingCatalog';

export const BLUEPRINT_VERSION = '1.0';

/** 镜像轴 */
export type MirrorAxis = 'x' | 'z';

/**
 * 蓝图系统：把结构导出成可以互相分享的 JSON，以及镜像复制。
 *
 * 蓝图与预制件的区别（两者都用同一套 BuildingPiece 数据）：
 * - **预制件**是"我自己常用的东西"，存在 localStorage 里、带缩略图，图的是顺手；
 * - **蓝图**是"可以发出去的文件"，纯 JSON、带版本号与包围盒，图的是可交换。
 *
 * 关于镜像：本实现做的是**真镜像**。
 * 数学上，关于平面 x = c 的镜像可以把一个实例的变换写成
 *   Translate(Mp) · RotY(-θ) · M · geometry
 * 其中 M = diag(-1,1,1)。也就是说：位置镜像、绕 Y 取反、**几何体本身也要在局部 X 上镜像**
 * （并且反转三角形绕序，否则面会朝里）。
 * 只做前两步的话，不对称的模型（比如车、门把手）看起来就是错的，
 * 所以这里把第三步也做了 —— 详见 BuildingRenderer 的 mirrorGeometry。
 */
export class BlueprintSystem {
  /** 从选中的物体导出蓝图 */
  exportFrom(ids: readonly number[], name: string, buildings: BuildingSystem): Blueprint | null {
    const instances = buildings.findMany(ids);
    if (instances.length === 0) return null;

    const objects = toPieces(instances);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (const piece of objects) {
      const def = getBuildingDef(piece.defId);
      const halfW = ((def?.size[0] ?? 1) * piece.scale) / 2;
      const halfD = ((def?.size[2] ?? 1) * piece.scale) / 2;
      const height = (def?.size[1] ?? 1) * piece.scale;
      minX = Math.min(minX, piece.position[0] - halfW);
      maxX = Math.max(maxX, piece.position[0] + halfW);
      minY = Math.min(minY, piece.position[1]);
      maxY = Math.max(maxY, piece.position[1] + height);
      minZ = Math.min(minZ, piece.position[2] - halfD);
      maxZ = Math.max(maxZ, piece.position[2] + halfD);
    }

    return {
      version: BLUEPRINT_VERSION,
      name: name.trim() || `蓝图 ${new Date().toLocaleString('zh-CN')}`,
      objects,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
    };
  }

  toJson(blueprint: Blueprint): string {
    return JSON.stringify(blueprint, null, 2);
  }

  /** 解析蓝图文本；格式不对返回 null 并给出原因 */
  parse(text: string): { blueprint: Blueprint | null; error?: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { blueprint: null, error: '不是合法的 JSON' };
    }
    if (!raw || typeof raw !== 'object') return { blueprint: null, error: '蓝图内容不是对象' };

    const data = raw as Partial<Blueprint>;
    if (typeof data.version !== 'string') return { blueprint: null, error: '缺少 version 字段' };
    if (!Array.isArray(data.objects)) return { blueprint: null, error: '缺少 objects 列表' };

    const objects: BuildingPiece[] = [];
    let skipped = 0;
    for (const entry of data.objects) {
      if (!entry || typeof entry.defId !== 'string') {
        skipped++;
        continue;
      }
      if (!getBuildingDef(entry.defId)) {
        skipped++;
        continue;
      }
      const position = Array.isArray(entry.position) && entry.position.length === 3
        ? ([entry.position[0] ?? 0, entry.position[1] ?? 0, entry.position[2] ?? 0] as [number, number, number])
        : ([0, 0, 0] as [number, number, number]);
      objects.push({
        defId: entry.defId,
        position,
        rotationY: typeof entry.rotationY === 'number' ? entry.rotationY : 0,
        scale: typeof entry.scale === 'number' && entry.scale > 0 ? entry.scale : 1,
        mode: entry.mode,
      });
    }

    if (objects.length === 0) return { blueprint: null, error: '蓝图里没有可识别的模型（可能版本不匹配）' };

    const bounds = data.bounds && Array.isArray(data.bounds.min) && Array.isArray(data.bounds.max)
      ? data.bounds
      : { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };

    return {
      blueprint: {
        version: data.version,
        name: typeof data.name === 'string' ? data.name : '导入的蓝图',
        objects,
        bounds,
      },
      error: skipped > 0 ? `跳过了 ${skipped} 个无法识别的模型` : undefined,
    };
  }

  /** 把蓝图放到世界里的某个位置（底面中心） */
  instantiate(
    blueprint: Blueprint,
    at: [number, number, number],
    rotationY: number,
    buildings: BuildingSystem,
  ): BuildingInstance[] {
    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);
    return buildings.addMany(
      blueprint.objects.map((piece) => ({
        defId: piece.defId,
        position: [
          at[0] + piece.position[0] * cos + piece.position[2] * sin,
          at[1] + piece.position[1],
          at[2] - piece.position[0] * sin + piece.position[2] * cos,
        ] as [number, number, number],
        rotationY: piece.rotationY + rotationY,
        scale: piece.scale,
        mode: 'static' as const,
      })),
    );
  }

  /**
   * 镜像复制选中的物体。
   *
   * @param axis 'x' 表示关于"过 pivot 且垂直于 X 轴"的平面镜像
   * @returns 新建的实例 id 列表
   */
  mirrorCopy(
    ids: readonly number[],
    axis: MirrorAxis,
    buildings: BuildingSystem,
    pivot?: [number, number, number],
  ): BuildingInstance[] {
    const instances = buildings.findMany(ids);
    if (instances.length === 0) return [];

    const center = pivot ?? centerOf(instances);
    const created: BuildingInstance[] = [];

    for (const instance of instances) {
      const position: [number, number, number] = [
        axis === 'x' ? 2 * center[0] - instance.position[0] : instance.position[0],
        instance.position[1],
        axis === 'z' ? 2 * center[2] - instance.position[2] : instance.position[2],
      ];
      // 镜像的数学结论：位置取镜像、绕 Y 取反、几何体在局部对应轴上镜像
      const rotationY = -instance.rotationY;
      const mirror = axis === 'x' ? 'x' : 'z';

      const copy = buildings.add(instance.defId, position, rotationY, instance.scale, instance.physicsMode ?? 'static');
      if (!copy) continue;
      copy.mirror = mirror;
      created.push(copy);
    }

    return created;
  }
}

/** 一组实例的几何中心（水平方向），作为镜像平面 */
function centerOf(instances: readonly BuildingInstance[]): [number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const instance of instances) {
    minX = Math.min(minX, instance.position[0]);
    maxX = Math.max(maxX, instance.position[0]);
    minZ = Math.min(minZ, instance.position[2]);
    maxZ = Math.max(maxZ, instance.position[2]);
    minY = Math.min(minY, instance.position[1]);
    maxY = Math.max(maxY, instance.position[1]);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}
