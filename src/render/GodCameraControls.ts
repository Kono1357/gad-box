import { MathUtils, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { CAMERA_CONFIG } from '../config';
import type { InputSystem, PointerDragEvent } from '../input/InputSystem';

/** 初始注视点高度：大致位于地形平均地表之上，打开就能看到地形 */
const INITIAL_TARGET_Y = 12;

/**
 * 相机状态快照（存档用）。
 * 结构与 save/SaveSystem 的 SavedCamera 一致 —— 刻意不互相 import，
 * 避免 render/ 与 save/ 之间产生依赖。
 */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  radius: number;
  theta: number;
  phi: number;
}

/**
 * 上帝视角轨道相机控制器。
 *
 * 采用"注视点 + 球坐标"模型：
 *   position = target + radius * (sinφ·sinθ, cosφ, sinφ·cosθ)
 * 其中 φ（极角）越小越接近正上方俯视 —— 天然适合沙盘。
 *
 * 操作映射：
 * - 左键 / 中键拖拽 → 旋转
 * - 右键拖拽、双指拖拽 → 平移（沿地面）
 * - 滚轮、捏合 → 缩放
 * - WASD 平移，Q/E 升降，Shift 加速，F 复位
 *
 * ⚠️ M1 起左键要交给地形笔刷，届时把 `leftDragOrbit` 置为 false。
 */
export class GodCameraControls {
  /** 左侧拖拽是否旋转视角（M1：编辑模式置为 false，左键交给笔刷） */
  leftDragOrbit = true;

  /** 相机注视点。M1 起初始高度抬到地表附近，更适合观察体素地形 */
  readonly target = new Vector3(0, INITIAL_TARGET_Y, 0);
  /** 与注视点的距离（米） */
  radius: number = CAMERA_CONFIG.initialRadius;
  /** 方位角（弧度，绕 Y 轴） */
  theta: number = CAMERA_CONFIG.initialTheta;
  /** 极角（弧度）：0 = 正上方俯视，PI/2 = 贴地平视 */
  phi: number = CAMERA_CONFIG.initialPhi;

  private readonly right = new Vector3();
  private readonly forward = new Vector3();

  /** 世界水平半宽 / 高度上限，用于限制相机不要飞出世界（换世界时更新） */
  private boundHalfX = 96;
  private boundHalfZ = 96;
  private boundMaxY = 90;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: InputSystem,
  ) {
    // 注意：onDrag / onZoom / onKeyDown **不在这里绑定**。
    // 输入事件由 Engine 统一分发 —— 因为 M1.5 需要按修饰键把滚轮分给笔刷
    // （Alt+滚轮调半径、Ctrl+滚轮调强度），相机不能独占滚轮。
    this.apply();
  }

  /** 世界尺寸变化后更新相机限位 */
  setWorldBounds(halfX: number, halfZ: number, maxY: number): void {
    this.boundHalfX = halfX;
    this.boundHalfZ = halfZ;
    this.boundMaxY = maxY;
    this.reset();
  }

  /** 每帧调用（用真实帧间隔，不受物理暂停影响） */
  update(dt: number): void {
    const keys = this.input.keys;
    let moveX = 0;
    let moveZ = 0;
    let moveY = 0;

    if (keys.has('KeyW') || keys.has('ArrowUp')) moveZ += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) moveZ -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) moveX -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) moveX += 1;
    if (keys.has('KeyE') || keys.has('PageUp')) moveY += 1;
    if (keys.has('KeyQ') || keys.has('PageDown')) moveY -= 1;

    if (moveX === 0 && moveZ === 0 && moveY === 0) return;

    // 距离越远移动越快，保持手感一致
    const distanceScale = this.radius / CAMERA_CONFIG.referenceRadius;
    const speed =
      CAMERA_CONFIG.keyMoveSpeed *
      distanceScale *
      (this.input.shift ? CAMERA_CONFIG.fastMultiplier : 1);
    const step = speed * dt;

    // 用相机当前朝向求地面上的前 / 右方向
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();

    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.right.y = 0;
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();

    if (moveZ !== 0) this.target.addScaledVector(this.forward, moveZ * step);
    if (moveX !== 0) this.target.addScaledVector(this.right, moveX * step);
    if (moveY !== 0) this.target.y += moveY * step;

    this.clampTarget();
    this.apply();
  }

  /** 复位到初始上帝视角 */
  reset(): void {
    this.target.set(0, INITIAL_TARGET_Y, 0);
    this.radius = CAMERA_CONFIG.initialRadius;
    this.theta = CAMERA_CONFIG.initialTheta;
    this.phi = CAMERA_CONFIG.initialPhi;
    this.apply();
  }

  /** 导出相机状态（存档用） */
  getState(): CameraState {
    const p = this.camera.position;
    return {
      position: [p.x, p.y, p.z],
      target: [this.target.x, this.target.y, this.target.z],
      radius: this.radius,
      theta: this.theta,
      phi: this.phi,
    };
  }

  /** 从存档恢复相机状态 */
  setState(state: CameraState): void {
    if (Array.isArray(state.target)) {
      this.target.set(state.target[0] ?? 0, state.target[1] ?? INITIAL_TARGET_Y, state.target[2] ?? 0);
    }
    if (typeof state.radius === 'number' && Number.isFinite(state.radius)) this.radius = state.radius;
    if (typeof state.theta === 'number' && Number.isFinite(state.theta)) this.theta = state.theta;
    if (typeof state.phi === 'number' && Number.isFinite(state.phi)) this.phi = state.phi;

    this.clampTarget();
    this.radius = MathUtils.clamp(this.radius, CAMERA_CONFIG.minRadius, CAMERA_CONFIG.maxRadius);
    this.phi = MathUtils.clamp(this.phi, CAMERA_CONFIG.minPhi, CAMERA_CONFIG.maxPhi);
    this.apply();
  }

  /** 平滑地把镜头对准某个点（M1+ 用于"跳转到区块"） */
  focusOn(x: number, y: number, z: number, radius?: number): void {
    this.target.set(x, y, z);
    if (radius !== undefined) this.radius = radius;
    this.clampTarget();
    this.radius = MathUtils.clamp(this.radius, CAMERA_CONFIG.minRadius, CAMERA_CONFIG.maxRadius);
    this.apply();
  }

  // ---------------------------------------------------------------- 内部

  /** 相机自己的按键（F 复位），由 Engine 分发 */
  handleKeyDown(code: string): void {
    if (code === 'KeyF') this.reset();
  }

  /** 由 Engine 分发的拖拽事件 */
  handleDrag(e: PointerDragEvent): void {
    const isPan = e.button === 2 || e.pointers >= 2;
    if (isPan) {
      this.panBy(e.dx, e.dy);
      return;
    }
    if (e.button === 0 && !this.leftDragOrbit) return; // 左键留给笔刷
    this.orbitBy(e.dx, e.dy);
  }

  private orbitBy(dx: number, dy: number): void {
    this.theta -= dx * CAMERA_CONFIG.rotateSpeed;
    // 向下拖 → 抬高视角（更像"俯视"）
    this.phi = MathUtils.clamp(
      this.phi - dy * CAMERA_CONFIG.rotateSpeed,
      CAMERA_CONFIG.minPhi,
      CAMERA_CONFIG.maxPhi,
    );
    this.apply();
  }

  private panBy(dx: number, dy: number): void {
    const scale = CAMERA_CONFIG.panSpeed * this.radius;

    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.right.y = 0;
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();

    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();

    this.target.addScaledVector(this.right, -dx * scale);
    this.target.addScaledVector(this.forward, dy * scale);

    this.clampTarget();
    this.apply();
  }

  /** 由 Engine 分发的滚轮缩放 */
  zoomBy(delta: number): void {
    this.radius = MathUtils.clamp(
      this.radius * Math.exp(delta * CAMERA_CONFIG.zoomSpeed),
      CAMERA_CONFIG.minRadius,
      CAMERA_CONFIG.maxRadius,
    );
    this.apply();
  }

  private clampTarget(): void {
    const margin = 12;
    const halfX = this.boundHalfX + margin;
    const halfZ = this.boundHalfZ + margin;
    this.target.x = MathUtils.clamp(this.target.x, -halfX, halfX);
    this.target.z = MathUtils.clamp(this.target.z, -halfZ, halfZ);
    this.target.y = MathUtils.clamp(this.target.y, 0, this.boundMaxY);
  }

  private apply(): void {
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
  }
}
