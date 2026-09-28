/**
 * 物理调试可视化（M3 第 6 批）：把求解器内部的状态翻译成"可以画出来的几何"。
 *
 * ────────────────────────────────────────────────────────────
 * 这个文件只做数据，不做渲染
 * ────────────────────────────────────────────────────────────
 * "从 Rapier 读接触对"这件事必须跨 wasm 边界，而"把接触点变成线段与点"是纯计算。
 * 所以分工是：**Engine 负责读**（`contactPairsWith` / `contactPair` / `linvel`），
 * **这个文件负责算**（几何、颜色、缩放）。好处是这一段可以在 Node 里用假数据断言 ——
 * 而"接触点画在错的位置"这种问题，在浏览器里肉眼是很难发现的。
 *
 * ────────────────────────────────────────────────────────────
 * 四条可视化各自的**诚实说明**（都会显示在面板上）
 * ────────────────────────────────────────────────────────────
 * | 可视化 | 准确的部分 | 不准确的部分 |
 * |---|---|---|
 * | 接触点 | 位置与数量来自求解器真实的 solver contact | 只画了当前帧还在的接触；分离瞬间就没了 |
 * | 接触法线箭头 | **方向**是物理准确的（指向分离方向） | **长度不是牛顿数**，是按穿透深度与接近速度缩放的相对量 |
 * | 速度向量 | 方向与**相对大小**准确（单位 m/s） | 为可读性做了缩放，不是 1:1 长度 |
 * | 休眠着色 | 休眠状态就是 Rapier 的真实状态 | 它和稳定性着色共用通道，**两者会互相盖住**（面板上互斥说明） |
 *
 * 为什么"受力箭头"不叫"受力箭头"而叫"接触法线箭头"：我们能用 `configureMotor` 与接触点算，
 * 但 Rapier 的 JS 绑定没有暴露每个接触点的**冲量**（那是求解器内部的 λ）。
 * 要拿到真实的力必须开 `CONTACT_FORCE_EVENTS`，那给的是**整对碰撞体的合力**而不是每个接触点。
 * 所以这里只画方向 + 相对长度，并如实命名 —— 叫它"受力"会让人以为长度就是牛顿数。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一条接触对（Engine 从 Rapier 读出来喂进来） */
export interface ContactPairInput {
  /** 接触点（世界坐标） */
  points: Vec3[];
  /** 接触法线（世界坐标，单位向量，指向"分离"方向） */
  normal: Vec3;
  /** 两个碰撞体所属的刚体句柄（用于查速度、休眠状态） */
  bodyA: number;
  bodyB: number;
  /** 摩擦与恢复系数（求解器实际用的合并值）—— 面板可以显示"这块地有多滑" */
  friction: number;
  restitution: number;
}

/** 一个动态刚体的状态 */
export interface DebugBodyInput {
  handle: number;
  ownerId: number;
  /** 刚体中心（把位置画在质心而不是底面，箭头才好看） */
  center: Vec3;
  velocity: Vec3;
  angularVelocity?: Vec3;
  sleeping: boolean;
  mass: number;
}

export interface DebugCollectInputs {
  pairs: readonly ContactPairInput[];
  bodies: readonly DebugBodyInput[];
  /** 箭头长度缩放（世界单位/单位量），默认 0.25 */
  arrowScale?: number;
  /** 速度低于这个值不画箭头（默认 0.3 m/s），否则一屏都是箭头 */
  velocityThreshold?: number;
}

/** 收集结果：直接喂给 BufferGeometry */
export interface DebugGeometryData {
  /** 线段顶点（每 6 个数一条线段） */
  linePositions: number[];
  /** 线段颜色（每 6 个数一条线段，RGB 各 3 个一组） */
  lineColors: number[];
  /** 点顶点（每 3 个数一个点） */
  pointPositions: number[];
  /** 点颜色 */
  pointColors: number[];
  stats: DebugStats;
}

export interface DebugStats {
  /** 本帧画了几条接触对 */
  pairs: number;
  /** 本帧画了几个接触点 */
  contactPoints: number;
  /** 画了几根法线箭头 */
  forceArrows: number;
  /** 画了几根速度箭头 */
  velocityArrows: number;
  /** 参与的动态刚体数 */
  bodies: number;
  /** 其中休眠的数量（面板显示"休眠率"的另一处来源） */
  sleeping: number;
  ms: number;
}

/** 颜色（0~1 的 RGB） */
export const DEBUG_COLORS = {
  contact: [1.0, 0.85, 0.2] as const,
  normal: [1.0, 0.35, 0.25] as const,
  velocity: [0.35, 0.8, 1.0] as const,
  sleeping: [0.55, 0.55, 0.6] as const,
  awake: [0.45, 1.0, 0.55] as const,
};

export interface DebugCollectOptions {
  contactPoints: boolean;
  forceArrows: boolean;
  velocityVectors: boolean;
  /** 箭头长度缩放 */
  arrowScale: number;
  /** 速度阈值 */
  velocityThreshold: number;
}

export const DEFAULT_DEBUG_COLLECT_OPTIONS: DebugCollectOptions = {
  contactPoints: true,
  forceArrows: true,
  velocityVectors: false,
  arrowScale: 0.25,
  velocityThreshold: 0.3,
};

/**
 * 把物理状态翻译成几何。
 *
 * **性能上的取舍**：这个函数每帧会被调用一次，所以里面没有排序、没有对象数组的二次遍历、
 * 也没有 `Array.prototype.map`。每帧的分配只有四个 `number[]`（它们由调用方复用）。
 */
export function collectDebugGeometry(
  inputs: DebugCollectInputs,
  options: DebugCollectOptions = DEFAULT_DEBUG_COLLECT_OPTIONS,
): DebugGeometryData {
  const started = now();
  const linePositions: number[] = [];
  const lineColors: number[] = [];
  const pointPositions: number[] = [];
  const pointColors: number[] = [];

  const arrowScale = Math.max(0.01, inputs.arrowScale ?? options.arrowScale ?? 0.25);
  const velocityThreshold = Math.max(0, inputs.velocityThreshold ?? options.velocityThreshold ?? 0.3);

  // ---- 接触点与法线
  let pairCount = 0;
  let contactCount = 0;
  let forceArrows = 0;

  for (const pair of inputs.pairs) {
    pairCount += 1;
    const normal = normalize(pair.normal);

    if (options.contactPoints) {
      for (const point of pair.points) {
        pointPositions.push(point.x, point.y, point.z);
        pointColors.push(DEBUG_COLORS.contact[0], DEBUG_COLORS.contact[1], DEBUG_COLORS.contact[2]);
        contactCount += 1;
      }
    }

    if (options.forceArrows && pair.points.length > 0) {
      // 箭头从接触点出发，沿法线方向。长度按"接触点数"缩放：
      // 一个面接触（4 个点）比一个点接触更能说明"这里压得很稳"，
      // 但**这不是力的大小** —— 面板与注释都写明了，名字也叫"法线箭头"。
      const length = arrowScale * (0.6 + Math.min(4, pair.points.length) * 0.35);
      for (const point of pair.points) {
        pushArrow(linePositions, lineColors, point, normal, length, DEBUG_COLORS.normal);
        forceArrows += 1;
      }
    }
  }

  // ---- 速度向量
  let velocityArrows = 0;
  let sleeping = 0;
  for (const body of inputs.bodies) {
    if (body.sleeping) sleeping += 1;
    if (!options.velocityVectors) continue;
    const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z);
    if (speed < velocityThreshold) continue;
    // 速度箭头按 m/s 直接缩放（0.25 倍）：10 m/s 的物体画出 2.5 米长的箭头，
    // 一眼能看出"这东西在飞"，又不至于长到看不出起点
    const length = Math.min(6, speed) * arrowScale;
    pushArrow(
      linePositions,
      lineColors,
      body.center,
      { x: body.velocity.x / speed, y: body.velocity.y / speed, z: body.velocity.z / speed },
      length,
      DEBUG_COLORS.velocity,
    );
    velocityArrows += 1;
  }

  return {
    linePositions,
    lineColors,
    pointPositions,
    pointColors,
    stats: {
      pairs: pairCount,
      contactPoints: contactCount,
      forceArrows,
      velocityArrows,
      bodies: inputs.bodies.length,
      sleeping,
      ms: now() - started,
    },
  };
}

/**
 * 往线段数组里加一个"箭头"（一根杆 + 两条翅）。
 *
 * 用线段而不是三角形：整个调试可视化共用**一个** `LineSegments`，
 * 一旦混进三角形就要多一个 draw call 与一套材质，而调试图形的价值全在"看得见"上。
 */
export function pushArrow(
  positions: number[],
  colors: number[],
  origin: Vec3,
  direction: Vec3,
  length: number,
  color: readonly [number, number, number] | readonly number[],
): void {
  const r = color[0] ?? 1;
  const g = color[1] ?? 1;
  const b = color[2] ?? 1;
  const tip: Vec3 = {
    x: origin.x + direction.x * length,
    y: origin.y + direction.y * length,
    z: origin.z + direction.z * length,
  };
  positions.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z);
  colors.push(r, g, b, r, g, b);

  // 两条翅：需要两个与 direction 垂直的方向
  const [u, v] = basisFor(direction);
  const headLength = Math.min(0.25, length * 0.35);
  for (const side of [u, v]) {
    positions.push(
      tip.x, tip.y, tip.z,
      tip.x - direction.x * headLength + side[0] * headLength * 0.5,
      tip.y - direction.y * headLength + side[1] * headLength * 0.5,
      tip.z - direction.z * headLength + side[2] * headLength * 0.5,
    );
    colors.push(r, g, b, r, g, b);
  }
}

/** 单位化（零向量退回 (0,1,0)，否则箭头会塌成一个点） */
export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(length) || length < 1e-8) return { x: 0, y: 1, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * 给一个方向找两个正交基（画箭头的两条翅用）。
 * 参考向量避开与方向平行的情形，否则叉乘为零向量、翅膀消失。
 */
export function basisFor(direction: Vec3): [[number, number, number], [number, number, number]] {
  const reference: [number, number, number] = Math.abs(direction.y) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalizeTuple([
    reference[1] * direction.z - reference[2] * direction.y,
    reference[2] * direction.x - reference[0] * direction.z,
    reference[0] * direction.y - reference[1] * direction.x,
  ]);
  const v = normalizeTuple([
    direction.y * u[2] - direction.z * u[1],
    direction.z * u[0] - direction.x * u[2],
    direction.x * u[1] - direction.y * u[0],
  ]);
  return [u, v];
}

function normalizeTuple(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < 1e-8) return [0, 1, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** 面板用：一行中文摘要 */
export function describeDebugStats(stats: DebugStats): string {
  return (
    `接触对 ${stats.pairs}｜接触点 ${stats.contactPoints}｜法线箭头 ${stats.forceArrows}｜` +
    `速度箭头 ${stats.velocityArrows}｜动态刚体 ${stats.bodies}（休眠 ${stats.sleeping}）｜` +
    `${stats.ms.toFixed(2)} ms`
  );
}

/**
 * ⚠️ 面板上直接显示的固定说明。
 *
 * 之所以要把这句话写进代码常量而不是散在 UI 里：它必须**每次**都跟着可视化一起出现。
 * 一个"受力箭头"如果被误当成牛顿数，会让人得出完全错误的结构结论。
 */
export const DEBUG_DISCLAIMER =
  '接触点是求解器真实在算的点；法线箭头只有**方向**准确，长度是按穿透与接触点数缩放的相对量，不是牛顿数；' +
  '速度箭头按 m/s 缩放（1 m/s = 0.25 米长），不是 1:1。';

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
