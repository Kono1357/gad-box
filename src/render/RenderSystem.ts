import {
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { Object3D, Texture } from 'three';
import { CAMERA_CONFIG, RENDER_CONFIG } from '../config';
import { CHUNK_SIZE } from '../voxel/Chunk';
import type { Chunk } from '../voxel/Chunk';
import type { ChunkMeshResult } from '../voxel/ChunkMesher';
import { VoxelAtlas } from '../voxel/VoxelMaterials';
import { BrushVisualizer } from '../voxel/BrushVisualizer';
import { BuildingRenderer } from '../building/BuildingRenderer';
import { BuildingPreview } from '../building/BuildingPreview';

/** 每帧渲染后回报的统计 */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** 当前挂着网格的区块数 */
  meshedChunks: number;
}

interface AnimatedProp {
  object: Object3D;
  update(simTime: number): void;
}

interface Disposable {
  dispose(): void;
}

/**
 * 渲染系统。
 *
 * M1.5 的主要变化：
 * 1. **地形改用程序化纹理图集**（`VoxelAtlas`）—— 一个区块仍然只有一次 draw call，
 *    但每种体素的顶/侧/底三面各不相同；
 * 2. **不透明与半透明分层**：水与玻璃走第二个几何体 + 半透明材质，
 *    水面终于有"水"的样子；
 * 3. 接入了笔刷可视化、建筑 InstancedMesh 渲染、建筑幽灵预览三个子模块；
 * 4. `setChunkVisible` / `unloadChunkMesh` 供区块剔除调用。
 */
export class RenderSystem {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly atlas: VoxelAtlas;
  readonly brushVisualizer: BrushVisualizer;
  readonly buildingRenderer: BuildingRenderer;
  readonly buildingPreview: BuildingPreview;

  private readonly renderer: WebGLRenderer;
  private readonly terrainGroup = new Group();
  private readonly props = new Group();
  private readonly debugGrids = new Group();
  private readonly chunkBorderGroup = new Group();

  private readonly terrainMaterial: MeshLambertMaterial;
  private readonly waterMaterial: MeshLambertMaterial;
  private chunkBorders: LineSegments | null = null;
  private readonly animated: AnimatedProp[] = [];
  private readonly disposables: Disposable[] = [];
  private readonly textures: Texture[] = [];
  private meshedChunkCount = 0;
  private hiddenChunks = new Set<Chunk>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.camera = new PerspectiveCamera(CAMERA_CONFIG.fov, 1, CAMERA_CONFIG.near, CAMERA_CONFIG.far);
    this.camera.position.set(50, 50, 50);

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER_CONFIG.maxPixelRatio));

    const bg = new Color(RENDER_CONFIG.background);
    this.scene.background = bg;
    this.scene.fog = new Fog(RENDER_CONFIG.background, RENDER_CONFIG.fogNear, RENDER_CONFIG.fogFar);

    // 程序化纹理图集 + 两种地形材质
    this.atlas = new VoxelAtlas();
    this.disposables.push(this.atlas);
    this.atlas.texture.anisotropy = RENDER_CONFIG.anisotropy;

    this.terrainMaterial = this.track(
      new MeshLambertMaterial({
        map: this.atlas.texture,
        vertexColors: true,
        flatShading: true,
      }),
    );

    // 水与玻璃：半透明、双面（水从下面看也要有面）
    this.waterMaterial = this.track(
      new MeshLambertMaterial({
        map: this.atlas.texture,
        vertexColors: true,
        flatShading: true,
        transparent: true,
        opacity: 0.72,
        depthWrite: true,
        side: DoubleSide,
      }),
    );

    this.terrainGroup.name = 'terrain';
    this.scene.add(this.terrainGroup);

    this.brushVisualizer = new BrushVisualizer();
    this.scene.add(this.brushVisualizer.group);

    this.buildingRenderer = new BuildingRenderer();
    this.scene.add(this.buildingRenderer.group);

    this.buildingPreview = new BuildingPreview();
    this.scene.add(this.buildingPreview.group);

    this.scene.add(this.chunkBorderGroup);

    this.setupLights();
    this.setupGround();
    this.setupAxes();
    this.setupPlaceholderProps();

    this.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  /** 世界尺寸（阴影相机范围用） */
  private worldSizeX = 128;
  private worldSizeZ = 128;

  // ------------------------------------------------------------------ 场景

  private setupLights(): void {
    const hemi = new HemisphereLight(0xcfe6ff, 0x50663f, 1.55);
    hemi.position.set(0, 60, 0);
    this.scene.add(hemi);

    const sun = new DirectionalLight(0xfff3d6, 2.15);
    sun.position.set(60, 120, 40);
    // 阴影默认关闭（性能优先）：开启后由 setShadowsEnabled 配好相机与贴图
    sun.castShadow = false;
    this.sun = sun;
    this.scene.add(sun);
  }

  private setupGround(): void {
    const ground = new Mesh(
      this.track(new PlaneGeometry(1, 1, 1, 1)),
      this.track(new MeshLambertMaterial({ color: 0x46543a, flatShading: true })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.name = 'ground';
    this.groundMesh = ground;
    this.scene.add(ground);

    this.debugGrids.name = 'debug-grids';
    this.debugGrids.visible = false;
    this.scene.add(this.debugGrids);
  }

  private groundMesh: Mesh | null = null;
  private sun: DirectionalLight | null = null;
  private shadowsEnabled = false;
  private maxPixelRatio: number = RENDER_CONFIG.maxPixelRatio;

  private setupAxes(): void {
    const axes = new AxesHelper(14);
    axes.position.set(0, 0.05, 0);
    this.scene.add(axes);

    this.scene.add(this.buildAxisLabel('X', '#ff5a5a', 15.5, 0.6, 0));
    this.scene.add(this.buildAxisLabel('Z', '#5a9bff', 0, 0.6, 15.5));
    this.scene.add(this.buildAxisLabel('Y', '#7fd06a', 0, 34, 0));
  }

  private buildAxisLabel(text: string, color: string, x: number, y: number, z: number): Sprite {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 上下文，浏览器环境异常');
    ctx.font = 'bold 44px ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.textures.push(texture);

    const sprite = new Sprite(
      this.track(new SpriteMaterial({ map: texture, transparent: true, depthTest: false })),
    );
    sprite.position.set(x, y, z);
    sprite.scale.set(2, 2, 1);
    return sprite;
  }

  /** M0 的低多边形占位道具（默认隐藏，调试面板可打开） */
  private setupPlaceholderProps(): void {
    this.props.name = 'props';
    this.props.visible = false;
    this.scene.add(this.props);

    const matWood = this.mat(0x8b5a2b);
    const matLeaf = this.mat(0x4f9d3f);
    const matStone = this.mat(0x9aa3a8);
    const matWall = this.mat(0xe8e2d6);
    const matRoof = this.mat(0xc0553f);
    const matMagic = this.mat(0xc07bd8);
    const matMetal = this.mat(0x8fb4c9);

    const trunkGeo = this.track(new CylinderGeometry(0.22, 0.34, 2.6, 6));
    const crownGeo = this.track(new ConeGeometry(1.6, 3.2, 6));
    const rockGeo = this.track(new IcosahedronGeometry(1, 0));

    for (const [x, z, scale] of [
      [-24, -16, 1],
      [-30, -8, 0.82],
      [-16, -24, 1.18],
    ] as const) {
      const tree = new Group();
      const trunk = new Mesh(trunkGeo, matWood);
      trunk.position.y = 1.3;
      const crown = new Mesh(crownGeo, matLeaf);
      crown.position.y = 3.9;
      tree.add(trunk, crown);
      tree.position.set(x, 0, z);
      tree.scale.setScalar(scale);
      this.props.add(tree);
    }

    for (const [x, z, scale] of [
      [12, -26, 1.3],
      [-8, 30, 1.6],
    ] as const) {
      const rock = new Mesh(rockGeo, matStone);
      rock.position.set(x, scale * 0.55, z);
      rock.scale.set(scale * 1.1, scale * 0.75, scale);
      this.props.add(rock);
    }

    const house = new Group();
    const wall = new Mesh(this.track(new BoxGeometry(6, 3.2, 5)), matWall);
    wall.position.y = 1.6;
    const roof = new Mesh(this.track(new ConeGeometry(4.9, 2.6, 4)), matRoof);
    roof.position.y = 4.5;
    roof.rotation.y = Math.PI / 4;
    house.add(wall, roof);
    house.position.set(4, 0, -20);
    this.props.add(house);

    const windmill = new Group();
    const tower = new Mesh(this.track(new CylinderGeometry(0.55, 1, 7, 6)), matWall);
    tower.position.y = 3.5;
    const cap = new Mesh(this.track(new ConeGeometry(1.15, 1.2, 6)), matRoof);
    cap.position.y = 7.6;
    const blades = new Group();
    const bladeGeo = this.track(new BoxGeometry(0.42, 3.4, 0.14));
    for (let i = 0; i < 4; i++) {
      const blade = new Mesh(bladeGeo, matWood);
      blade.position.y = 1.9;
      const pivot = new Group();
      pivot.rotation.z = (i * Math.PI) / 2;
      pivot.add(blade);
      blades.add(pivot);
    }
    blades.position.set(0, 6.4, 1.2);
    windmill.add(tower, cap, blades);
    windmill.position.set(-30, 0, -30);
    this.props.add(windmill);
    this.animated.push({ object: blades, update: (t) => { blades.rotation.z = t * 0.9; } });

    // 时间指示器：始终可见，悬在地形之上绕圈，用来确认暂停/倍速/单步
    const orbiter = new Mesh(this.track(new BoxGeometry(1.6, 1.6, 1.6)), matMagic);
    orbiter.name = 'time-indicator';
    this.scene.add(orbiter);
    this.animated.push({
      object: orbiter,
      update: (t) => {
        orbiter.position.set(
          Math.cos(t * 0.45) * 20,
          46 + Math.sin(t * 1.3) * 1.4,
          Math.sin(t * 0.45) * 20,
        );
        orbiter.rotation.set(t * 0.7, t * 1.1, 0);
      },
    });

    const pillar = new Mesh(this.track(new CylinderGeometry(0.5, 0.5, 12, 8)), matMetal);
    pillar.position.set(20, 6, 24);
    this.props.add(pillar);
  }

  private mat(color: number): MeshLambertMaterial {
    return this.track(new MeshLambertMaterial({ color, flatShading: true }));
  }

  private track<T extends Disposable>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  // ------------------------------------------------------------------ 世界尺寸变化

  /** 世界尺寸变化时重建底板尺寸、地面网格与区块边界 */
  configureWorld(sizeX: number, sizeY: number, sizeZ: number): void {
    this.worldSizeX = sizeX;
    this.worldSizeZ = sizeZ;
    if (this.shadowsEnabled) {
      // 阴影范围跟着世界走
      this.setShadowsEnabled(false);
      this.setShadowsEnabled(true);
    }
    if (this.groundMesh) {
      this.groundMesh.geometry.dispose();
      const geometry = new PlaneGeometry(sizeX, sizeZ, 1, 1);
      this.groundMesh.geometry = geometry;
    }

    // 调试网格
    this.debugGrids.clear();
    this.debugGrids.add(this.buildGrid(sizeX, sizeZ, 4, 0x4a5f3f, 0.3, 0.02));
    this.debugGrids.add(this.buildGrid(sizeX, sizeZ, 16, 0x9ab86f, 0.75, 0.03));

    // 区块边界
    if (this.chunkBorders) {
      this.chunkBorderGroup.remove(this.chunkBorders);
      this.chunkBorders.geometry.dispose();
    }
    this.chunkBorders = this.buildChunkBorders(sizeX, sizeY, sizeZ);
    this.chunkBorders.visible = this.chunkBorderGroup.visible;
    this.chunkBorderGroup.add(this.chunkBorders);
  }

  private buildGrid(
    sizeX: number,
    sizeZ: number,
    step: number,
    color: number,
    opacity: number,
    y: number,
  ): LineSegments {
    const positions: number[] = [];
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;
    const eps = 1e-6;

    for (let x = -halfX; x <= halfX + eps; x += step) positions.push(x, y, -halfZ, x, y, halfZ);
    for (let z = -halfZ; z <= halfZ + eps; z += step) positions.push(-halfX, y, z, halfX, y, z);

    const geometry = this.track(new BufferGeometry());
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = this.track(new LineBasicMaterial({ color, transparent: true, opacity }));
    return new LineSegments(geometry, material);
  }

  private buildChunkBorders(sizeX: number, sizeY: number, sizeZ: number): LineSegments {
    const positions: number[] = [];
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;
    const chunksX = Math.ceil(sizeX / CHUNK_SIZE);
    const chunksZ = Math.ceil(sizeZ / CHUNK_SIZE);

    for (let cz = 0; cz < chunksZ; cz++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const x0 = cx * CHUNK_SIZE - halfX;
        const x1 = x0 + CHUNK_SIZE;
        const z0 = cz * CHUNK_SIZE - halfZ;
        const z1 = z0 + CHUNK_SIZE;

        positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z0, x1, 0, z1);
        positions.push(x1, 0, z1, x0, 0, z1, x0, 0, z1, x0, 0, z0);
        positions.push(x0, sizeY, z0, x1, sizeY, z0, x1, sizeY, z0, x1, sizeY, z1);
        positions.push(x1, sizeY, z1, x0, sizeY, z1, x0, sizeY, z1, x0, sizeY, z0);
        positions.push(x0, 0, z0, x0, sizeY, z0);
        positions.push(x1, 0, z0, x1, sizeY, z0);
        positions.push(x1, 0, z1, x1, sizeY, z1);
        positions.push(x0, 0, z1, x0, sizeY, z1);
      }
    }

    const geometry = this.track(new BufferGeometry());
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = this.track(
      new LineBasicMaterial({ color: 0xffcc4d, transparent: true, opacity: 0.3 }),
    );
    const lines = new LineSegments(geometry, material);
    lines.name = 'chunk-borders';
    return lines;
  }

  // ------------------------------------------------------------------ 地形网格

  /**
   * 更新区块网格。返回的几何体若为 null，表示该层没有可见面。
   * 旧几何体会在这里被释放，避免显存泄漏（区块反复编辑时很容易泄漏）。
   */
  setChunkMesh(chunk: Chunk, result: ChunkMeshResult): void {
    this.applyMesh(chunk, 'opaque', result.opaque, this.terrainMaterial);
    this.applyMesh(chunk, 'transparent', result.transparent, this.waterMaterial);
  }

  private applyMesh(
    chunk: Chunk,
    layer: 'opaque' | 'transparent',
    geometry: BufferGeometry | null,
    material: MeshLambertMaterial,
  ): void {
    const existing = layer === 'opaque' ? chunk.mesh : chunk.transparentMesh;

    if (!geometry) {
      if (existing) {
        this.terrainGroup.remove(existing);
        existing.geometry.dispose();
        if (layer === 'opaque') chunk.mesh = null;
        else chunk.transparentMesh = null;
      }
      return;
    }

    if (existing) {
      const old = existing.geometry;
      existing.geometry = geometry;
      old.dispose();
      return;
    }

    const mesh = new Mesh(geometry, material);
    mesh.name = `${layer}-${chunk.key}`;
    mesh.frustumCulled = true;
    if (layer === 'opaque') chunk.mesh = mesh;
    else chunk.transparentMesh = mesh;
    this.terrainGroup.add(mesh);
  }

  /** 卸载区块网格但保留体素数据（距离剔除用），回来时会自动重建 */
  unloadChunkMesh(chunk: Chunk): void {
    if (chunk.mesh) {
      this.terrainGroup.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      chunk.mesh = null;
    }
    if (chunk.transparentMesh) {
      this.terrainGroup.remove(chunk.transparentMesh);
      chunk.transparentMesh.geometry.dispose();
      chunk.transparentMesh = null;
    }
    chunk.dirty = true; // 让它在重新进入范围时被重建
    this.hiddenChunks.delete(chunk);
  }

  /** 剔除用：隐藏/显示某个区块的网格（不释放显存） */
  setChunkVisible(chunk: Chunk, visible: boolean): void {
    if (visible) {
      if (!this.hiddenChunks.has(chunk)) return;
      this.hiddenChunks.delete(chunk);
      if (chunk.mesh) chunk.mesh.visible = true;
      if (chunk.transparentMesh) chunk.transparentMesh.visible = true;
      return;
    }
    if (this.hiddenChunks.has(chunk)) return;
    this.hiddenChunks.add(chunk);
    if (chunk.mesh) chunk.mesh.visible = false;
    if (chunk.transparentMesh) chunk.transparentMesh.visible = false;
  }

  clearTerrain(): void {
    for (const child of [...this.terrainGroup.children]) {
      const mesh = child as Mesh;
      mesh.geometry.dispose();
      this.terrainGroup.remove(mesh);
    }
    this.hiddenChunks.clear();
    this.chunkBorderGroup.visible = false;
    void this.chunkBorderGroup;
  }

  get meshedChunks(): number {
    return this.meshedChunkCount;
  }

  // ------------------------------------------------------------------ 开关

  setWireframe(enabled: boolean): void {
    this.terrainMaterial.wireframe = enabled;
    this.terrainMaterial.needsUpdate = true;
  }

  setChunkBordersVisible(visible: boolean): void {
    this.chunkBorderGroup.visible = visible;
  }

  setDebugGridsVisible(visible: boolean): void {
    this.debugGrids.visible = visible;
  }

  setPropsVisible(visible: boolean): void {
    this.props.visible = visible;
  }

  /**
   * 开关阴影。
   *
   * 阴影是"画质优先"预设里唯一明显吃性能的东西，所以默认关闭；
   * 打开时给平行光配一块覆盖世界的正交阴影相机，
   * 并让地形与建筑参与投射/接收。
   */
  setShadowsEnabled(enabled: boolean): void {
    if (this.shadowsEnabled === enabled) return;
    this.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;

    if (this.sun) {
      this.sun.castShadow = enabled;
      if (enabled) {
        const size = Math.max(this.worldSizeX, this.worldSizeZ) * 0.6;
        const camera = this.sun.shadow.camera;
        camera.left = -size;
        camera.right = size;
        camera.top = size;
        camera.bottom = -size;
        camera.near = 1;
        camera.far = 600;
        camera.updateProjectionMatrix();
        this.sun.shadow.mapSize.set(1024, 1024);
        this.sun.shadow.bias = -0.0012;
      }
    }

    for (const child of this.terrainGroup.children) {
      child.castShadow = enabled;
      child.receiveShadow = enabled;
    }
    if (this.groundMesh) this.groundMesh.receiveShadow = enabled;
    for (const mesh of this.buildingRenderer.group.children) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
  }

  get hasShadows(): boolean {
    return this.shadowsEnabled;
  }

  /**
   * 设置像素比上限。
   * 「抗锯齿」在 WebGL 里是上下文创建参数，运行时切换需要重建渲染器
   * （会导致所有 GPU 资源重传、画面闪一下），所以画质预设用**超级采样**来表达它：
   * 关掉抗锯齿时把像素比压到 1，开启时放到设备上限。
   */
  setMaxPixelRatio(ratio: number): void {
    this.maxPixelRatio = Math.max(0.5, Math.min(ratio, 3));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.setSize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
  }

  get pixelRatioLimit(): number {
    return this.maxPixelRatio;
  }

  // ------------------------------------------------------------------ 运行

  update(simTime: number): void {
    for (const prop of this.animated) prop.update(simTime);
  }

  render(): RenderStats {
    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info;

    // 统计实际有网格的区块数（可见的那些）
    let meshed = 0;
    for (const child of this.terrainGroup.children) {
      if ((child as Mesh).visible && (child as Mesh).geometry.getAttribute('position')) meshed++;
    }
    this.meshedChunkCount = meshed;

    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      meshedChunks: meshed,
    };
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * GPU 侧的实时计数（补充 4：资源面板用）。
   *
   * 这三个数是 Three.js 自己维护的，反映的是**当前还活着**的 GPU 对象数：
   * `geometries` / `textures` 在调用 `dispose()` 后会立刻减少。
   * 所以「连续切五次地图，几何数应当回到同一水平」就是判断有没有泄漏最直接的办法。
   * `programs` 是编译过的 shader 程序数，正常情况下几个世界切来切去都不会变。
   */
  get gpuMemoryInfo(): { geometries: number; textures: number; programs: number } {
    const memory = this.renderer.info.memory;
    const programs = this.renderer.info.programs?.length ?? 0;
    return { geometries: memory.geometries, textures: memory.textures, programs };
  }

  /** WebGL 渲染器信息，性能面板直接显示 */
  get rendererInfo(): string {
    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const value = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (typeof value === 'string') return value.slice(0, 42);
    }
    return `WebGL${this.renderer.capabilities.isWebGL2 ? '2' : '1'}`;
  }

  dispose(): void {
    this.animated.length = 0;
    this.brushVisualizer.dispose();
    this.buildingRenderer.dispose();
    this.buildingPreview.dispose();
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.renderer.dispose();
    void this.canvas;
  }
}
