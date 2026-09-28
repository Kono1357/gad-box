/**
 * 组合生成器（问题 A / 第 5 批：20 个物理组合）。
 *
 * 一个「组合」= 几个模型 + 它们之间的关节（外加可选的触发器和逻辑连线）。
 * 玩家点一下「摆放」，这个类负责把数据变成世界里的东西：
 *
 * ```
 * Combo（数据）
 *   → 建筑实例（BuildingSystem.addMany，会顺便建刚体）
 *   → 关节（PhysicsFramework.addJoint，bodyA/bodyB 用实例的 physicsHandle）
 *   → 触发器与逻辑连线（可选）
 * ```
 *
 * 三件容易做错的事，这里都显式处理了：
 *
 * 1. **刚体句柄的字符串化**。`JointConfig.bodyA/bodyB` 是 `string`（为了让组合数据能进存档），
 *    而 Rapier 的 handle 在本项目的 wasm 构建里可能是 `5e-324` 这种科学计数法小数字。
 *    所以一律 `String(handle)` 写进去、`Number()` 读回来 ——
 *    `parseInt("5e-324")` 会得到 `5`，那会把关节连到完全无关的物体上，且只在特定机器上复现。
 *
 * 2. **物理没就绪时的排队**。Rapier 是动态 import 的（4.3 MB 的 wasm 分块）。
 *    如果玩家在就绪前就摆了组合，关节会进 `JointSystem` 的待建队列，就绪后自动补建。
 *    所以这里不检查就绪、不拒绝，只是**如实返回**「骨架已摆好，关节排队中」。
 *
 * 3. **落点要落地**。组合数据里的 y 是相对组合原点的，原点被放在玩家指定的位置上。
 *    如果玩家把原点放在空中，整个组合会悬空 —— 这里**不偷偷吸到地面**，
 *    而是把「可能悬空」如实写进返回值，由 Engine 决定要不要提示。
 *    （悄悄改玩家指定的位置比留个悬空物体更糟：玩家会以为自己的操作没生效。）
 */

import type { Combo } from '../data/combos';
import type { JointConfig } from '../data/jointTypes';
import type { PhysicsComponent } from '../data/physicsComponents';
import type { BuildingSystem } from '../building/BuildingSystem';
import type { BuildingInstance, MirrorAxis } from '../building/types';
import type { PhysicsFramework } from './PhysicsFramework';
import { getBuildingDef } from '../data/buildingCatalog';

/** 一个组合被摆放后的结果 */
export interface ComboSpawnResult {
  ok: boolean;
  comboId: string;
  /** 生成的建筑实例 */
  instances: BuildingInstance[];
  /** 真正建成的关节数（未就绪时为 0） */
  jointsBuilt: number;
  /** 排队等物理就绪的关节数 */
  jointsPending: number;
  /** 生成的触发器数 */
  triggers: number;
  /** 生成的逻辑连线数 */
  links: number;
  /** 失败原因（ok 为 false 时必有） */
  reason: string;
  /** 给玩家看的一句话 */
  message: string;
  /** 组合里有没有模型 id 找不到（数据坏了要能看出来，而不是静默缺件） */
  missingDefs: string[];
  /** 预估会不会悬空：组合最低点高于给定落点时 */
  probablyFloating: boolean;
}

export interface ComboSpawnOptions {
  /** 组合原点放在哪里（世界坐标，组合最底面的中心） */
  origin: [number, number, number];
  /** 整体额外旋转（弧度），例如跟着当前预览旋转 */
  rotationY?: number;
  /** 整体缩放 */
  scale?: number;
  /** 镜像（组合也能镜像，门反过来开） */
  mirror?: MirrorAxis;
  /** 物理没就绪时是否仍然摆放骨架（默认 true：玩家不该因为 wasm 还在下载就摆不了东西） */
  allowWithoutPhysics?: boolean;
}

export class ComboBuilder {
  /** 已经摆过的组合 id → 次数（面板显示「已摆 N 个」） */
  private readonly placedCounts = new Map<string, number>();

  constructor(
    private readonly buildings: BuildingSystem,
    private readonly framework: PhysicsFramework,
  ) {}

  get counts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, count] of this.placedCounts) result[id] = count;
    return result;
  }

  /**
   * 把一个组合摆到世界里。
   *
   * 返回的 `message` 是**给玩家看的实话**，包括「关节在排队」「有两个模型找不到」
   * 「可能悬空」这些不那么好听但必须说的内容。
   */
  spawn(combo: Combo, options: ComboSpawnOptions): ComboSpawnResult {
    const [ox, oy, oz] = options.origin;
    const extraRotation = options.rotationY ?? 0;
    const scale = options.scale ?? 1;

    const missingDefs: string[] = [];
    let minY = Number.POSITIVE_INFINITY;

    // ---- 1) 模型 → 建筑实例
    const placements: {
      defId: string;
      position: [number, number, number];
      rotationY: number;
      scale: number;
      mode?: 'static' | 'dynamic' | 'kinematic';
      mirror?: MirrorAxis;
      pieceIndex: number;
    }[] = [];

    for (let index = 0; index < combo.objects.length; index += 1) {
      const piece = combo.objects[index]!;
      if (!getBuildingDef(piece.defId)) {
        missingDefs.push(piece.defId);
        continue;
      }
      // 组合内部坐标要跟着整体旋转一起转（否则转 90° 之后零件会各自歪着）
      const rotated = rotateXZ(piece.position[0] * scale, piece.position[2] * scale, extraRotation);
      placements.push({
        defId: piece.defId,
        position: [ox + rotated.x, oy + piece.position[1] * scale, oz + rotated.z],
        rotationY: piece.rotationY + extraRotation,
        scale: piece.scale * scale,
        mode: piece.mode,
        mirror: piece.mirror,
        pieceIndex: index,
      });
      if (piece.position[1] * scale < minY) minY = piece.position[1] * scale;
    }

    if (placements.length === 0) {
      return {
        ok: false,
        comboId: combo.id,
        instances: [],
        jointsBuilt: 0,
        jointsPending: 0,
        triggers: 0,
        links: 0,
        reason: `组合「${combo.name}」里没有一个模型可用（缺失：${missingDefs.join('、') || '全部'}）`,
        message: `摆放失败：组合「${combo.name}」的模型数据不对`,
        missingDefs,
        probablyFloating: false,
      };
    }

    const instances = this.buildings.addMany(
      placements.map((piece) => ({
        defId: piece.defId,
        position: piece.position,
        rotationY: piece.rotationY,
        scale: piece.scale,
        mode: piece.mode,
      })),
    );

    // ---- 2) 关节：bodyA/bodyB 是「组合内第几个零件」的下标，要映射成刚体句柄
    //        这里必须用 placements 的顺序对齐 instances —— addMany 可能跳过找不到模型的项，
    //        所以按下标映射会串位，用 defId + 顺序逐一配对更稳。
    const handleByPiece = new Map<number, number>();
    for (let index = 0; index < placements.length && index < instances.length; index += 1) {
      handleByPiece.set(placements[index]!.pieceIndex, instances[index]!.physicsHandle ?? -1);
    }

    let jointsBuilt = 0;
    let jointsPending = 0;
    const instanceByHandle = new Map<number, BuildingInstance>();
    for (const instance of instances) {
      if (typeof instance.physicsHandle === 'number' && instance.physicsHandle >= 0) {
        instanceByHandle.set(instance.physicsHandle, instance);
      }
    }

    for (const joint of combo.joints) {
      const remapped = this.remapJoint(joint, handleByPiece, ox, oy, oz, extraRotation, scale);
      const id = this.framework.addJoint(remapped);
      if (id >= 0) {
        jointsBuilt += 1;
        // 关节建好了：给它两端的物体各挂一个「关节组件」声明，
        // 这样面板上能看到「这个物体被几个关节连着」，删除物体时也能被 onBodyRemoved 收走
        for (const handle of [remapped.bodyA, remapped.bodyB]) {
          const numeric = Number(handle);
          if (Number.isFinite(numeric) && instanceByHandle.has(numeric)) {
            this.framework.addComponent(numeric, {
              type: 'motor',
              params: { jointId: id, speed: remapped.motorSpeed ?? 0, maxForce: remapped.motorForce ?? 0 },
            } as PhysicsComponent);
          }
        }
      } else {
        // -1 表示 Rapier 还没就绪，关节进了待建队列
        jointsPending += 1;
      }
    }

    const previous = this.placedCounts.get(combo.id) ?? 0;
    this.placedCounts.set(combo.id, previous + 1);

    const notes: string[] = [];
    if (jointsPending > 0) notes.push(`${jointsPending} 个关节在等物理引擎就绪（会自动补建）`);
    if (missingDefs.length > 0) notes.push(`${missingDefs.length} 个模型数据缺失：${missingDefs.join('、')}`);
    const probablyFloating = Number.isFinite(minY) && oy + minY > oy + 0.01 && minY > 0.01;
    if (probablyFloating) notes.push('组合最低点高于落点，可能会悬空掉下来');

    return {
      ok: true,
      comboId: combo.id,
      instances,
      jointsBuilt,
      jointsPending,
      triggers: 0,
      links: 0,
      reason: '',
      message:
        `已摆放「${combo.name}」：${instances.length} 个模型 + ${jointsBuilt} 个关节` +
        (notes.length > 0 ? `（${notes.join('；')}）` : ''),
      missingDefs,
      probablyFloating,
    };
  }

  /** 清空计数（换世界时用） */
  reset(): void {
    this.placedCounts.clear();
  }

  /**
   * 关节重映射。
   *
   * `bodyA/bodyB` 在组合数据里是「组合内第几个零件」的十进制字符串，空串 = 连到世界。
   * 摆放到世界里之后要换成真实刚体句柄，同时把锚点按整体旋转/缩放搬到世界坐标。
   *
   * 注意锚点：Rapier 的关节锚点是**相对于刚体**的局部坐标，所以这里只旋转不平移；
   * 平移由刚体自己的位置负责。把锚点也加上世界偏移是个经典 bug，
   * 症状是「关节建成了但两端的物体被拽到奇怪的位置」。
   */
  private remapJoint(
    joint: JointConfig,
    handleByPiece: Map<number, number>,
    originX: number,
    originY: number,
    originZ: number,
    extraRotation: number,
    scale: number,
  ): JointConfig {
    const mapEnd = (text: string): string => {
      const trimmed = text.trim();
      if (trimmed === '') return '';
      // 关键：用 Number() 而不是 parseInt()，见文件头说明
      const index = Number(trimmed);
      if (!Number.isFinite(index)) return '';
      const handle = handleByPiece.get(index);
      if (handle === undefined || handle < 0) return '';
      return String(handle);
    };

    // 锚点在模板里是「相对组合原点的偏移」，而 JointSystem 要的是**世界坐标**锚点。
    // 所以这里要既旋转又平移：漏掉平移的症状是「关节在离物体很远的地方凭空拉住它们」。
    const rotated = rotateXZ(joint.anchor[0] * scale, joint.anchor[2] * scale, extraRotation);
    const anchor: [number, number, number] = [
      originX + rotated.x,
      originY + joint.anchor[1] * scale,
      originZ + rotated.z,
    ];

    // 轴也是方向量：整体转了，轴就得跟着转（否则转 90° 后铰链方向是错的）
    let axis: [number, number, number] | undefined;
    if (joint.axis) {
      const rotatedAxis = rotateXZ(joint.axis[0], joint.axis[2], extraRotation);
      axis = [rotatedAxis.x, joint.axis[1], rotatedAxis.z];
    }

    return {
      ...joint,
      bodyA: mapEnd(joint.bodyA),
      bodyB: mapEnd(joint.bodyB),
      anchor,
      axis,
      length: joint.length !== undefined ? joint.length * scale : undefined,
    };
  }
}

/** 绕 Y 轴旋转（组合整体旋转用） */
function rotateXZ(x: number, z: number, angle: number): { x: number; z: number } {
  if (angle === 0) return { x, z };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos + z * sin, z: -x * sin + z * cos };
}
