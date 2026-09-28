/**
 * 物理材质运行时（M3 补充 1）。
 *
 * `data/physicsMaterials.ts` 是**数据**（8 种预设 + 合并规则），这个文件是**运行时**：
 * 负责回答"这个物体现在是什么材质"、"把它换成别的材质要改什么"、"这些覆盖怎么进存档"。
 *
 * ────────────────────────────────────────────────────────────
 * 一条规则：材质覆盖存在这里，而不是存在建筑实例上
 * ────────────────────────────────────────────────────────────
 * 建筑实例（`BuildingInstance`）是**几何与游戏逻辑**的数据（放哪、转多少度、属于哪个组），
 * 物理材质是**模拟参数**。混在一起会有两个后果：
 * 1. 建筑存档（`SaveSystem`）被迫理解物理概念，耦合面变大；
 * 2. 同一个实例被复制/镜像时，材质会跟着复制 —— 但玩家往往希望"复制出来的那块用钢的"。
 * 所以覆盖单独存一张表：`ownerId → materialId`，可以整体进存档、也可以整体丢弃。
 *
 * ────────────────────────────────────────────────────────────
 * 换材质要真的生效，必须改**三个**地方
 * ────────────────────────────────────────────────────────────
 * 1. `friction` / `restitution` / `density` —— 改碰撞体（Rapier 允许运行时改，
 *    改完质量会立刻重算）；
 * 2. `linearDamping` / `angularDamping` —— 改**刚体**（阻尼是刚体的属性，不是碰撞体的）；
 * 3. 已经睡着的物体要**唤醒**，否则它会带着旧参数继续睡到被撞为止，
 *    表现是"改了材质但东西没变"。
 *
 * 这三条是这个文件存在的主要理由 —— 少做任何一条，玩家都会觉得"材质系统是假的"。
 */

import {
  combineMaterials,
  getMaterial,
  materialForBuilding,
  materialForVoxel,
  type CombinedMaterial,
  type PhysicsMaterial,
} from '../data/physicsMaterials';

/** 我们用到的最小 Rapier 面 */
interface ColliderLike {
  setFriction(value: number): void;
  setRestitution(value: number): void;
  setDensity(value: number): void;
  setMass?(value: number): void;
}

interface BodyLike {
  handle: number;
  numColliders(): number;
  collider(index: number): unknown;
  setLinearDamping(value: number): void;
  setAngularDamping(value: number): void;
  wakeUp(): void;
}

interface WorldLike {
  getRigidBody(handle: number): BodyLike | null;
}

export interface MaterialChangeReport {
  ok: boolean;
  /** 改了几个碰撞体 */
  colliders: number;
  /** 是否调了唤醒 */
  woke: boolean;
  /** 中文说明 */
  detail: string;
  /** 失败原因 */
  reason?: string;
}

export interface MaterialRegistryStats {
  /** 覆盖表里有多少条 */
  overrides: number;
  /** 累计成功换过多少次材质 */
  applied: number;
  /** 累计失败次数（刚体不存在等） */
  failed: number;
  /** 按材质 id 统计当前有多少物体在用 */
  byMaterial: Record<string, number>;
}

export class PhysicsMaterialRegistry {
  /** ownerId → materialId */
  private readonly overrides = new Map<number, string>();
  private applied = 0;
  private failed = 0;
  /** 类型擦除的物理源（理由同 RigidBodyFactory：结构化类型与 Rapier 真实类型在方法参数上不兼容） */
  private readonly source: { readonly raw: unknown };

  constructor(source: { readonly raw: unknown }) {
    this.source = source;
  }

  private get world(): WorldLike | null {
    return (this.source.raw as WorldLike | null) ?? null;
  }

  get stats(): MaterialRegistryStats {
    const byMaterial: Record<string, number> = {};
    for (const materialId of this.overrides.values()) {
      byMaterial[materialId] = (byMaterial[materialId] ?? 0) + 1;
    }
    return { overrides: this.overrides.size, applied: this.applied, failed: this.failed, byMaterial };
  }

  /**
   * 某个建筑实例的材质。
   *
   * 优先级：**玩家显式指定 > 按模型 id 推断 > 按分类推断 > 兜底**。
   * 这跟 `RigidBodyFactory.resolveBodyParams` 是同一个原则（显式 > 推断 > 默认），
   * 只是那一层管"刚体参数"，这一层管"用哪个材质"。
   */
  materialFor(defId: string, ownerId?: number): PhysicsMaterial {
    if (ownerId !== undefined) {
      const override = this.overrides.get(ownerId);
      if (override) return getMaterial(override);
    }
    return materialForBuilding(defId);
  }

  /** 体素地形的材质（地形摩擦决定箱子能不能停在斜坡上） */
  materialForVoxelType(voxelId: number): PhysicsMaterial {
    return materialForVoxel(voxelId);
  }

  /** 这个物体有没有被玩家指定过材质 */
  overrideOf(ownerId: number): string | null {
    return this.overrides.get(ownerId) ?? null;
  }

  /**
   * 给一个物体指定材质。
   *
   * 即使刚体还没建（物理未就绪 / 物体不在世界里），**也先记下覆盖** ——
   * 因为玩家可能先选材质再放置，那时候"没生效"是正常的，
   * 但这不等于应该把他的选择丢掉。返回值里的 `ok: false` 会如实说明"已记录，等刚体建好会生效"。
   */
  assign(ownerId: number, materialId: string, handle?: number): MaterialChangeReport {
    const material = getMaterial(materialId);
    this.overrides.set(ownerId, material.id);

    if (handle === undefined || handle < 0) {
      return {
        ok: false,
        colliders: 0,
        woke: false,
        detail: `已记录材质「${material.name}」，但这个物体还没有刚体，等它进入物理世界后会自动生效`,
        reason: '刚体未创建',
      };
    }
    return this.applyToBody(handle, material);
  }

  /** 清除指定材质（回退到按模型推断） */
  clearOverride(ownerId: number): boolean {
    return this.overrides.delete(ownerId);
  }

  /**
   * 把材质真正写进 Rapier。
   *
   * 注意 `density` 用 `setDensity` 而不是 `setMass`：密度是材质属性，
   * 质量是密度 × 碰撞体体积的结果；直接设质量会让"同样材质、不同大小的两个箱子
   * 质量一样"，那明显不对。
   */
  applyToBody(handle: number, material: PhysicsMaterial): MaterialChangeReport {
    const body = this.world?.getRigidBody(handle) ?? null;
    if (!body) {
      this.failed += 1;
      return {
        ok: false,
        colliders: 0,
        woke: false,
        detail: `刚体 #${handle} 不存在（可能已被删除）`,
        reason: '刚体不存在',
      };
    }

    let colliders = 0;
    const count = safeColliderCount(body);
    for (let index = 0; index < count; index += 1) {
      let collider: ColliderLike | null = null;
      try {
        collider = getColliderAt(body, index);
      } catch {
        collider = null;
      }
      if (!collider) continue;
      collider.setFriction(clamp01(material.friction, 0.5));
      collider.setRestitution(clamp01(material.restitution, 0.1));
      collider.setDensity(material.density > 0 ? material.density : 700);
      colliders += 1;
    }

    // 阻尼在刚体上，不在碰撞体上 —— 这是最容易漏的一步
    body.setLinearDamping(Math.max(0, material.linearDamping));
    body.setAngularDamping(Math.max(0, material.angularDamping));
    // 睡着的东西不会用新参数，必须叫醒
    body.wakeUp();

    this.applied += 1;
    return {
      ok: true,
      colliders,
      woke: true,
      detail: `已应用材质「${material.name}」：${colliders} 个碰撞体（摩擦 ${material.friction}，弹性 ${material.restitution}，密度 ${material.density} kg/m³）`,
    };
  }

  /** 两个物体接触时的实际物理参数（面板显示"冰面上的箱子有多滑"用） */
  combinedFor(defA: string, defB: string, ownerA?: number, ownerB?: number): CombinedMaterial {
    return combineMaterials(this.materialFor(defA, ownerA), this.materialFor(defB, ownerB));
  }

  /** 一行中文摘要 */
  describe(ownerId: number, defId: string): string {
    const material = this.materialFor(defId, ownerId);
    const overridden = this.overrides.has(ownerId);
    return `${material.emoji} ${material.name}${overridden ? '（玩家指定）' : '（按模型推断）'}：${material.description}`;
  }

  /** 存档：导出覆盖表 */
  snapshot(): { ownerId: number; materialId: string }[] {
    return [...this.overrides.entries()].map(([ownerId, materialId]) => ({ ownerId, materialId }));
  }

  /**
   * 存档：恢复覆盖表。
   *
   * 容忍坏数据（存档可能来自旧版本或被手改过）：非数字 ownerId、未知材质 id 都跳过，
   * **不抛异常也不部分接受** —— 一个坏条目不该让整份存档打不开。
   */
  restore(entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { ownerId?: unknown; materialId?: unknown };
      const ownerId = Number(record.ownerId);
      const materialId = typeof record.materialId === 'string' ? record.materialId : '';
      if (!Number.isFinite(ownerId) || !materialId) continue;
      // getMaterial 对未知 id 会返回兜底材质，那样会把坏数据"洗成"合法数据，
      // 所以这里显式校验：材质 id 必须真的存在
      const material = getMaterial(materialId);
      if (material.id !== materialId) continue;
      this.overrides.set(ownerId, materialId);
      restored += 1;
    }
    return restored;
  }

  /** 物体被删除时清掉它的覆盖（避免表无限增长） */
  forget(ownerId: number): boolean {
    return this.overrides.delete(ownerId);
  }

  reset(): void {
    this.overrides.clear();
    this.applied = 0;
    this.failed = 0;
  }
}

function safeColliderCount(body: BodyLike): number {
  try {
    const count = body.numColliders();
    return Number.isFinite(count) && count > 0 ? Math.min(count, 4096) : 0;
  } catch {
    return 0;
  }
}

function getColliderAt(body: BodyLike, index: number): ColliderLike | null {
  const collider = body.collider(index) as Partial<ColliderLike> | null;
  if (!collider) return null;
  // 只要求用到的那几个方法在；缺任何一个就跳过这个碰撞体（而不是整次调用失败）
  if (
    typeof collider.setFriction !== 'function' ||
    typeof collider.setRestitution !== 'function' ||
    typeof collider.setDensity !== 'function'
  ) {
    return null;
  }
  return collider as ColliderLike;
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
