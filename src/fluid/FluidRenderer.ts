/**
 * 流体渲染（M4 第二部分 · 第 2 批）。
 *
 * ────────────────────────────────────────────────────────────
 * 三种渲染风格，为什么这么分
 * ────────────────────────────────────────────────────────────
 * - **粒子（particles）**：一条 `InstancedMesh` 画所有粒子，每个粒子一个小球/方盒。
 *   最便宜、最"看得清物理"，手机上默认用这个。
 * - **表面（surface）**：把粒子密度场重建出**连续液面**（见 FluidSurface）。
 *   好看，但每帧要多一次网格重建 —— 只在桌面上给，且可以关。
 * - **混合（mixed）**：表面 + 少量粒子点缀（表面重建分辨率之外的水花）。
 *
 * ────────────────────────────────────────────────────────────
 * 关键实现选择：**一条 InstancedMesh 画全部粒子**
 * ────────────────────────────────────────────────────────────
 * 20000 个粒子如果各自一个 Mesh，就是 20000 次 draw call —— 桌面也扛不住。
 * 用 `InstancedMesh` 之后是 **1 次** draw call（每个实例只写一个矩阵 + 一个颜色）。
 * 这与 `BuildingRenderer` 的做法一致（那里按模型 id 合批）。
 *
 * ⚠ 上限固定：`InstancedMesh` 的容量在创建时定死，之后不能改。
 * 所以这里按"粒子上限"一次性分配，实际绘制数量用 `mesh.count` 控制 ——
 * 这就是 `count` 必须在 `[0, capacity]` 内的原因（写超了会画出一堆原点处的粒子，
 * 看起来像"世界的中心有一坨水"）。
 *
 * ────────────────────────────────────────────────────────────
 * 视锥剔除（需求里的"视锥外暂停模拟"是模拟层的事，这里只说渲染）
 * ────────────────────────────────────────────────────────────
 * 逐粒子做视锥判断对 20000 个粒子来说太贵，所以这里用**相机距离 + 粗包围球**：
 * 每个粒子与相机水平距离超过 `visibleRadius` 就不写矩阵（记到 `culled` 里）。
 * 这是"距离剔除"，不是精确视锥 —— 如实写在这里，别把它当成视锥剔除。
 */

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { ParticlePool } from './ParticlePool';
import type { FluidConfig } from './FluidPresets';

export type FluidRenderStyle = 'particles' | 'surface' | 'mixed';

export interface FluidRendererOptions {
  /** 粒子上限（决定 InstancedMesh 容量） */
  capacity: number;
  /** 粒子半径（米） */
  particleRadius: number;
  /** 初始风格 */
  style?: FluidRenderStyle;
  /** 是否用球体（贵一点但更像水珠）。false 用方盒（省一半三角形） */
  spheres?: boolean;
}

export interface FluidRenderStats {
  /** 实际写进 InstancedMesh 的粒子数 */
  drawn: number;
  /** 因为超出可见距离而没画的 */
  culled: number;
  /** 被容量截断的（正常情况下应为 0 —— 容量就是粒子上限） */
  overflow: number;
  /** 这一帧写矩阵花了多少毫秒 */
  ms: number;
}

export class FluidRenderer {
  readonly group = new Group();
  private mesh: InstancedMesh;
  private readonly geometry: SphereGeometry | BoxGeometry;
  private readonly material: MeshLambertMaterial;
  private readonly capacity: number;
  private style: FluidRenderStyle;
  private readonly matrix = new Matrix4();
  private readonly scaleVector = new Vector3();
  private readonly color = new Color();
  private config: FluidConfig;
  /** 可见距离（米）：超出就不画（距离剔除，不是精确视锥） */
  visibleRadius = 90;
  private stats: FluidRenderStats = { drawn: 0, culled: 0, overflow: 0, ms: 0 };

  constructor(options: FluidRendererOptions, config: FluidConfig) {
    this.capacity = Math.max(1, Math.floor(options.capacity));
    this.config = config;
    this.style = options.style ?? 'particles';
    // 球体：12×8 分段 = 约 160 个三角形/实例。20000 个实例 = 320 万三角形，
    // 桌面还行，手机不行 —— 所以手机档在建这个渲染器时会用方盒（12 个三角形）
    this.geometry = options.spheres === false
      ? new BoxGeometry(config.particleRadius * 2, config.particleRadius * 2, config.particleRadius * 2)
      : new SphereGeometry(config.particleRadius, 10, 7);
    this.material = new MeshLambertMaterial({
      color: config.color,
      transparent: true,
      opacity: config.opacity,
      flatShading: true,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    // 粒子的包围球每帧都在变；开着它会让整批粒子在相机转过来时"整块消失/出现"
    this.mesh.frustumCulled = false;
    this.mesh.name = 'fluid-particles';
    // 逐实例颜色：岩浆要发光、油要暗一点，混在一起倒的时候能分辨
    this.mesh.instanceColor = null;
    this.group.add(this.mesh);
    this.applyStyle();
  }

  get renderStyle(): FluidRenderStyle {
    return this.style;
  }

  get renderStats(): FluidRenderStats {
    return this.stats;
  }

  /** 当前绘制的实例数（面板显示用） */
  get instanceCount(): number {
    return this.mesh.count;
  }

  get meshRef(): InstancedMesh {
    return this.mesh;
  }

  setStyle(style: FluidRenderStyle): void {
    this.style = style;
    this.applyStyle();
  }

  /**
   * 风格落地。
   *
   * `surface` / `mixed` 时把粒子**画小一点**（0.6 倍）并降低不透明度：
   * 这样表面网格是主体、粒子是点缀，不会互相糊在一起。
   * 真正的表面网格由 `FluidSurface` 负责，这里只调整粒子这一层。
   */
  private applyStyle(): void {
    const scale = this.style === 'particles' ? 1 : 0.6;
    this.scaleVector.set(scale, scale, scale);
    this.material.opacity = this.style === 'particles' ? this.config.opacity : this.config.opacity * 0.5;
    this.material.needsUpdate = true;
  }

  /** 切换流体类型：换颜色与透明度（**不**改变已有粒子的位置，只是染色） */
  setFluidConfig(config: FluidConfig): void {
    this.config = config;
    this.material.color.setHex(config.color);
    this.material.opacity = this.style === 'particles' ? config.opacity : config.opacity * 0.5;
    this.material.needsUpdate = true;
  }

  /**
   * 按粒子池刷新实例矩阵。
   *
   * @param camera 相机位置（用于距离剔除）。不传则全部绘制（断言/离屏场景用）。
   */
  sync(pool: ParticlePool, camera?: { x: number; y: number; z: number }): FluidRenderStats {
    const started = now();
    const { posX, posY, posZ, alive } = pool;
    let drawn = 0;
    let culled = 0;
    let overflow = 0;
    const radius2 = this.visibleRadius * this.visibleRadius;

    // 只遍历到高水位：手机端上限 3000、实际只倒 300 个时能省 90% 的循环
    const high = pool.highWater;
    for (let i = 0; i < high; i += 1) {
      if (alive[i] !== 1) continue;
      if (drawn >= this.capacity) {
        overflow += 1;
        continue;
      }
      const x = posX[i]!;
      const y = posY[i]!;
      const z = posZ[i]!;
      if (camera) {
        const dx = x - camera.x;
        const dy = y - camera.y;
        const dz = z - camera.z;
        if (dx * dx + dy * dy + dz * dz > radius2) {
          culled += 1;
          continue;
        }
      }
      // 直接写矩阵：不建临时 Vector3（热路径零分配）
      this.matrix.makeScale(this.scaleVector.x, this.scaleVector.y, this.scaleVector.z);
      this.matrix.setPosition(x, y, z);
      this.mesh.setMatrixAt(drawn, this.matrix);
      drawn += 1;
    }

    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.stats = { drawn, culled, overflow, ms: now() - started };
    return this.stats;
  }

  /**
   * 逐实例染色（同一帧里混了水与岩浆时用；不调用则全部用材质颜色）。
   *
   * 注意：**染的是"绘制顺序里的实例"**，而绘制顺序是"活跃粒子按下标顺序"。
   * 所以调用方给的 `colors` 必须与 `sync()` 用同一个顺序生成（当前实现就是
   * 按 `pool.highWater` 顺序遍历活跃粒子）。如果哪天改成排序绘制，这里必须同步改。
   */
  writeInstanceColors(_pool: ParticlePool, colors: Float32Array): void {
    const count = Math.min(this.mesh.count, Math.floor(colors.length / 3));
    this.color.setRGB(1, 1, 1);
    for (let i = 0; i < count; i += 1) {
      this.color.setRGB(colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!);
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.group.remove(this.mesh);
    this.group.clear();
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
