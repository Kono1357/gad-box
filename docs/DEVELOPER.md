# 上帝沙盘模拟器 · 开发者文档

> 面向**改这个仓库的人**。想玩请读 [USER_GUIDE.md](USER_GUIDE.md)；想知道哪些是近似请读 [../README.md](../README.md)。
>
> 本文每条结论都能追到代码：写了文件名（关键处带行号，行号可能会随改动漂移，用文件名搜索即可）。
> **仓库规模参考**（`find src -name '*.ts' | wc -l` 与 `wc -l`）：
> `src/` 下 **205 个 TS 文件 / 91,029 行**，其中 `src/ui/` **38 个模块 / 14,552 行**、
> `src/physics/` **31 个文件**；`src/core/Engine.ts` 单文件 **8,371 行**；
> `index.html` **1,296 行**（全部 HUD 的 DOM 骨架），`src/style.css` **1,543 行**；
> 断言代码 `scripts/verify.ts` + `scripts/checks/*.ts` 合计 **16,870 行**。

---

## 1. 架构分层与目录职责

分成六层，依赖方向**单向向下**（越靠下的层越不知道上面的事）：

| 层 | 目录 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| L0 数据 | `src/data/` | 纯数据与纯函数：体素表、394 个物品、地图与模板、材质、重力预设、关节类型、物理组合、内容包 | 只依赖 `building/types.ts` 与少量常量 |
| L1 内核 | `src/voxel/`、`src/fluid/`、`src/sand/`、`src/physics/`、`src/world/`（生成）、`src/save/`、`src/command/`、`src/selection/`、`src/group/`、`src/building/` | 世界与模拟本身 | L0 |
| L2 装配 | `src/core/`（`Engine` / `Time` / `World` / `QualityPreset`） | 把上面所有系统接起来、跑主循环、分发输入 | L0~L1 |
| L3 表示 | `src/render/`、`src/ui/` | Three.js 场景与 DOM 面板 | L0~L2（UI 只通过回调改世界） |
| L4 输入 | `src/input/`、`src/mobile/` | 鼠标 / 键盘 / 触摸 / 手势 / 设备档位 | L0 与 `appState` |
| 横切 | `src/perf/`、`src/workers/`、`src/tutorial/`、`src/placement/` | 性能度量、Worker、教学、智能放置 | 尽量只依赖纯数据 |

### 三条必须遵守的边界约定

1. **`src/data/` 不许 import Three.js / Rapier / Engine。** 这一条是整套测试体系的地基：
   正因为数据层是纯的，`npm run verify` 才能在没有浏览器、没有 WebGL 的 Node 里跑 1876 条断言。
   `perf/` 下的 `PerfHeatmap` / `StressTestReport` / `StressTestScenes` 与 `tutorial/` 下的教学表都照这条写
   （文件头注释里都写了"不 import three / Rapier / Engine"）。

2. **UI 不反向改世界。** 面板只发回调（`onTypeChange` / `onToolChange` …），
   由 `Engine` 决定怎么改。这样面板可以在 Node 里用假回调构造（断言里就是这么做的）。

3. **`index.html` 的 id 是契约。** UI 模块用 `must('#xxx')` 找节点，找不到就抛
   `UI 元素缺失：#xxx（检查 index.html）`。反过来，`index.html` 里的每个开关也必须在代码里有对应键名 ——
   曾经因为 `data-physics-debug="colliderBoxes"` 在 HTML 里出现了**两次**，
   以及新面板用了已被 M3 占用的 `id="stress-panel"`（导致"应力开关"作用到压力测试面板上），
   都是断言把 HTML 的开关清单与代码键名做**逐字比对**才抓到的。

### 目录一览（每个目录一句话）

```
src/
├── main.ts / appState.ts / config.ts / worldSize.ts    入口 / 跨模块共享状态 / 全部常量 / 三档世界尺寸
├── core/        Engine 总装与主循环、Time 固定步长、World 容器、QualityPreset、random
│                ErrorHandler / SafeMode / ResetManager / CorruptSaveExport（M5，已接线）
├── data/        voxelTypes(19 种) buildingCatalog(394) maps(4) mapTemplates(8) combos(20)
│                physicsMaterials(8) gravityPresets(5) jointTypes(6) stressTestMaps(3) contentPacks contentStats
├── voxel/       Chunk / VoxelGrid / ChunkMesher / VoxelMaterials / TerrainGenerator / BrushSystem
│                BrushVisualizer / ChunkCulling / VoxelRaycast / TerrainEditor
├── building/    BuildingSystem / BuildingRenderer / BuildingPreview / StackingSystem / SupportSurface / types
├── physics/     RapierWorld / PhysicsWorld / TerrainCollider / ColliderFactory / RigidBodyFactory
│                PhysicsMaterial / PhysicsFramework / JointFactory / JointSystem / TriggerSystem / LogicLink
│                ComboBuilder / TimeControl / BuoyancySystem / CollapseSystem / StressVisualizer / DragSystem
│                FluidRigidCoupling / PhysicsDebug / PhysicsGuard / PhysicsRecorder / PhysicsAudio
│                DistanceCulling / FrameScheduler / PhysicsSnapshot / WaterSystem / SandSystem / SupportSystem / StackSystem
├── fluid/       FluidSystem / PBFSolver / ParticlePool / SpatialHash / FluidSurface / FluidRenderer
│                FluidEditor / FluidPresets / FluidAudio / ParticleFluidField
├── sand/        SandSystem / SandPhysics / SandEditor / SandVisualizer / SandWaterInteraction
├── world/       GenerationPipeline / MapGenerators / MapPlanner / ObjectPlacer / BuildingPlanner
│                ConflictDetector / ConflictResolver / ConflictRunner / ConflictOverlay / GenerationContent
│                GenerationLogger / GenerationPreview / WorldLoader / WorldUnloader / ResourceMonitor
│                AdaptiveQuality / StressTestGenerator / FluidWorkerRunner
├── workers/     fluidWorker(+Core,+Types) / conflictWorker(+Core) / workerTypes
├── perf/        PerformanceMonitor / FrameProfiler / SlowFrameLogger / AutoDegrade / MemoryPanel
│                PerfHeatmap / PerfRecorder / StressTestReport / StressTestScenes
├── placement/   SmartPlacement / SnapPoints / HighlightRenderer / CameraTracker / ScreenEdgeArrow
├── selection/   SelectionSystem / PickupSystem
├── group/       GroupSystem / PrefabSystem / BlueprintSystem
├── tutorial/    TutorialLevel(3) / PhysicsTutorial(6) / FluidSandTutorial(6)
│                + M5：TutorialCatalog / TutorialProgress / Onboarding / Examples（已接线）
├── save/        SaveSystem(v3) / FluidSave(v1)
├── command/     CommandManager
├── render/      RenderSystem / GodCameraControls
├── input/       InputSystem
├── mobile/      MobileController / TouchInput / VirtualJoystick / DeviceCapability / HapticFeedback
│                Orientation / GestureTutorial
└── ui/          38 个模块（面板 + M5 的 PanelManager / ShortcutPanel / ThemeSwitch / HelpCenter，均已接线）
```

---

## 2. 关键模块逐个说明

### 2.1 `voxel/VoxelGrid.ts` — 体素世界的唯一入口

管理全部区块，提供读写、脏标记与局部重建队列。**坐标约定贯穿整个项目**（`VoxelGrid.ts` 顶部注释）：

- 世界坐标（米）：X/Z ∈ [-halfX, halfX)，Y ∈ [0, sizeY)
- 体素坐标（整数）：x/z ∈ [0, sizeX/sizeZ)，y ∈ [0, sizeY)
- 体素 (x,y,z) 占据 `[x-halfX, x-halfX+1) × [y, y+1) × [z-halfZ, z-halfZ+1)`

`y < 0` 返回"虚拟基岩"（`BEDROCK = getVoxelId('stone')`）：让世界底面不渲染，也防止挖穿后看到天空。
**类型与水量由 VoxelGrid 保证同步**（类型是 water ⟺ 水量 > 0）。

### 2.2 `voxel/Chunk.ts` — 区块（体素 + 水量两层）

`CHUNK_SIZE = 16`，水平 16×16、**高度等于世界高度（不做 Y 轴切分）**。
两块 `Uint8Array`：`voxels`（类型 id）与 `water`（0~255 映射到 0~1）。

```ts
static index(x, y, z) { return x + z * CHUNK_SIZE + y * CHUNK_AREA; }
```

区块还持有 `mesh`（不透明）与 `transparentMesh`（水/玻璃）两个 Three.js 网格 ——
**这是"含水的区块是 2 次 draw call"的来源**。

### 2.3 `voxel/ChunkMesher.ts` — 面剔除 + UV + AO + 水面高度

- 六个面的模板保证从面外侧看是逆时针（CCW），法线由叉积验证过；
- `uAxis` / `vAxis` 指定用哪两个世界轴做贴图坐标，于是"贴图的上方"永远对齐世界 +Y（草沿、砖缝、木纹不会倒过来）；
- 顶点级 AO 烘焙进顶点色，切它要重建全部区块网格；
- 水面高度用 `water` 层算，走独立的半透明几何体。

### 2.4 `voxel/VoxelMaterials.ts` — 程序化纹理图集

**为什么用 `DataTexture` 而不是 Canvas**：可以直接把像素写进 `Uint8Array`，
于是 `npm run verify` 能在 Node 里**真的检查每种体素的贴图有没有图案、顶面是不是绿的** —— Canvas 版本做不到。
**为什么是图集不是多张贴图**：所有贴图在一张 512×512 的图集里，一个区块仍然只有 1 次 draw call。
`PATTERNS` 是 `Record<TexturePattern, ...>`，**17 种图案**（`data/voxelTypes.ts` 的 `TexturePattern` 联合类型），
所以新增图案时 TS 会强制你在 `PATTERNS` 里补一个实现。

### 2.5 `voxel/BrushSystem.ts` — 5 形状 × 12 模式

- `BRUSH_MODES`（12 项，**数组顺序即数字键 `1~9 0 - =` 的映射**，改顺序 = 改键位）、
  `BRUSH_SHAPES`（5）、`BRUSH_FALLOFFS`（4）、`BRUSH_DIRECTIONS`（4）；
- `BRUSH_MODE_LABELS` / `BRUSH_SHAPE_LABELS` / `FALLOFF_LABELS` / `DIRECTION_LABELS` 是给 UI 的中文名，
  断言会核对"每个 id 都有中文标签"；
- **一次拖动 = 一步撤销**：`beginStroke()` 开事务，`endStroke()` 返回 `{ changes, label }`
  （`label` 形如 `笔刷拖动 · 42 格`），整体交给 `CommandManager`；
- **小数强度靠 `stochasticRound`**：强度 0.1、衰减满值时增量是 `0.1 × 6 = 0.6` 层，
  于是这一笔有 60% 概率 +1 层、40% 概率不变。

### 2.6 `building/BuildingSystem.ts` + `BuildingRenderer.ts`

- `BuildingSystem` 管实例：放置检查（`PlacementCheck { valid, reason, groundY }`）、
  自动贴地、拾取、删除、复制、旋转、镜像。检查用**纯 AABB 数学**而不是 Rapier 查询 ——
  这是修"M2.5 暂停时连点导致物体重合"那个 bug 的必然结果（Rapier 的查询管线只在 `world.step()` 里更新）。
- `BuildingRenderer` 把每个模型合并成一个顶点色几何体；**同模型的实例走一个 InstancedMesh**
  （放 200 面墙 = 1 次 draw call）。几何体按 key 缓存（`BuildingRenderer.ts:376`），
  **镜像体单独缓存一份**（顶点取反 + 索引反序，因为 `InstancedMesh` 里用负缩放会翻转法线与绕序）。

### 2.7 `building/StackingSystem.ts` + `SupportSurface.ts`

- `StackingSystem.resolve()` 决定**落点**，Rapier 决定**之后发生什么**。分工写得很清楚。
- `SupportSurface` 把"顶面"当成**一块有面积的资源**：记录总面积 / 已占用 / 剩余，
  按 `N×N` 小网格（默认 4×4）划格，每个空闲格子都是候选点。
- **缓存用"签名"而不是脏标记**（`SupportSurface.ts:87` / `:138`）：签名由焦点坐标**量化到 4 米格**
  再按 `FOCUS_MARGIN` 放大统计半径得到。早期是"镜头一动就全量重建"，实测 1.62 ms/帧；
  改签名后 0.034 ms/帧（241 个物体）。**动态物体仍然每帧重建** —— 否则"站在滚动的球上"会用到过期顶面。

### 2.8 `physics/PhysicsFramework.ts` — 四层可观测结构

按"出问题时该看哪一层"切：

| 层 | 类 | 症状 |
| --- | --- | --- |
| 1 · 刚体 | `RigidbodyLayer` | 东西不动 / 乱飞 |
| 2 · 碰撞 | `ColliderLayer` | 穿模 |
| 3 · 约束 | `JointLayer` | 该连着却散开 |
| 4 · 逻辑 | 触发器 + 逻辑连线 | 拉了没反应 |

**每一层都有中文的 `describe()` 出口**，面板（`ui/PhysicsDebugUI.ts`）直接渲染它，
不在 UI 里另写一份统计逻辑。

### 2.9 `physics/RapierWorld.ts` — 世界生命周期

只干一件事：把"Rapier 世界"从创建到销毁的每一步管清楚（加载、配置、清空、销毁、统计）。
刚体/碰撞体/关节的创建不在这里（那是三个 Factory 的活）。

**加载进度有两种模式，且面板上如实标注是哪一种**：

| 模式 | 什么时候用 | 数据来源 |
| --- | --- | --- |
| `bytes` | `vite.config.ts` 把 rapier chunk 输出成固定名 `assets/rapier.js` | `fetch` + `Content-Length` + 流式分片读，**真实字节百分比** |
| `phases` | 拿不到固定 URL / fetch 被拦 / 离线 | 四个已知阶段（下载 → wasm 实例化 → 建世界 → 就绪）的权重 |

⚠ **改 `chunkFileNames` 时必须同步 `RapierWorld.ts` 的 `RAPIER_CHUNK_FILE`**（`vite.config.ts` 注释里写了这句）。

顺带修过一个隐蔽 bug：`syncQueries()` 把 `world.timestep` 设成 0 之后**没有恢复**，
当时能正常工作纯粹是因为每帧的 `step()` 都会重新写一遍时间步。现在改成保存/恢复。

### 2.10 `physics/TerrainCollider.ts` — 区块级地形碰撞体

| 区块形态 | 用哪种碰撞体 | 理由 |
| --- | --- | --- |
| 列实心（每列从底到顶连续） | 一个 **heightfield** | 高度图对这种地形是精确的，而且只有一个碰撞体 |
| 有洞穴 / 悬挑 / 中空 | **greedy 合并的若干 cuboid** | 高度图会把空洞填实（表现是"看得见洞、走不进去"） |

- **局部更新**：改一格体素只重建那**一个区块**的碰撞体，单帧最多重建 6 个区块；M2 是全世界重建整张高度图。
- **所有区块的碰撞体挂在同一个静态刚体上**：`Engine` 与 `BuildingSystem` 都依赖 `bodyHandle` 识别"打到的是地形"。
- `greedyMerge` 是三维的（先 X、再 Z、再 Y 扩），`MAX_BOXES_PER_CHUNK = 96` 是安全阀。
- Rapier 的高度图约定（实测确认）：`heights[col*(nrows+1)+row]`，**col↔X、row↔Z**，跨度由 `scale` 决定。

### 2.11 `physics/RigidBodyFactory.ts` + `ColliderFactory.ts` + `PhysicsMaterial.ts`

- 四类刚体（fixed / dynamic / kinematicPosition / kinematicVelocity）+ 质量、阻尼、休眠、重力缩放、CCD、锁定轴。
- **参数优先级只有一处实现**：`resolveBodyParams()` 里写死「spec 显式值 > 材质值 > 全局默认」。
  任何一处绕过它直接读材质字段，"改材质没生效"的问题就会回来。
- **没有碰撞体的刚体一律拒绝创建**（那种物体看得见、穿得过，还会出现在统计里，是排查成本最高的一类"幽灵"），
  返回值里带**中文原因**，UI 直接能提示玩家。
- 碰撞分组 5 层（地形/建筑/物体/水体/触发器）+ 一张矩阵。编码是 Rapier 的约定：**高 16 位 = 成员层，低 16 位 = 过滤器**，
  `layersOf()` 能反解出来给调试面板看。**水体层不与任何东西碰撞**（浮力靠每帧施力，不靠碰撞求解）。
- 六种碰撞体形状：`cuboid` / `ball` / `cylinder` / `capsule` / `convexHull` / `trimesh`。
  - 带腿的家具**不用凸包**而是多个 `cuboid`（凸包会把椅子腿之间填满，"能从椅子底下钻过去"就没了）；
  - `trimesh` **只用于静态**（Rapier 的硬限制，代码里直接拦下动态 trimesh）；
    凸包退化（顶点不足 4 个或共线）时自动回退成包围盒并记告警。
- **换材质必须同时改三个地方**（少一个玩家就会觉得"材质系统是假的"）：
  ① 碰撞体的 `friction`/`restitution`/`density`；② **刚体**的 `linearDamping`/`angularDamping`（最容易漏）；
  ③ **唤醒刚体**（睡着的东西不会用新参数）。

### 2.12 `physics/TimeControl.ts` — 倍速与位姿回溯

- **倍速靠"每帧推进更多子步"，不改时间步**。`TIME_SCALES = [0.25, 0.5, 1, 2, 4]`。
- 回溯记录**位姿**（7 float/刚体），300 帧 ≈ 7.7 MB，**不存世界快照**
  （`world.takeSnapshot()` 是几十 KB~MB/帧，且 `restoreSnapshot` 是静态方法、返回新世界对象、所有 handle 失效）。
- 三个容易漏的细节：**写回必须清零速度**；**世代号**（换地图后 handle 重分配，旧帧必须能被识别并拒绝）；
  **回溯期间物理一步都不推**（`advance` 直接返回 0）。
- `DEFAULT_STEP_BUDGET_MS = 5`，注释里标了出处："用户给的验收线是物理求解耗时小于 5ms"。

### 2.13 `physics/FrameScheduler.ts` — 分帧调度

把倒塌判定（连通性 BFS 是 O(n²)）、应力计算、距离剔除、支撑面索引、爆炸保护巡检
放进**一个每帧 2.5 ms 的预算**里，到期的任务按"优先级 → 越久没跑越优先"排序，超预算的推到下一帧。
解决的问题很具体：它们原来各按各的固定间隔跑，**会周期性撞在同一帧**，帧时间从 6 ms 尖到 20 ms
（表现是"每隔半秒卡一下"，比平均帧率低更难忍）。

两个刻意的设计：**所有任务共用同一个时间源**（调用方传入，任务自己不读时钟，否则测试里没法复现调度顺序）；
**任务抛异常只影响它自己**。

### 2.14 `physics/FluidRigidCoupling.ts` + `BuoyancySystem.ts` + `DragSystem.ts`

| 项 | 公式 |
| --- | --- |
| 浮力 | `ρ流体 · V排开 · g · 浮力系数` |
| 阻力 | `0.5·ρ·Cd·A·|v_rel|·v_rel + λ·v_rel`（线性项是为了数值稳定，**不是**真实流体模型） |
| 冲击 | `ρ·A·(v_rel·n)²·换算系数`（动压 `ρv²/2`） |
| 扶正力矩 | `r × F浮`，r = 浮心 − 重心 |
| 角速度阻力 | `-ω · k` |

- **迭代 = 把力分 3 次施加**（不是把求解器跑 3 遍），每次用更新后的速度重算相对速度。
- **安全阀**：每个物体每帧的合力/力矩都有上限（`maxForce`），**夹住的次数被如实统计**。
- 三套预设 `COUPLING_PRESETS`（`realistic` / `game` / `exaggerated`），字段是 `buoyancyScale` / `iterations` / `drag.*`。
  ⚠ 曾经有个 bug：构造函数只设了 `config` 没设 `presetName`（字段初值是 `'game'`），
  于是 `new FluidRigidCoupling('realistic').describe()` 永远显示"游戏"。

### 2.15 `fluid/PBFSolver.ts` — PBF 求解器（纯 CPU、零分配、可被 Worker 复用）

算法（Macklin & Müller 2013 的简化实现）九步：施加重力 → **预测位置** `p* = p + v·dt` → 建空间哈希 →
算密度 → 算 λ → 位置修正 → 重复 4~6（`iterations` 次）→ 边界碰撞（地形体素 + 世界边界 + 可选刚体盒）→
**速度 = (p − p*) / dt**（这一步让 PBF 天然不会能量爆炸）。

**λ 的分母必须两项都算**（这是 M4 第 6 批抓到的真 bug）：

```
Σ_k |∇_{p_k} C_i|²  =  |(1/ρ0)·Σ_j ∇W_ij|²  +  Σ_j |(1/ρ0)·∇W_ij|²
                        ^^^ 第一项：对称排布下几乎完全抵消      ^^^ 第二项才是主体
```

只算第一项 → 分母趋近 0 → λ 被放大几千倍 → 每帧上百个粒子被"位置修正上限"兜住 → **水自己炸开**
（12 帧从 0.64 米铺到 2.19 米、平均速度 6 米/秒），而**密度误差只有 26%，看起来完全正常**。
断言里现在有一条直接盯着"位置修正被上限夹住的粒子数"。

### 2.16 `fluid/ParticlePool.ts` — SoA + 空闲链表

```ts
readonly posX/Y/Z, velX/Y/Z, prevX/Y/Z        // Float32Array
readonly density, lambda                      // Float32Array（每步重算）
readonly deltaVX/Y/Z                          // 求解中间量，避免反复写回速度
readonly frozen, alive                        // Uint8Array
private readonly freeList: Int32Array          // 空闲下标栈
```

- **为什么 SoA 而不是 `Particle[]`**：① 内存连续、缓存命中率高；② 无 GC 压力
  （每帧新建/丢弃对象会让主线程被 GC 打断，表现是**周期性掉帧**而不是持续低帧率）；
  ③ `Float32Array` 可以被 Worker 的结构化克隆**零拷贝转移**。
- **为什么用空闲链表而不是"移动最后一个来填补"**：移动填补会让**粒子下标每帧都变**，
  于是缓存里的邻域、冻结区域、耦合用的"哪些粒子属于哪个刚体"全都要重算，
  调试时还会看到"同一个粒子在两帧里位置突变"（其实是换人了）。
- `count` 是活跃粒子数；`highWater` 是历史上用过的最大下标 + 1，**也是"这个池子到底用掉多少内存"的诚实指标**。

### 2.17 `fluid/FluidSystem.ts` — 总控

把 ParticlePool（存）、SpatialHash（找邻居）、PBFSolver（算）串起来，并负责三件 solver 不该管的事：
**生成与移除**（固定种子的 RNG，所以"同一个种子泼同一桶水"是逐粒子可复现的）、
**冻结区域**（按坐标判断，不是按粒子下标）、**性能护栏**（粒子上限、每帧时间预算、LOD）。

- 粒子上限：`this.limit = Math.min(config.maxParticles, particleLimitFor(tier, isMobile))`。
- `budgetMs` 默认 4 ms（注释标了"需求里的目标"）。**超预算时跳过后续子步**（让流体慢动作），
  而不是硬算完 —— 流体视觉容错高，拖垮整帧会让操作都变卡。跳过了多少记在 `stats.skippedSubsteps`。
- **"整池静止"跳过**：平均速度连续 60 帧低于 **3.5 cm/s** 就跳过整个求解，直到有事件唤醒它。
  3.5 cm/s 是**量出来的**（PBF 是位置法，水的平均速度不会降到 0：落地后 2 秒 0.071 / 4 秒 0.031 / 6 秒 0.018 m/s）。
  阈值取 0 会让整池水永远进不了静止状态。实测静止时单帧 **0.0000 ms**。
- **粒子存世界坐标**，地形查询通过 `FluidBoundary.isSolid(x,y,z)` 回调进来 ——
  这样 FluidSystem 完全不需要知道 VoxelGrid 的存在，搬进 Worker 时也不用改协议。

### 2.18 `sand/SandSystem.ts` + `sand/SandPhysics.ts`

`SandPhysics` 是**纯函数层**（可以在 Node 里断言）：`reposeAngleFor(moisture)`（分段线性，三个锚点精确命中
0→34°、0.5→45°、1→15°）、`slideDistanceFor`（`1/tan(θ)` 夹在 [1,4]）、`sandStateOf`、`stabilityOf`、
`absorbMoisture`、`dryMoisture`、`SAND_TOOL_LABELS`（5 个工具）。

`SandSystem` 是系统层：湿度与稳定性各一个 `Uint8Array(sizeX×sizeY×sizeZ)`
（大档 192×32×192 → 各 1.18 MB，合计 2.4 MB，**只在换世界时重新分配**）。

**公开 API 刻意与旧版 `physics/SandSystem.ts` 保持同名**（`enabled` / `angleOfRepose` / `markActive` /
`markNeighborhood` / `markAllSand` / `step` / `clearActivity` / `lastStepChanges`），
这样 `Engine` 里的调用点一行都不用改 —— **换掉的是实现，不是接口**（M0~M4.1 的断言用的还是旧那份文件）。

**只有活跃格会被处理**：一池静止的沙单步 < 0.01 ms（断言里钉着）。沙崩阈值是"一步搬动 ≥ 12 格"。

### 2.19 `save/SaveSystem.ts` 与 `save/FluidSave.ts`

见 §3.5 与 §3.6。

### 2.20 `core/ErrorHandler.ts` 与 `core/SafeMode.ts`（M5 第 1 批，**已接线**）

`ErrorHandler` 采集错误（window `error` / `unhandledrejection` / canvas `webglcontextlost` / 手动 `capture()`），
四条取舍：**环形缓冲、绝不 `shift()`**；**同 message + context 只留一条并累加 `count`**；
**拿不到栈就是 `null`**（不编造、不写空字符串冒充）；**采集器自己绝不抛异常**。
`exportReport()` 除了记录本身还会带上 `limits` / `notes` —— 一份被截断过栈、被覆盖过旧记录的报告，
如果不说这两件事，读的人会以为"这就是全部错误"，那比没有报告更糟。

`SafeMode` **只是一个状态 + 一份清单**，它不认识 Engine / Three.js / DOM，**永远不会去关任何东西** ——
关的动作由 Engine 照着 `restrictions` 做。这样只有一份清单，不会出现"清单里写了关阴影、代码里忘了关"。

⚠ **接线状态（M5 第 5 批起）**：两者都**已经被 `src/core/Engine.ts` import 并构造**
（`readonly errorHandler = new ErrorHandler()`、`readonly safeMode = new SafeMode()`），
`index.html` 里有对应面板 `#error-panel`，断言模块 `scripts/checks/errors.run.ts`（99 条）
**已经登记进 `scripts/checks/runAll.mjs` 的 `ENTRIES`**，每次 `npm run verify` 都会跑。
接线的细节（`install()` 在哪调、阈值口径、限制怎么落地、为什么不自动退出）见 §9。

---

## 3. 数据模型

### 3.1 `BuildingDef`（`src/building/types.ts`）

```ts
export interface BuildingDef {
  id: string;              // 唯一，小写英文 + 下划线，可作为存档键
  name: string;            // 中文显示名
  category: string;        // 一级分类（11 个，见 data/buildingCategories.ts）
  subcategory?: string;    // 二级分类（M4 新增，用于面板过滤）
  type: 'building' | 'prop' | 'vehicle' | 'magic'
      | 'structure' | 'furniture' | 'appliance' | ...;   // M4 扩了 5 个值
  shape: 'cube' | 'cuboid' | 'cylinder' | 'sphere' | 'custom' | 'composite';
  size: [number, number, number];   // 米，必须等于 parts 的包围盒
  parts: BuildingPart[];            // 1~8 个基本几何体
  // + 密度/摩擦/弹性、isStatic / isDestructible / isPlaceable / stackable、
  //   tags / description / icon / color / lodLevels …
}

export interface BuildingPart {
  shape: 'box' | 'cylinder' | 'sphere' | 'cone';
  position: [number, number, number];   // 相对建筑原点（底面中心）
  size: [number, number, number];       // box:[宽X,高Y,深Z] cylinder/cone:[直径,高度,直径]
  rotationY?: number; rotationX?: number; rotationZ?: number;   // 弧度
  color: number;
}
```

**全项目最硬的两条约定**：

1. **原点在底面中心** → "自动贴地"就是 `position.y = 地面高度`；物理碰撞体相对它向上堆。
2. **`size` 必须等于 `parts` 的包围盒** → 否则碰撞体与视觉错位。

`PhysicsMode = 'static' | 'dynamic' | 'kinematic'` 定义在**这里**而不是 `physics/` ——
它描述的是"建筑实例的状态"，`physics/PhysicsWorld.ts` 直接复用，避免两边各定义一份。

### 3.2 目录完整性校验（模块加载时跑）

`data/buildingCatalog.ts` 的 `verifyCatalogIntegrity()` 在**模块加载时**校验两件事：
**id 全局唯一**（两个来源、14 个文件合并，重复 id 会被 `new Map` 静默覆盖 → 玩家看到"我放的石墙变成了砖墙"）
与**包围盒与 parts 一致**（只对新目录强制；M1.5 的 77 个是手写 size，其中一些刻意用"略大于 parts"表达占空间）。

⚠ `partsBounds()` / `partsMinY()` **必须处理 `rotationX/rotationZ`**（车轮、轨道、管道、传送带滚筒是放倒的圆柱）。
第一版没处理，结果 20 个物品被判成"声明尺寸与 parts 不一致"、13 个被判成"原点不在底面中心" —— **全是误判**。
**一条检查规则的实现错了，会把正确的数据全判成错的，这比数据错误更危险**（它会让人去"修正"本来是对的东西）。

### 3.3 `Chunk` 的体素 + 水量，以及 `SandVoxel` 元数据

```ts
// 体素层（每格 1 字节）
Chunk.voxels : Uint8Array   // 类型 id（0 = 空气）
Chunk.water  : Uint8Array   // 0~255 → 0~1，只有 liquid 体素才有非零值

// 沙的元数据（全世界各一份，按世界尺寸一次性分配）
SandSystem.moisture   : Uint8Array(sizeX * sizeY * sizeZ)   // 0~255 → 0~1
SandSystem.stability  : Uint8Array(sizeX * sizeY * sizeZ)   // 0~255
```

- 水量存 `Uint8` 是刻意换来的：存档体积减半、比较用整数更快。代价是 0.5 实际是 128/255 ≈ 0.50196（约 0.4% 误差）。
- 湿度的作用：决定安息角（干 34° / 湿 45° / 饱和 15°）；稳定性的作用：沙崩前的征兆，
  也是"沙掩埋压塌脆弱结构"的判据。
- **体素类型上限 256**（`Uint8Array` 存 id，当前 19 种），新增**只能在 `VOXEL_TYPES` 数组末尾追加**，
  否则会破坏已存档的世界。

### 3.4 粒子池的 SoA 布局

见 §2.16（`fluid/ParticlePool.ts`）。要点：位置/速度/上一步位置/密度/λ/临时速度增量各一个 `Float32Array`，
`frozen` 与 `alive` 是 `Uint8Array`，空闲下标在 `Int32Array` 栈里。

### 3.5 存档格式 v3（`src/save/SaveSystem.ts`）

```ts
interface SaveData {
  version: number;          // 当前 3
  seed: number;
  mapId: string | null;
  worldSize: WorldSizeId;   // 'novice' | 'standard' | 'large'
  size: { x: number; y: number; z: number };
  simTime: number;
  camera: SavedCamera;      // position / target / radius / theta / phi
  settings: SavedSettings;  // 笔刷参数 + 物理开关，读档后手感不变
  chunks: SavedChunk[];     // { cx, cz, voxels: PackedBytes, water?: PackedBytes }
  buildings: SavedBuilding[];
  groups: ...;              // v3 新增
}

interface PackedBytes { e: 'rle' | 'raw'; d: string }   // d 是 base64
```

- 存储键 `SAVE_CONFIG.storageKey = 'god-sandbox-save-v3'`，旧键 `'god-sandbox-save-v2'` 只读兼容；
  `SAVE_CONFIG.version = 3`，`autoSaveIntervalMs = 30000`，`autoSaveDebounceMs = 4000`（都在 `src/config.ts`）。
- **v1 / v2 兼容读取**用 `version >= 2` / `version >= 3` 逐字段判空，缺的按空处理；
  `version === 0` 报"存档缺少 version 字段"，`version > 3` 报"存档版本高于当前程序支持的"。
- **压缩**：`packBytes()` 先 `rleEncode`，**更小才用 RLE**，否则原样（`e: 'raw'`），再 base64。
  `unpackBytes(packed, expectedLength)` 对 `rle` 走 `rleDecode`，对 `raw` 做长度校验后 `subarray`。
  ⚠ 曾经用 `unpackBytes(packed, -1)` 表示"不知道长度"，而 `subarray(0, -1)` 会**砍掉最后一个字节**；
  现在长度写进载荷（顺带让格式自描述）。
- **撤销历史不包含水/沙的模拟结果**：模拟改动不进 `CommandManager`，否则撤销会和水流互相打架。
- **存档不含关节 / 触发器 / 逻辑连线**（id ↔ handle 映射还没做）。保存时会**明确弹提示**，不静默丢数据。

### 3.6 流体存档 v1（`src/save/FluidSave.ts`）

```ts
const FLUID_MAGIC = 0x4753464c;   // "GSFL"
const FLUID_VERSION = 1;
export const POSITION_QUANTUM = 1 / 512;   // ≈ 2 毫米
export const VELOCITY_QUANTUM = 1 / 64;    // ≈ 0.016 m/s

interface FluidSavePayload {
  magic?: number; v: number; count: number;
  bounds: { minX, minY, minZ, maxX, maxY, maxZ };   // 量化参考系
  particles: PackedBytes;                            // 位置 + 速度
  sand: PackedBytes | null;                          // 稀疏：只有非零湿度的格子
}
```

- **为什么不能直接把 `Float32Array` 塞进 JSON**：20000 粒子 × 6 个 float32 = 480 KB，
  JSON 写数字会膨胀 3~5 倍（两三兆的字符串），而 localStorage 配额只有 5 MB 左右 —— 存一次水就爆。
- 位置存的是**相对包围盒的偏移**再量化（一桶水只有几米、一条河跨几十米，固定绝对精度会在小范围浪费位数、在大范围精度不够）。
- **实测压缩率 50%**（24 字节/粒子 → 12 字节/粒子）。⚠ RLE 在这份数据上**基本帮不上忙**
  （量化后的粒子数据是高熵的），收益**全部来自量化** ——
  所以 `measure()` 里的"原始大小"按**未量化的 float32** 算；第一版写成 12 字节，于是压缩率永远显示 100%，
  等于把量化的收益藏起来了。
- 断言分三层：粒子数**精确相等**（少一个是 bug，不是精度问题）、位置/速度误差在量子内、
  损坏/版本不符/魔数不对的载荷必须报**中文错误**而不是静默返回空。
- 曾经的两个 bug：① `decode()` 在"粒子数为 0"时提前返回，于是**沙的湿度根本不会被读回来**
  （而"只弄湿了沙、没有水"是完全合法的存档）；② 上面那个 `subarray(0, -1)`。

---

## 4. 扩展指南

### 4.1 加一个物品

1. 选一个 `src/data/catalogs/*.ts`（或新建一个，然后在 `buildingCatalog.ts` 里 import 并展开）。
   用工厂函数加一条，照抄邻居的写法：
   ```ts
   structureDef({
     id: 'my_widget', name: '我的小玩意', category: '小物品', subcategory: '桌面',
     type: 'prop', shape: 'composite',
     size: [0.4, 0.3, 0.4],       // 必须等于 parts 的包围盒（校验会查，容差 0.025）
     parts: [
       { shape: 'box', position: [0, 0.15, 0], size: [0.4, 0.3, 0.4], color: 0x8899aa },
     ],
     tags: ['桌面'], description: '一句话说明',
   })
   ```
2. **必须满足的三件事**（`verifyCatalogIntegrity()` 与 `registerCustomItem()` 都会查）：
   `id` 全局唯一、`size` 等于 `parts` 包围盒、**最低点是 0**（原点在底面中心）。
   自定义物品的 id 还必须带 `custom_` 前缀。
3. `npm run typecheck` → `npm run verify`。主验证里有"物品库 id 唯一"与"包围盒一致"两条断言会兜住。
4. **不要在 `VOXEL_TYPES` 中间插体素**（那是另一件事，且会破坏旧存档）。

### 4.2 加一套地图模板

`src/data/mapTemplates.ts` 的 `MAP_TEMPLATES` 里加一条。参数只有 5 个**倍率**（不是绝对值）：

```ts
{
  id: 'my_biome', name: '我的地貌', emoji: '🌵', terrainType: 'desert',
  description: '……', recommended: '……',
  params: { heightScale: 0.9, waterRatio: 0.05, treeDensity: 0.15,
            buildingDensity: 0.3, itemDensity: 0.05, seed: 4004, size: 'standard' },
  palette: [0xd9b777, 0xe8d3a0, 0xb08d55, 0x8ba8c9],   // 缩略图 CSS 渐变用的色块
}
```

**为什么全是倍率**：换了世界尺寸之后不用重新调参数（大世界的基准数量本来就更多，再乘同一个倍率，手感一致）。
`terrainType` 是 `MapTerrainType` 联合类型（8 个值），加了新值 TS 会强制你补 `TERRAIN_TYPE_LABELS` 的中文标签。

⚠ 参数里的 `size` 要与真实入口一致 —— **体检（生成规则体检）必须和真实入口用同一套参数**，
否则它只是在验证一个不存在的世界（用新手档网格跑一个本应 standard 的模板，会造出**假冲突**，
把真 bug 埋在噪声里）。

### 4.3 加一种流体

1. `src/fluid/FluidPresets.ts`：在 `FluidType` 联合类型里加 id，在 `FLUID_PRESETS` 里加配置，
   在 `FLUID_TYPES` 数组里登记（顺序 = 面板上按钮的顺序）。
   ```ts
   mercury: { id: 'mercury', name: '汞', color: 0xb9c2cc, density: 13500,
              viscosity: ..., maxParticles: 6000, opacity: ..., ... }
   ```
2. `maxParticles` 是**护栏**而不是审美选择；最终上限是 `min(预设上限, particleLimitFor(tier, isMobile))`
   （手机一律 3000）。**加的时候要顺手想清楚"手机上够不够"**。
3. 想让它有独立的音效/视觉判断，看 `FluidAudio.ts` 里怎么用 `config` 的字段（岩浆的"沸腾"就是这么判的）。
4. 压力测试场景里的 `fluidCapacity()` 复刻了"取小"这条规则，**加预设不用改它**，但如果你改了规则，
   两处都要改（`StressTestScenes.ts` 的注释里写了这句）。

### 4.4 加一条断言

**这是本项目最重要的扩展方式** —— 所有测试都在 Node 里跑，加断言的成本是"写几行"。

1. 判断放哪个模块：13 个专题模块在 `scripts/checks/*.check.ts` + 一个 `.run.ts` 入口，
   主验证是 `scripts/verify.ts`（1043 条）。
   - 纯数据 / 纯函数 → 可以新建一个 `xxx.check.ts`，但要**同时在 `scripts/checks/runAll.mjs` 的 `ENTRIES` 里登记**，
     否则它永远不会跑（这正是 `errors.check.ts` 现在的状态）。
2. 断言的写法（照抄邻居）：
   ```ts
   check('沙土：饱和沙的安息角比干沙小（湿沙能立住、饱和沙会摊开）',
     reposeAngleFor(1) < reposeAngleFor(0),
     `干沙 ${reposeAngleFor(0)}° / 饱和 ${reposeAngleFor(1)}°`);
   ```
   - **断言名用中文**，写"在验证什么行为"，不写"测试函数 X"；
   - 第三个参数是给失败时看的**实际值**（中文或数字），**不要省略** ——
     失败信息里没有实际值，就等于要重新跑一遍才知道发生了什么；
   - 模块末尾必须打印 `结果：N 通过 / M 失败`（`runAll.mjs` 靠正则解析这一行；
     **解析不到就整块算失败**，因为"没有汇总"可能意味着脚本中途崩了却返回 0）。
3. **每条修复都要有断言**：这个项目没有浏览器、没有 CI 上的人工复现，
   断言是唯一能防回归的东西。断言要钉在**行为**上，不是钉在实现细节上。
4. **反面断言往往比正面更有价值**。例子（`savetutorial.check.ts`）：
   - "什么都不做不会通关"（空快照喂进去，六关全部不过）；
   - "该卡住的地方要卡住"（物体正在下沉时"浮力"关不通关、只有侵蚀没有淤积时"泥流"关不通关）。
5. **断言之间不许互相污染**：需要假 `document` / 假 `localStorage` 的模块必须独立进程跑
   （这是 `runAll.mjs` 存在的理由，见 §5.1）。写新模块时**不要依赖全局桩的残留**。

### 4.5 加一个 Worker

照 `workers/fluidWorker*` 或 `workers/conflictWorker*` 的三件套模式：
`xxxWorkerTypes.ts`（协议，纯类型）+ `xxxWorkerCore.ts`（**纯逻辑，不碰 DOM / Worker 全局**）+
`xxxWorker.ts`（薄壳，只做 `onmessage` 转发）+ `world/XxxRunner.ts`（主线程侧的执行器与回退）。

四条必须遵守的规矩：

1. **Node 里没有 `Worker` 全局** → 每条结果都要是 `source: 'main-thread'` + **中文回退原因**；
   **回退是默认路径，不是偶发分支**。
2. **`source` 与 `fallbackReason` 不允许自相矛盾**（回退必须说明原因，走 worker 必须没有原因）。
3. **拿不到的数字是 `null`，不谎报成 0**（打包/回传耗时没走 worker 时就是 `null`）。
4. **写回必须三重一致性校验**（容量 / `highWater` / 活跃粒子数，见 `fluidWorkerCore.ts` 的 `applyPoolDelta()`）——
   等待回包期间如果玩家倒水或抽水，池子已经变了，不加校验直接写回会让粒子**整体错位**。

### 4.6 加一个逻辑门

`physics/LogicLink.ts`：在门的联合类型里加值 → 在 `validate()` 里写清"什么算配置错误" →
在求值处加分支 → 在 `data/jointTypes.ts` / 面板枚举里补中文标签。
**"等于没设门"的配置必须当错误报出来**（没有抑制源的非门、延时 0、要求 1 个输入的与门、周期小于 50ms 的计时门）——
一个永远为真的非门是逻辑错误，不该静默生效。

### 4.7 加一个 UI 面板

1. 在 `index.html` 里加 `<aside id="my-panel" class="panel">` + `<details open><summary>标题</summary>…`，
   **放在 `#right-stack` 里面**（右侧可滚动面板栏），否则它不会出现在正确的位置。
2. 在 `src/ui/MyPanel.ts` 里写类：构造函数用 `must('#id')` 取节点（缺失就抛中文错误）；
   `update(...)` 写文本；`dispose()` 摘监听、摘事件、并且**之后任何方法都不能抛异常**（断言会调）。
3. 在 `Engine` 里实例化并接线；面板**只发回调**，不反向改世界。
4. ⚠ **id 不能与既有面板重名**：`must('#stress-panel')` 这种写法只会找到第一个，
   于是"应力开关"会作用到另一个面板上。加面板前先 `grep 'id="你的id"' index.html`。
5. `index.html` 里凡是带开关的，**键名要与代码里的 `data-*` 键逐一对应**（断言会做逐字比对）。

---

## 5. 测试体系

### 5.1 结构：esbuild 打包 + 每个模块一个独立进程

```
npm run verify
  └── node scripts/checks/runAll.mjs
        ├── 对 ENTRIES 里的每个条目：esbuild bundle → .verify/<name>.mjs
        ├── spawnSync(node .verify/<name>.mjs)   ← 每个模块一个独立进程
        ├── 从 stdout 正则解析 `结果：N 通过 / M 失败`
        └── 汇总 + 退出码（有任何失败就非 0）
```

**当前 20 个条目 / 2416 条断言**（= 14 个旧模块 1876 条 + M5 新增 6 个模块 540 条；
逐模块数字见 [../README.md](../README.md) 的表格）。

**为什么每个模块一个进程**（这是本项目最有价值的一条工程决定）：
这些模块各自要装假 `document` / 假 `localStorage` 来覆盖 DOM 与存储分支。
单独跑全绿，合到一个进程里就红，而且**红得看不出是谁的错**：

- `preview` 的 DOM 断言因为"全局里已经有 document"而失败 —— 那是别的模块留下的桩；
- `customitem` 的导入断言失败，因为它读到的 localStorage 里已经有**别人**塞进去的 120 个自定义物品
  （它假设自己拿到的是空存储）。

**当时的诱惑是改断言去迁就现状**（"接管别人留下的桩"）。但那种改法只是把症状往后推：桩会越来越多，
"谁该清理"永远说不清，下一个人照样会踩。所以从结构上解决：进程退出时内核回收全局环境，谁也没法污染谁。
代价是启动几次 Node（几十毫秒），换来的确定性非常值。

### 5.2 为什么用 esbuild + Node 而不是浏览器测试

- 项目**没有也没有条件有**浏览器端自动化（开发环境里没有浏览器，也无法截屏）；
- 但项目的绝大部分逻辑是**纯的**（数据层不 import Three.js / Rapier），
  加上写代码时坚持"能纯就纯"（连 `FluidSystem` 都把地形查询做成回调），
  所以 2416 条断言能在 Node 里覆盖到：纹理像素、面剔除、UV、AO、笔刷、物理参数、
  生成流水线、冲突检测、存档往返、教学判定、压力报告、热力图、Worker 回退、
  错误采集与安全模式、主题与面板布局、新手引导与帮助中心、**引擎接线本身**……
- **"合到一个进程里" 被明确否掉了**（见 §5.1）。

### 5.3 覆盖不到的（必须知道的边界）

- **渲染结果**：WebGL 画出来长什么样、有没有 z-fighting、颜色对不对 —— **一条都没测**；
- **真实帧率**：容器里量的是"主线程上这些活要花多少毫秒"，与帧率的关系明确（每毫秒都从 16.7 ms 里扣），
  但最终 FPS 得由人在设备上确认；
- **浏览器 Worker 真身**（`new Worker(...)` 起来、跑、回包）：只做了构建层面的验证
  （产物里两个 worker 单独成块、HTTP 200）；
- **手感、交互细节、移动端手势**：靠人。

所以每个批次末尾都会有一句"唯一未完成的验收项：浏览器端实机验证"，这不是免责声明，是事实描述。

---

## 6. 性能守则

### 6.1 热路径零分配

`fluid.check.ts` 里有一条断言直接盯着这件事：**连续 200 帧之后堆没有明显增长**。
做法：

- 粒子池、空间哈希、帧缓冲**全部预分配**（定长数组 + 写指针）；
- **绝不用 `Array.shift()`**：它会把后面所有元素往前搬，是 O(n)。
  `FrameProfiler` 用"定长数组 + 写指针"，`ErrorHandler` 用环形缓冲（文件头都写了理由）；
- 面板内部**不要"先算后节流"**：`contentStats` 曾经每帧算完再节流 DOM（1.02 ms/帧，60 FPS 下每秒 61 ms），
  改成"数据统一走 `uiTick` 节流"后均摊 0.026 ms/帧。**节流必须节在计算之前。**

### 6.2 SoA 与内存布局

- 粒子是 10 多个平行的 `Float32Array`（§2.16），不是对象数组；
- 邻居偏移缓存（7.7 MB）把邻居的相对位置缓存下来，密度与压力不再反复按随机下标读坐标。
  ⚠ 它带来了一次近似，**并且它暴露了 λ 公式的 bug**（缓存让第二次迭代用了过期几何，残差对不一致极敏感）——
  所以**位置变化之后必须立刻 `refreshOffsets()`**。

### 6.3 分帧预算

| 预算 | 值 | 出处 |
| --- | --- | --- |
| 物理求解单帧 | 5 ms | `TimeControl.DEFAULT_STEP_BUDGET_MS`（用户给的验收线） |
| 流体单帧 | 4 ms | `FluidSystem` 的 `budgetMs` 默认值（需求里的目标） |
| 周期性任务总预算 | 2.5 ms | `FrameScheduler` |
| 区块网格重建 | 4 ms/帧（至少 1 块） | `VOXEL_CONFIG.meshBudgetMs` |
| 单帧最多重建的区块碰撞体 | 6 个 | `TerrainCollider` |

⚠ **区块重建的预算曾经是"按块数"给的**（3 块/帧），而单块 3~5 ms、最慢 18 ms，
于是最坏 **24~44 ms/帧**，标准档要 12 帧、大档 48 帧才追平。改成**按时间**给预算后才是"每帧最多 4 ms"。
块数上限从 3 提到 8 只作为"便宜区块"的护栏。

### 6.4 已知的坑（都踩过，代码里留了注释）

| 坑 | 症状 | 正确做法 |
| --- | --- | --- |
| **字符串键** | 建筑障碍索引每次探针拼一次 `` `${bx},${bz}` ``，每帧 6 万次字符串分配 → 碰撞相位 23.5 ms | 用整数键 `(bx+128)*256+(bz+128)` → **10.7 ms** |
| **`subarray().sort()`** | 为了让"邻居格"的内存访问更连续而加了一次排序，**整体从 47 ms 涨到 138 ms** | 27 次随机访问比排序便宜。注释里写了"别顺手优化回来" |
| **锚点永远指向顶面中心** | 同一张桌子上只能放同一个位置的东西（第二个必然重叠被拒） | 支撑面按 4×4 小网格划格，每个空闲格都是候选点 |
| **"先算后节流"** | 面板内部节流只挡住 DOM，挡不住计算与分配 | 计算也进节流（`uiTick`） |
| **周期性任务撞同一帧** | 帧时间从 6 ms 尖到 20 ms，"每隔半秒卡一下" | 共用 `FrameScheduler` 预算并排序 |
| **缓存签名不做量化** | 镜头一动支撑面索引就全量重建（1.62 ms/帧） | 签名里焦点坐标量化到 4 米格；动态物体仍然每帧重建 |
| **LRU / 大对象缓存的失效** | ⚠ 仓库里**没有** LRU 实现；真实的缓存是这四个，失效点各不相同 | ① `CatalogPanel` 的搜索"干草堆"缓存用 `getCatalogVersion()` 判断失效（注册/注销自定义物品会 +1）；② `contentStats` 的 `CatalogIndex` 缓存；③ `SupportSurface` 的签名缓存；④ `BuildingRenderer` 按 defId 的几何体缓存（镜像体单独一份） |
| **`parseInt` 解析 Rapier 句柄** | 本项目 wasm 构建会把 u32 handle 的位模式当 f64 交回 JS（第 2 个刚体 handle 是 `5e-324`），`parseInt('5e-324')` = `5` → 关节接到完全无关的物体上 | 「字符串 ↔ 句柄」一律 `String()` / `Number()` |
| **事件队列不属于 step 的调用方** | `world.step(eventQueue)` 是事件产生的唯一时机；让 TriggerSystem 自己建队列，它拿到的永远是空的（代码看起来完全正确但永远不工作） | 事件队列由 `RapierWorldManager` 持有 |
| **`syncQueries()` 改 `timestep` 不恢复** | 靠"每帧 step 会重写时间步"掩盖 | 保存/恢复 |
| **动态 trimesh** | Rapier 的硬限制 | 代码里直接拦下并回退 |

### 6.5 距离剔除与物理 LOD

**"物理 LOD"不是"远处换简单碰撞体"** —— 那条路在 Rapier 里是负优化：
改碰撞体形状必须删旧的建新的，而删建要更新宽相位、重算质量与惯性张量，
物体在远近来来回回时这项开销比"远处那点求解成本"大得多。

真正用的是**参与度降级**：相机 24 米内完整模拟 → 静止 2 秒自然休眠 → 已休眠**且**离相机 60 米外 `setEnabled(false)`。
**冻结的代价必须写出来：它不再参与任何碰撞**。两条硬规则把它限制到"几乎看不到"：
只冻结已休眠的物体、重要物体（选中的/手里拿的/连着关节的/稳定器锁定的）永不冻结。
**唤醒是立即的、不分帧的**（漏一帧就是穿模），只有冻结分帧。

地形侧是三层剔除：距离剔除（> 渲染距离不渲染）→ 卸载剔除（> 2× 释放网格但保留数据）→ 视锥剔除；
每 6 帧重算一次，按距离升序排列以优先重建眼前的区块。

---

## 7. 调试技巧

### 7.1 控制台导出

| 从哪 | 拿到什么 |
| --- | --- |
| 压力测试面板 →「导出 JSON 报告」 | 场景指标（FPS / 中位 / p95 / 各阶段耗时 / 刚体 / 接触对 / 堆），可以直接贴进 Issue |
| 生成模板面板 →「导出最近一次生成日志」 | `GenerationLog`：每个阶段的耗时与统计、降密度重试、冲突与修复记录 |
| 内存与帧分析 →「导出性能报告」 | `FrameProfiler` 的分布 / 分位数 / 阶段拆解 + 慢帧记录 |
| 帧录制 →「导出录制 JSON / CSV」 | 环形缓冲里的 3600 帧（帧耗时 + 各阶段），满了会如实报告丢了多少帧 |
| 物理框架面板 →「打印物理诊断」 | 四层的 `describe()`：刚体/关节/触发器/连线的中文状态 |
| 性能与调试 →「打印资源清单」 | `ResourceMonitor` 的采样 + 换图记录 |

### 7.2 性能面板怎么读

- **`🧠 内存与帧分析` 的"瓶颈判断"**给的是中文结论，它是从阶段拆解推出来的。
- **阶段拆分**：`物理求解 / 水沙模拟 / 区块重建 / 支撑面索引 / 视锥剔除 / UI 面板 / 交互拾取 / 渲染提交`。
  ⚠ 早期只有"物理 / 模拟 / 渲染"三段，而"渲染"是**残差** —— 于是区块重建、支撑面、UI 全被算进"渲染"，
  面板会一本正经地报"渲染是瓶颈"，把人引到错误方向。**各段各自计时、渲染才是残差**。
- **慢帧记录**比平均值有用：它带"当时世界里有什么"（最慢阶段、区块数、刚体数），
  而且**同一原因在窗口内只留一条并累加 `repeat`**（否则连续 30 帧都在卡的时候玩家只看到"一条慢帧"，以为没事）。
  去重窗口从**首次记录**算起，不是从上次重复算起 —— 按"安静期"算的话，持续存在的问题会在记录一次后彻底消失。
- **帧时间分布**里红柱 = 该档已超预算；分位数用"排序后取下标"的朴素做法（120 帧的分布不支撑小数位）。

### 7.3 物理问题的排查顺序

1. `⚙️ 物理框架`（`F2`）四层读数：**有没有刚体、关节、触发器、连线**。多数"玄学"在这一步就定位了。
2. 打开对应的调试绘制（关节连线 / 触发器盒子 / 碰撞盒），确认**位置对不对**。
   位置画错的 bug 在浏览器里肉眼很难发现，所以 `PhysicsDebug.ts` **只做数据、不做渲染** ——
   这样"接触点画在错的位置"可以用假数据在 Node 里断言。
3. 打开"接触点"看**哪里在接触**；"按休眠状态着色"看**哪些东西其实已经睡着**。
4. 物体乱飞 → `PhysicsGuard` 的日志（阈值**按物体尺寸缩放**，NaN 首帧即冻）。
5. 物体不动 → 检查 `physicsMode`（static 不会掉）、"支撑检查"开关、"暂停水与沙模拟"。

### 7.4 生成流水线的排查

1. 点「导出最近一次生成日志」，看哪个阶段耗时异常、有没有"降密度重试"；
2. 打开「显示/隐藏冲突标记」看彩色框（红=重叠 黄=悬空 橙=越界 紫=被埋 蓝=挡门）；
3. 记住**触发条件不是"碰到就算"**：断言写的是"没有任何一对零件在三个轴上都插进去超过 0.8 米"，
   因为屋脊压柱头、窗嵌墙、墙角咬合都是**刻意的榫接**。
   **一个永远红着的检查等于没有检查** —— 把阈值定在"碰到就算"会让真实重叠被放过或被淹没。
4. 体检必须**用模板自己的世界档**跑（§4.2 的 ⚠）。

### 7.5 在 Node 里单独跑一个模块

```bash
node .verify/fluid.mjs            # 已经 verify 过一次，产物就在 .verify/ 里
node .verify/fluid.mjs | tail -3  # 只看汇总行
```

`.verify/` 是 `runAll.mjs` 用 esbuild 生成的打包产物，**已加进 `.gitignore`，不要提交**。
想只看某一个专题模块的失败详情，直接跑它的 `.mjs` 比跑整个 verify 快得多。

### 7.6 改代码时最容易忽略的三件事

1. **`index.html` 的 id 与代码里的选择器是一对契约**：改名/重名都会让某个功能静默失灵（§4.7 的 ⚠）。
2. **新增 `data-*` 键名要与代码键名一致**，断言会做逐字比对。
3. **`npm run typecheck` 与 `npm run verify` 都要跑**。`tsc` 抓不到"逻辑对但行为错"，
   断言抓不到"类型不匹配" —— 两者都要。`npm run build` 已经包含 `tsc --noEmit`。

---

## 8. M5 各模块的接线状态（**已全部接进引擎**）与仍然存在的缺口

M5 的模块**以前**是一批"写完了但没人引用"的孤立文件，**M5 第 5 批已经全部接线**
（`Engine` 真的 import 并构造了它们，`index.html` 里有对应 DOM，`integration.run.ts` 的 65 条断言专门盯着这件事）。
下表是**当前**的真实状态；"未接线"这个词已经不适用于其中任何一项：

| 文件 | 批次 | 做什么 | 当前接线状态 |
| --- | --- | --- | --- |
| `core/ErrorHandler.ts` | M5 第 1 批 | 错误采集（环形缓冲 + 去重 + 中文报告导出） | ✅ `Engine` 构造时第一件事就 `install(options.canvas)`，退出时 `uninstall()` |
| `core/SafeMode.ts` | M5 第 1 批 | 安全模式状态 + 限制清单（只描述，不执行） | ✅ `Engine.safeMode` + `applySafeModeRestrictions()`（见 §9） |
| `core/ResetManager.ts` | M5 第 1 批 | 重置（二次确认 + 只删本应用前缀的键） | ✅ `Engine.resetManager`，存储句柄走 `Engine.resetStorage()` |
| `core/CorruptSaveExport.ts` | M5 第 1 批 | 损坏存档的导出/保存 | ✅ `Engine` 起来时 `buildCorruptSaveExport()` / `downloadCorruptSaveExport()` |
| `ui/PanelManager.ts` | M5 第 2 批 | 面板拖动 + 折叠 + 位置记忆（`data-panel` 约定，键 `gad-box-panel-layout-v1`） | ✅ `Engine.panelManager`；`index.html` 里 **21 个面板**带 `data-panel`（**6 个**带 `data-panel-no-collapse`） |
| `ui/ShortcutPanel.ts` | M5 第 2 批 | 快捷键面板（可改键） | ✅ `Engine.shortcuts`，引擎只按 `DEFAULT_SHORTCUTS` 返回的动作 id 分发（见 §10） |
| `ui/ThemeSwitch.ts` | M5 第 2 批 | 主题三档（`dark` / `light` / `auto`） | ✅ `Engine.themeSwitch`，挂在 `#theme-switch` 上 |
| `ui/HelpCenter.ts` | M5 第 3 批 | 帮助中心（搜索 + 分类 + 35 条） | ✅ `Engine.helpCenter`，容器是 `#help-center-body`，"❓ 帮助"按钮 `#btn-help` 与 `H` 都能开 |
| `tutorial/TutorialCatalog.ts` | M5 第 4 批 | 把三套教学表（3 + 6 + 6 = **15 关**）统一登记成 `TutorialLevelMeta` | ✅ 关卡目录面板 `#tutorial-catalog-panel` 直接由它渲染 |
| `tutorial/TutorialProgress.ts` | M5 第 4 批 | 教学完成度持久化（`gad-box-tutorial-progress`） | ✅ 通关时 `markCompleted()`；面板显示完成度并可「清空教学进度」 |
| `tutorial/Onboarding.ts` | M5 第 3 批 | 新手引导（**7 步**，可跳过，`gad-box-onboarding-done`） | ✅ 首帧后 `startOnboardingIfNeeded()`，`#onboarding-tip` 承载气泡 |
| `tutorial/Examples.ts` | M5 第 4 批 | 示例场景（**12 个**，一键加载；其中 **4 个**在移动端按 `mobileScale: 0.5` 降级） | ✅ 关卡目录面板里的「示例场景」列表 |

**接线的证据在哪**（想自己核对的话）：
`src/core/Engine.ts` 里的 import 段与 `readonly errorHandler / safeMode / resetManager / shortcuts /
themeSwitch / helpCenter / tutorialProgress / onboarding` 字段、`index.html` 里的
`#error-panel`、`#help-panel`、`#tutorial-catalog-panel`、`#onboarding-tip`、`#theme-switch`、`#btn-help`，
以及 `scripts/checks/integration.run.ts`（65 条，接线断了就必须红）。

### 8.1 仍然存在的缺口（**一条都没删，照实列着**）

这些都是**已知且刻意保留**的，不是"忘了"：

| # | 缺口 | 现状与原因 |
| --- | --- | --- |
| 1 | **Safari 16.0~16.3 解析期白屏**（R2） | three 的产物里有 **6 处** class static block，那些版本的 Safari 解析就报 `SyntaxError`，连"启动失败"覆盖层都不会出现。修法是一行 `build.target: 'safari16'`（实测确实能消掉那 6 处），但**没有 Safari 真机可验证**，所以**没改** |
| 2 | **真机 / 多浏览器 / 弱网 / 触摸 / 无障碍测试全部没做** | 容器里没有浏览器、没有 WebGL、没有真机；也**没有截图**（本机没浏览器，用手机截屏的请求被用户拒绝，见 `../README.md` 的「📷 截图」） |
| 3 | **`Ctrl+Shift+R` 重新生成地形是死键** | 该绑定已从 `DEFAULT_SHORTCUTS` **删除**（引擎的 `if (ctrl)` 分支对它直接 `return`，即"从来没能被触发过"），`Engine.regenerateTerrain()` 方法保留但没有入口（控制台除外）。要接活它得先补二次确认对话框 |
| 4 | **`TutorialProgress` 的导出 / 导入没有 UI** | 类里有 `exportJson()` / 导入逻辑（断言覆盖），但面板上只有「清空教学进度」一个按钮 |
| 5 | **浅色主题没覆盖帮助卡片与引导气泡** | `HelpCenter` 的卡片与 `Onboarding` 的气泡仍是深色 —— `src/style.css` **未被 M5 改动**（主题变量只在 `ThemeSwitch` 注入的那段里） |
| 6 | **`FluidSystem.limit` 是只读的** | 所以安全模式的"粒子上限 500"只能靠"在生成点建一道门 + 进入安全模式时裁剪已有粒子"实现（`trimFluidToLimit()`），**不能**把上限真正改小 |
| 7 | **Worker 内部抛出的异常不在采集范围内** | `ErrorHandler` 只听主线程的 `error` / `unhandledrejection` / `webglcontextlost`；Worker 里的异常要靠 Worker 自己 `postMessage` 上报，目前没做 |
| 8 | **物理教学关不能跳关** | 保留了解锁门：`jumpPhysicsTutorialLevel()` 里有"已完成数"的授权检查，关卡目录点未解锁的关会**如实说明**并从第 1 关开始，不绕过 |

`TutorialCatalog` 有一个值得学的设计：它**只做登记、不做搬运** ——
每一关都从原来的表里 `import` 出来再映射，**绝不把 `name` / `goal` / `successHint` 抄成第二份**
（抄一份的直接后果是"改了原表，目录还显示旧文案"，而且没人会发现）。
断言里有一条专门核对"目录里的文案与原表逐字段相等"。
`requires`（这一关需要哪些能力）对物理关与建筑关是**从 step 的 `goal` 穷举映射推导**的
（引擎以后新增一种目标类型，TS 会直接报错，逼着你补一行），
只有流体/沙土那六关**只能手工登记**（它们的判定是闭包，数据里只有"建议工具"的中文串，
靠中文字符串猜能力太脆），并且断言会核对"六个 id 一个不漏"。

---

## 9. 错误采集与安全模式的接线

### 9.1 装在哪、什么时候摘

```ts
// Engine 构造函数的第一件事（src/core/Engine.ts）
this.errorHandler.install(options.canvas);           // 传 canvas 是为了 webglcontextlost
this.errorHandler.onError((record) => this.handleCapturedError(record));
```

**为什么必须在所有初始化之前装**：构造函数后半段（建 renderer、生成世界、动态加载物理）本身就是最容易出事的阶段，
装晚了那一段的错误**一条都收不到**。摘监听在 `dispose()` 里（`this.errorHandler.uninstall()`）。

采集到一条新错误时（同 message + context 的重复不会触发回调，`ErrorHandler` 自己去了重）：

1. 面板 `#error-panel` 刷新一行摘要；
2. 如果**还没进**安全模式，且 `errorHandler.records.length >= SAFE_MODE_ERROR_THRESHOLD`，就自动进安全模式；
3. 否则只弹一条 toast（中文，指向「🛟 错误与安全模式」面板）。

### 9.2 阈值是**错误种类数**，不是次数

```ts
export const SAFE_MODE_ERROR_THRESHOLD = 5;   // src/core/SafeMode.ts
```

判定用的是 `errorHandler.records.length` —— **环形缓冲里现存的记录条数**，而 `ErrorHandler` 的语义是
"同 message + context 只留一条并累加 `count`"。所以这个 5 是**不同的错误种类数**，
不是"总共出错了 5 次"：同一个 bug 抛 100 次也只算 1 类（`count` 会显示 100）。
这个数字本身是**策略选择**（源码注释里就这么写的），不是实测出来的最优值。

### 9.3 `applySafeModeRestrictions()` 怎么落地

它**不另写一份清单**：`for (const item of this.safeMode.restrictions)` 逐项按 `item.key` 分发，
并且**照 `item.value` 设值**（不是硬编码 `false` / `500` / `3`）。清单是唯一定义处，改清单的行为立刻跟着变。
当前清单有 **9 项**：`fluid-particle-limit` / `fluid-surface-rebuild` / `shadows` / `ambient-occlusion` /
`pixel-ratio` / `render-distance` / `auto-simulation` / `auto-degrade` / `stress-overlay`。

⚠ 两点必须知道：

- `switch` 没有返回值，所以**漏一个 `key` 不会编译不过**。拦住"清单加了一项、引擎忘了处理"的是断言：
  `integration.check.ts` 会拿每个 `key` 去 Engine 源码里找对应的 `case '...'`。
- **不在安全模式时 `restrictions` 是空数组**，所以"什么都不做"也是正确行为 ——
  `SafeMode` 特意做成这样，让"没开安全模式却把画质关到最低"**无法被表达**。

进入时还会先存一份"玩家原本的选择"快照（水/沙模拟开关、自适应画质、自动降级、流体渲染风格、应力着色、调试线），
退出时按快照还原，然后把画质交回当前预设 —— 而不是"一律打开"（那等于顺手改了玩家的设置）。

### 9.4 安全模式**不会自动退出**

没有"错误少了就自动关"的逻辑：错误类型是累计的（环形缓冲只在写满时覆盖最旧的），
"最近没报错"不等于"问题好了"。退出只有两个入口 —— 面板上的「退出安全模式」按钮，以及手动进、手动出。
自动进是允许的（阈值那一条），自动出**没有**。

---

## 10. 快捷键分发的唯一真源

链路只有一条，别在中间插第二份表：

```
ShortcutPanel.DEFAULT_SHORTCUTS          键位 + 动作 id 的定义处（src/ui/ShortcutPanel.ts，可改键）
        │  ← 玩家改过的键位存一份整表（存储键 gad-box-shortcuts-v1；「恢复默认」是删掉这个键，而不是写一份默认表）
        ▼
ShortcutPanel.match(ev)                  把 KeyboardEvent 映成动作 id（含 `Shift+/`、方向键等）
        ▼
Engine.runShortcutAction(action, ev)     按动作 id 执行（src/core/Engine.ts，一个 switch）
```

- **引擎不认识键位**，只认识动作 id。所以"某个键没绑定"这种事只可能在表里发生，不可能在引擎里发生。
- **`handleUnboundShortcut(code, ev)` 保留的是"改键表表达不了"的上下文语义**：同一个物理按键在不同上下文里
  含义不同 —— 最典型的是**数字键**（地形工具下 = 笔刷模式 1~9，别的工具下 = 切工具）与 **`Backspace`**（删除选中）。
  这些判断依赖当前工具/选择状态，不是"一个键对一个动作"，所以留在引擎里、不进表。
- **`Esc` 永远取消**：无论当前在干什么（拖拽连线 / 速查表 / 主菜单 / 连续堆叠 / 拿起 / 放置 / 选择），
  `Esc` 都走"优先级从高到低取消一层"的那条路，不会被改键表抢走。
- **`F1` / `?` 是刻意的空分支**：面板的开合由 `ShortcutPanel` 自己在 `window` 上处理，
  引擎这一层再执行一遍就会"一次按键开 + 关 = 看起来没反应"。
- `ShortcutPanel.DEFAULT_SHORTCUTS` 里**故意没有**「重新生成地形」：`Ctrl+Shift+R` 在引擎的分发里
  从来没能被触发过，而重建地形不可逆、表里写着"需二次确认" —— 顺手接活它等于新增一个没有确认框的破坏性快捷键。
  这条绑定被删掉，`Engine.regenerateTerrain()` 留成公开方法备用。

---

## 11. 关节的世界锚点归一化（`JointSystem.add()` 的兼容行为，后来者必读）

**背景**：组合数据里表达"这一端接世界（不接任何物体）"的写法有两种 ——
把 `bodyA` 写成空串，或把 `bodyB` 写成空串。两者语义相同，因为**关节的锚点是世界坐标**。

**曾经的真实 bug**：`JointSystem.add()` 原先**只认"`bodyB` 是空串 = 世界"**，
而 `src/data/combos.ts` 里有 **8 处**把世界写在了 `bodyA` 上 —— 这些关节**全部返回 −1**（建成失败），
而 `ComboBuilder` 把 −1 当成"物理还没就绪，稍后自动补建"，于是**静默失败**。
受影响的 6 个组合：`door_kit`、`sliding_door_kit`、`drawbridge`、`gear_train`（3 条）、`elevator`、
`chandelier_chain` → 表现就是**门不转、齿轮不转、吊桥不落、电梯不动**。

**现在的行为**：`add()` 会把"世界在 `A` 侧"**归一化**到 `B` 位再去建关节。
这样做是安全的，理由只有一句但很关键：**锚点是世界坐标，两侧各自算局部偏移，互换两端不改变语义**。
实测：修复前那种写法返回 −1，修复后正常建成；`scripts/checks/jointswap.run.ts` 的 **16 条断言**锁住这个行为
（它真跑 Rapier 建关节，不是靠读代码猜）。

**写新数据的约定**：**请把实体放在 `bodyA`，世界端留空**（与受影响的那 8 处相反）。
两种写法都能用，但保持一致能让"搜 `bodyA`"这种排查方式继续有效。

---

## 12. 本地存储的取法（R1 教训，**写错过一次**）

### 12.1 规矩

> **`typeof localStorage === 'undefined'` 这个守卫必须写在 `try` 里面，和它后面的读写在一起。**

正确写法有一份现成的范式（`src/data/physicsMaterials.ts` 的 `storage()`，以及 `Engine.resetStorage()`）：

```ts
function storage(): Storage | null {
  try {
    // 守卫在 try 里 —— 见下面 12.2 的理由，别把它挪出去
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
```

`Engine.resetStorage()` 更进一步：拿不到真存储时，它返回一个**"一读就抛"的空壳对象**
（`length` / `key()` / `removeItem()` 三个成员直接 `throw`）。这样 `ResetManager.scanOwnKeys()` 会读到异常，
于是 `plan().readable === false`、`requestConfirm()` 返回 `null`，上层给出
「读不到本地存储，重置未做任何改动」的中文说明 —— 而不是**伪造一个"什么都没删但显示成功"的结果**。

### 12.2 为什么 `typeof` 挡不住

`typeof x` 只在 `x` **未声明**时安静返回 `'undefined'`（吞的是 `ReferenceError`）。
而"禁用站点数据 / 禁止全部 Cookie"的浏览器里，读 `window.localStorage` **这个属性本身就抛 `SecurityError`**
（`typeof localStorage` 同样要读这个属性 → 同样抛）。异常发生在 `typeof` 求值的过程中，
所以写在 `try` 外面时，`typeof` **一点保护作用都没有**。

这是兼容性静态审计里的 **R1（高危）**：审计当时有 **14 处** `typeof` 守卫 + **2 处**把 `window.localStorage`
直接当参数传的写法在 `try` 外，其中 **2 处在启动路径上**（`ThemeSwitch` 构造函数、`Engine.loadCatalogPrefs`），
后果是**直接进「启动失败」页**。现在这些位置**全部修好**（共 12 处挪进 `try`，另加 `Engine.resetStorage()` 的降级），
`compat` 断言实测是 **0 处**在 `try` 外（跑法见 `docs/COMPATIBILITY.md` 第 ⑦ 节）。

---

## 13. CI：两个工作流各干什么

| 工作流 | 触发 | 步骤 | 定位 |
| --- | --- | --- | --- |
| `.github/workflows/deploy.yml` | `push` 到 `main` / 手动 `workflow_dispatch` | `npm ci` → `npm run typecheck` → `npm run build` → configure/upload Pages → `deploy-pages` | **上线**：决定线上能不能玩 |
| `.github/workflows/verify.yml` | `push` 到 `main`（含 `pull_request`）/ 手动 | `npm ci` → `npm run typecheck` → `npm run verify`（全量 2416 条） | **门禁**：决定改动有没有把逻辑改坏 |

**为什么分开**（`verify.yml` 顶部注释里也是这么写的）：部署必须尽量稳，而断言套件里有性能与并发相关的用例
（例如"没有活跃格时一步耗时接近 0"这种对机器负载敏感的断言），在共享的 CI runner 上偶尔会抖；
分成两个之后，**测试抖了不会连带把部署堵住**，而 PR 阶段就能看到断言红不红。
两个工作流都跑 `typecheck` 不算重复：各自独立可读，而且 deploy 的红与 verify 的红含义不同。
`verify.yml` 里 `node-version: 20`、`deploy.yml` 里 `node-version: 22`（都满足 `package.json` 的要求）。

⚠ **没有 lint 步骤**，因为**没有 lint 配置**：`package.json` 里没有任何 ESLint / Prettier 依赖，
仓库里也没有 `.eslintrc*` / `eslint.config.*` / `.prettierrc*`。当前实际存在的门槛就是
`tsc --noEmit`（`strict` + `noUnusedLocals` + `noUnusedParameters` 全开）+ 那 2416 条断言。
**不要为了"清单好看"编一个 lint 步骤**。

---

## 14. 相关文档

- [../README.md](../README.md) — 项目介绍、特色、**已知限制与取舍**（近似都写在这里）、逐模块断言表
- [USER_GUIDE.md](USER_GUIDE.md) — 玩家操作说明
- [COMPATIBILITY.md](COMPATIBILITY.md) — 目标浏览器 / 现代 API 清单 / 已知风险表（R1~R10）/ 真机自测清单
- [../CHANGELOG.md](../CHANGELOG.md) — 版本变化（当前 `v1.1.0`，其中 v1.0.0 一节按里程碑分组）
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — 怎么提 Issue / 提交前要跑什么 / 加断言的要求
- [../LICENSE](../LICENSE) — MIT
