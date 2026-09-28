# 更新日志

本文件记录本项目的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

条目分类：**新增** / **变更** / **修复** / **已知问题**。

> 说明：本项目在 v1.0.0 之前按里程碑（M0 → M5）迭代，中间没有发布过版本号。
> 所以下面**只有 v1.0.0 一个版本**，但按阶段分小节保留了每个里程碑的真实交付内容。
> 所有数字都取自仓库里的代码与断言（例如 `BUILDING_CATALOG.length`、实跑的断言汇总行），
> 不是估算。

---

## [v1.0.0] - 2026-09-28

第一个正式版本：纯前端体素沙盘，含体素地形编辑、394 个物品、Rapier 物理、粒子流体、有状态的沙土、
程序化生成流水线、10 个压力测试场景与 1876 条断言。

在线试玩：<https://kono1357.github.io/gad-box/>

### M0 · 工程初始化

**新增**

- Vite 7 + TypeScript 5.9（`strict` 全开）+ Three.js 0.186 的工程骨架，`npm run dev` / `build` / `preview` 三条命令可用。
- `index.html` 的全部 HUD DOM 骨架与 `src/style.css`（后来长到 1,296 行 + 1,543 行）。
- `core/Engine.ts` 主循环、`render/RenderSystem.ts` 场景分层、`render/GodCameraControls.ts` 上帝视角轨道相机（旋转 / 平移 / 缩放 / 键盘移动）。
- 底部状态栏的 FPS 与绘制统计；M0 时代的占位道具（保留在调试开关 `props` 里）。
- GitHub Pages 部署路径：`base` 按 `VITE_BASE` → `GITHUB_REPOSITORY` → 兜底常量解析，**仓库改名不用改代码**。

### M1 · 体素地形与编辑

**新增**

- `voxel/Chunk.ts` + `voxel/VoxelGrid.ts`：区块化体素世界（16×16 水平、高度等于世界高度），坐标约定贯穿全项目。
- `voxel/ChunkMesher.ts`：面剔除 + UV + 顶点级 AO 的网格生成。
- `voxel/BrushSystem.ts`：笔刷系统（**一次拖动 = 一步撤销**）。
- `voxel/VoxelRaycast.ts`：DDA 体素射线拾取；`voxel/TerrainGenerator.ts`：高度图与分层地形。
- `command/CommandManager.ts`：体素与建筑的统一撤销重做历史。
- `save/SaveSystem.ts` 与存档键 `god-sandbox-save-v1`（后来一直保留只读兼容）。
- `core/Time.ts`：固定步长累加器。
- **修复**：编辑后只重建受影响的区块（局部重建），而不是全世界。

### M1.5 · 精细笔刷 / 材质 / 参考地图

**新增**

- 笔刷扩到 **5 种形状 × 12 种模式**，半径 0.5~16、强度 0.1~1.0 **支持小数**（`stochasticRound` 做"一格一格"的微调）。
- `voxel/VoxelMaterials.ts`：**17 种程序化纹理图案**（纯色/噪点/砖缝/木纹/草顶/草沿/水波/冰晶/金属拉丝/熔岩裂纹/大理石…），
  所有贴图进一张 512×512 图集 → 一个区块仍然只有 1 次 draw call。
- 4 张内置参考地图（新手岛 / 山谷村落 / 沙漠绿洲 / 城堡山），**只存生成配方不存体素**，同一张图每次生成逐字节相同。
- `worldSize.ts`：世界尺寸档位（当时为 64/128/256，后来缩到 48/96/192）。
- 水的元胞自动机（`physics/WaterSystem.ts`）：**每格水量 0~1**、向下优先、装满溢出、总量守恒。
- 沙的安息角滑落（`physics/SandSystem.ts`）：`slideDistance = 1/tan(θ)` 的离散近似。
- 支撑连通性检查（`physics/SupportSystem.ts`）：BFS 标记"够得到地形"的实例，报告 `floating` / `cantilever`。
- **77 个建筑模型**（结构/门窗/家具/电器/厨卫/装饰/交通/机械/奇幻），按模型 InstancedMesh 合批；幽灵预览绿/红、网格吸附、90°/45°/15°/5° 旋转。
- 三层剔除（视锥 + 距离 + 卸载）与分帧重建；右侧性能面板。

### M2 · 真实物理引擎与建造交互

**新增**

- 接入 **Rapier 3D 0.21**（`@dimforge/rapier3d-compat`），重力 `-9.81 m/s²`、固定步长 `1/60 s`，与渲染步分离。
  **wasm 4.3 MB 走 `await import()` 动态加载**，主包先渲染地形；加载失败时明确提示"沙盘仍可使用，但没有重力与碰撞"。
- `physics/TerrainCollider.ts`：地形 → **一个 heightfield 碰撞体**（而不是逐体素立方体），并实测确认了 Rapier 的
  `heights[col*(nrows+1)+row]`（col↔X、row↔Z）约定。
- 建筑刚体用**复合碰撞体**（按模型的每个 part 生成），所以桌子真的是四条腿站在地上。
- 三种刚体模式：`static` / `dynamic` / `kinematic`。
- **智能放置**：6 个候选来源（吸附点 / 堆叠 / 贴墙 / 地面 / 网格 / 空中），每个候选都做地形穿插 + 并列重叠 + 支撑检查；
  门窗类物件自动找最近的墙面贴上去。实测 200 个物体的场景里 **10.6 ms** 出结果（验收要求 < 30 ms）。
- `building/StackingSystem.ts` + `SupportSurface.ts`：堆叠与支撑判定（层数、接触面积比、重心余量、稳定性三档）。
- `selection/SelectionSystem.ts`：点选 / `Ctrl` 加选 / 拖拽框选 / 全选 / 选同类；**高亮合并成一个 `LineSegments`**（选 500 个也是 1 次 draw call）。
- `selection/PickupSystem.ts`：拿起单个 / 拿起整结构（连通性 BFS）、按**光标位移**跟随（零跳变）、微调（±0.25/0.5/1/2 m、±5/15/45/90°）、放下失败自动还原。
- 分组（可嵌套）/ 预制件（带**等轴测 SVG 缩略图**）/ 蓝图（纯 JSON 可分享）/ **真镜像复制**（几何体局部镜像 + 反转三角形绕序）。
- `ui/HistoryPanel.ts`：操作历史面板，**最多保留 100 步**、列表渲染最近 60 条、点任意一条直接回退/前进；每组操作带 `group` 名。
- `ui/ShortcutHelp.ts`：快捷键速查表。

### M2.5 · 堆叠重写 / 换图卸载 / 移动端

**新增**

- `world/MapPlanner.ts`：生成顺序改为 **地形 → 水/沙 → 自然物 → 建筑**，房子先登记规划区、自然物有最小间距、
  事后 `detectOverlaps()` 兜底，并输出一份 `MapGenerationReport`。
- `world/WorldLoader.ts` + `WorldUnloader.ts`：**换图真卸载**（10 条卸载清单逐条执行/计时/报告，一条失败不中断后面的），
  阶段之间让帧给进度条。
- `placement/HighlightRenderer.ts` + `CameraTracker.ts` + `ScreenEdgeArrow.ts`：脉冲高亮框（穿透地形可见）、
  候选点跳远 > 12 米时的 0.3 秒镜头跟随（一拖鼠标就中断）、屏幕边缘箭头。
- `physics/PhysicsFramework.ts`：物理**四层**框架（刚体 / 碰撞 / 约束 / 逻辑），每层都有可观测出口。
- `data/combos.ts` + `physics/ComboBuilder.ts`：**20 个成品物理组合**（64 个零件 / 46 个关节）。
- `tutorial/TutorialLevel.ts` + `ui/TutorialUI.ts`：**3 个教学关卡**（门 / 小车 / 桥），共 10 步。
- `mobile/MobileController.ts` 等 7 个模块：手势（单指瞄准/轻点放置/长按拿起/双击取消，双指缩放/旋转）、
  设备探测与三档布局 class、虚拟摇杆（默认关闭）、震动反馈、手势教学（只弹一次）。

**变更**

- 堆叠逻辑整体重写：**叠罗汉**（每个物体仍是独立实体，取最高支撑面，超过 20 层提示），
  堆叠判定从 Rapier 搬到**纯 AABB 数学**。实测：智能放置建议 31.8 ms → **1.8~5.9 ms**，单次堆叠判定 1.87 ms → **0.09 ms**。
- 顶面变成**有面积的资源**：按 4×4 小网格（可调 2~8）划格，一张桌子上能整齐摆一排。
- 默认世界缩小到 **48×16×48 / 9 区块**（标准 96×24×96，大型 192×32×192）。
- 新增质量预设（性能优先 / 均衡 / 画质优先）与**自适应降级**（降级需连续 1 秒低帧率，恢复需连续 6 秒高帧率 + 5 FPS 余量）。
- `Tab` 从"编辑/观察模式"改为"切换智能放置候选点"，模式切换挪到 `V`。

**修复**

- **暂停时放置的碰撞检测完全失效**：Rapier 的查询管线只在 `world.step()` 里更新，而暂停时不 step，
  于是"新放的物体和已有的是否重叠"永远查不到 → 暂停中连点会全部落在同一坐标。改用纯 AABB 判定后修复。
- 参考地图的房子长在树上（生成顺序导致），以及换地图是"叠上去"而不是卸载（体素数组 / geometry / InstancedMesh / 刚体 / 历史全留在内存里）。

### M3 · 物理正式接入（8 批）

**新增**

- `physics/RapierWorld.ts`：世界生命周期唯一所有者；**两种加载进度模式**（`bytes` 真实字节百分比 / `phases` 阶段权重，面板上如实标注用的是哪种）。
- `physics/TerrainCollider.ts` 重写：列实心的区块用 heightfield，**有洞穴/悬挑的用 greedy 合并的 cuboid**；
  局部更新（改一格只重建一个区块，单帧最多 6 个），全部碰撞体挂在**同一个静态刚体**上。
- `physics/ColliderFactory.ts`：**5 层碰撞分组**（地形/建筑/物体/水体/触发器）+ 碰撞矩阵；水体层不与任何东西碰撞（浮力靠施力）。
- 六种碰撞体形状（cuboid / ball / cylinder / capsule / convexHull / trimesh）与它们的取舍（带腿家具不用凸包、trimesh 只用于静态、凸包退化自动回退）。
- `physics/RigidBodyFactory.ts`（四类刚体）与 `PhysicsMaterial.ts`（8 种预设 + 运行时材质覆盖）。
- `physics/TimeControl.ts`：**倍速靠每帧推进更多子步**（0.25/0.5/1/2/4），以及**位姿回溯**（300 帧 ≈ 7.7 MB，写回清零速度、世代号防串帧）。
- `physics/BuoyancySystem.ts`：教科书式 `F = ρ·g·V排水`（木头浮石头沉完全来自密度比较），沿高度逐层积分算排水。
- `physics/CollapseSystem.ts`：**局部**倒塌（从地基做连通性标记，只有断开的那一块才倒，600 毫秒宽限期）。
- `physics/StressVisualizer.ts`：应力可视化 `0.55×(1−支撑充分度) + 0.30×承重比例 + 0.15×悬挑比例`（**不是有限元**）。
- `physics/TriggerSystem.ts` + `LogicLink.ts`：触发器从盒查询轮询改成 **Rapier sensor**（不会漏掉快速穿过），
  **6 种逻辑门**（直接/或/与/非/延时/计时）+ 冷却与概率。
- `physics/JointFactory.ts` + `JointSystem.ts`：**6 种关节**（固定/旋转/滑动/球窝/绳索/弹簧）+ 两种马达模式（速度驱动 / 位置驱动），
  以及关节限位的可视化。
- `physics/PhysicsDebug.ts` + `ui/PhysicsDebugUI.ts`：11 个调试绘制开关，全部合批进 1 个 `LineSegments` + 1 个 `Points`（只多 2 次 draw call）。
- `physics/DistanceCulling.ts` + `FrameScheduler.ts`：物理 LOD 的**参与度降级**（冻结已休眠且 60 米外的物体）与周期性任务的 **2.5 ms 分帧预算**。
- `physics/PhysicsGuard.ts`（爆炸保护，阈值按物体尺寸缩放、NaN 首帧即冻）、
  `PhysicsRecorder.ts`（扁平数值数组录制，600 帧 × 800 刚体不产生 48 万临时对象）、
  `PhysicsAudio.ts`（**7 种合成音效，零音频素材**）。
- `ui/ConnectorOverlay.ts` + `ui/LogicLinkEditor.ts` + `ui/JointEditor.ts`：拖拽连线三步流程、关节编辑器、逻辑连线编辑器。
- `data/stressTestMaps.ts` + `world/StressTestGenerator.ts`：3 个压力场景（500 箱子塔 / 100 齿轮传动 / 50 吊桥），
  手机端在**生成之前就决定**降级数量。
- `tutorial/PhysicsTutorial.ts` + `ui/PhysicsTutorialUI.ts`：**6 关物理教学**（重力/摩擦/弹性/关节/浮力/倒塌），共 24 步。

**修复**

- `syncQueries()` 把 `world.timestep` 设成 0 之后**没有恢复**（当时靠每帧 `step()` 重写时间步掩盖了）。
- `index.html` 里 `data-physics-debug="colliderBoxes"` 出现了两次（重复的开关）。
- 浮力第一版"从物体顶往下找第一个有水的高度"会漏算排水体积（**完全没入 1 m³ 木头只算出 0.83 m³** → 本该浮的木头缓慢下沉），改成沿高度逐层积分。
- `LogicLink.add()` 是逐字段构造记录的，加了 `gate` 字段却忘了拷一行 → **门配置被静默丢弃、全部退化成直接触发**（9 条断言同时红）。
- `matchesSource` 没比对 `triggerOwnerId` → "给按钮建连线"永远匹配不上（按钮不动，动的是踩它的人）。
- Rapier 0.21 **没有** `setMotorVelocity`（要用 `configureMotorVelocity` / `configureMotorPosition` + `setMotorMaxForce`）；
  本项目的 wasm 构建会把 u32 handle 的位模式当 f64 交回 JS（第 2 个刚体 handle 是 `5e-324`），所以句柄一律 `String()` / `Number()`，**绝不能用 `parseInt`**。

### M4（前半）· 物品库 / 生成流水线 / 性能监控

**新增**

- 物品库从 77 扩到 **394 个内置物品**（14 个数据文件、11 个一级分类 + 二级分类），新增 `catalogs/*` 十三个文件。
- `ui/CatalogPanel.ts`：物品面板重写（搜索 / 分类 / 二级分类 / 排序 / 收藏 / 最近使用 / 内容包 / 长列表）。
- `world/GenerationPipeline.ts`：**9 阶段生成流水线**（高度图 → 水 → 沙 → 地表材质 → 自然物 → 建筑规划 → 建筑 → 小物品 → 冲突检测与修复），
  阶段之间让帧、单阶段失败不中止整条、密度不足可降密度重试一次。
- `world/ConflictDetector.ts` / `ConflictResolver.ts` / `ConflictOverlay.ts`：冲突检测（重叠/悬空/越界/被埋/挡门）、修复、彩色标记可视化。
- `world/GenerationLogger.ts` + `GenerationPreview.ts`：生成日志、降采样近似预览（画布上标着"非真实体素"）、参数+种子回滚。
- `data/contentStats.ts` + `ui/ContentStatsUI.ts`：内容使用统计俯视热力图。
- `perf/PerformanceMonitor.ts` / `AutoDegrade.ts` / `MemoryPanel.ts`：性能监控与自动降级、资源与内存面板、换图前后采样对比。
- `data/contentPacks.ts` + `ui/ContentPackUI.ts`：内容包（关掉只隐藏、**不删世界里的物体**）。
- `data/customItems.ts` + `ui/CustomItemUI.ts`：玩家自定义物品（用基本几何体拼装，带三条硬校验）。
- `data/mapTemplates.ts`：**8 套地图生成模板**（平原村庄/高山峡谷/沙漠戈壁/群岛海域/雪原/火山/深林/城市街区），参数全是倍率。

**修复**（"生成规则体检"在真实产物上跑出四个真 bug）

- 树顶穿出天花板（39 个越界物体）：新增"放置时要求头顶有净空"，高处自然形成**林线**。
- 建筑穿出天花板（74 个越界物体）：规划阶段加净空规则（`groundY + buildHeight ≤ sizeY`）；顺带修掉一个越界提示只写 X/Z 的**文案 bug**。
- 树冠间距系数 0.95 < 1 **保证**相邻树冠必然相交 → 每张图几十处"重叠" → 修复器挪不动就删（实测删掉 21 棵）。系数改成 1.02 后**删除是最后手段、不再是主路径**（删掉的树降到 0~5 棵）。
- 参数里的世界档与真实网格不一致时地形会算到网格外面（`setVoxel` 静默失败、地形被截断，但高度图仍告诉后续阶段"地表在 21"）：改成**以网格为准**夹高度，并且夹了要在日志里说一声。
- 冲突检测口径错：同一个"构建单元"内部的相交（墙压地板、屋顶搭墙）不算冲突 —— 第一版没有 `owner` 字段，7 栋房（91 个构件）自己跟自己报出上百处重叠。
- `npm run verify` 从"一个进程跑全部"改成**每个模块一个独立进程**（假 `document` / 假 `localStorage` 互相污染，失败信息读起来像是模块自己的 bug）。

### M4（后半）· 流体 / 沙土 / 耦合 / 压力测试

**新增**

- `fluid/ParticlePool.ts`：**SoA 粒子池**（十多个平行 `Float32Array`）+ 空闲链表（下标稳定，可被 Worker 零拷贝转移）。
- `fluid/SpatialHash.ts`：计数排序实现的空间哈希（比较次数降到两两比较的约 1/200）。
- `fluid/PBFSolver.ts`：PBF 位置法求解器（九步、零分配、可被 Worker 复用）。
- `fluid/FluidSystem.ts`：5 种流体（水/油/蜂蜜/岩浆/牛奶）、生成与移除（固定种子可复现）、**冻结区域**、粒子上限与每帧 4 ms 预算、**整池静止跳过**。
- `fluid/FluidSurface.ts`（marching cubes 连续液面）+ `FluidRenderer.ts`（**3 种渲染风格**：粒子 / 表面 / 混合）+ `FluidEditor.ts`（**6 个工具**：泼水/抽水/加水/减水/冻结/解冻）+ `FluidAudio.ts`（合成音效）。
- `sand/SandPhysics.ts` + `SandSystem.ts`：沙从"一种体素"变成**有状态的格子**（湿度 + 稳定性），安息角三个锚点（干 34°/湿 45°/饱和 15°）、沙崩连锁、活跃区域。
- `sand/SandEditor.ts`（**5 个工具**：堆沙/挖沙/湿沙/干沙/凝固）+ `SandVisualizer.ts`（稳定性着色 + 最陡方向线 + 沙崩范围框）。
- `physics/FluidRigidCoupling.ts` + `fluid/ParticleFluidField.ts` + `DragSystem.ts`：**流体-刚体双向耦合**（浮力/阻力/推动/冲击/扶正力矩/角速度阻力），3 套预设（真实/游戏/夸张），每帧 2~3 次迭代，每物体力与力矩上限 + 夹住次数如实统计。
- `sand/SandWaterInteraction.ts`：变湿 / 侵蚀（泥流）/ 沉积 / 沙掩埋压塌。
- `perf/StressTestScenes.ts` + `StressTestReport.ts`：**10 个压力测试场景**（桌面目标 30 FPS / 移动端 15 FPS）+ 报告与两次运行对比。
- `perf/PerfHeatmap.ts`（负载热力图，**估计值不是毫秒**）+ `PerfRecorder.ts`（环形缓冲 3600 帧）。
- `save/FluidSave.ts`：流体与沙的存档 v1（位置 1/512 米、速度 1/64 m/s、湿度 1/255 的量化 + 打包，**实测压缩率 50%**）。
- `tutorial/FluidSandTutorial.ts`：**6 个流体与沙土教学关卡**（水流向低处/浮力与船/水压与闸门/沙崩/泥流/洪水）。
- `workers/fluidWorker*` + `world/FluidWorkerRunner.ts`：流体求解 Worker（Node 里如实回退主线程，写回带三重一致性校验）。
- `workers/conflictWorker*` + `world/ConflictRunner.ts`：冲突检测 Worker（结果与同步路径逐字一致；**未接进流水线**，见"已知问题"）。

**修复**

- **λ 的分母少了一项**：只算 `|(1/ρ0)·Σ∇W|²`（对称排布下几乎完全抵消），漏了 `Σ|(1/ρ0)·∇W|²`（才是主体）→ 分母趋近 0 → λ 被放大几千倍 → **水自己炸开**（12 帧从 0.64 米铺到 2.19 米、平均速度 6 m/s），而**密度误差只有 26%，看起来完全正常**。
- 压力测试面板新加的 `id="stress-panel"` 与 M3 的「🌡 应力」面板重名（`must()` 只会找到第一个 → "应力开关"作用到压力测试面板上）；沙面板的 `#sand-angle` 与地形笔刷的同名滑杆冲突（已改 `#sand-repose-note`）。
- `FluidSave.decode()` 在"粒子数为 0"时提前返回 → **沙的湿度根本不会被读回来**（写进去 0.75、读回来 0）。
- `unpackBytes(packed, -1)` 会把最后一个字节砍掉（`subarray(0, -1)` 的语义）→ 改成把长度写进载荷。
- `FluidRigidCoupling` 构造函数忘了记录预设名 → `new FluidRigidCoupling('realistic').describe()` 永远显示"游戏"。
- 沙土两处坑：把"滑动距离"当成了"前瞻要求"（**要求越多越难滑，坡度反而更陡**，症状是干沙与饱和沙堆出来的坡度一模一样）；`canSlideInto` 多要了一条"目标下方必须有支撑"→ 沙**永远不会沿斜面滑**。
- 一次失败的优化被记下来备查：在 `cellsWithin` 里加 `subarray().sort()` 让邻居收集**从 47 ms 涨到 138 ms**。

### M4.1 · 用户反馈的第一轮优化

**变更**

- 物品面板**重排**：搜索 → 最近使用 → 分类 → 数量 → **物品列表**（原来是列表排在最后，手机上要滚过大半屏才看得到自己有哪些东西可选）；
  筛选/排序/内容包收进 `<details>`；分页改成**连续长列表**（`IntersectionObserver` 滚到底自动追加 24 个，DOM 仍是一批一批建）。
- 数量提示改成把"还能看到多少"和"下一步做什么"都写出来。

**修复**（三处每帧开销，全部是实测出来的）

- 内容统计热力图挂在每帧路径上：**1.02 ms/帧**（60 FPS 下每秒 61 ms）→ 每 400 ms 一次、均摊 **0.026 ms/帧**
  （原因是"先算后节流"：面板内部节流只挡住了 DOM，挡不住计算与分配）。
- 支撑面索引"镜头一动就全量重建"：**1.62 ms/帧**（241 个物体）→ **0.034 ms/帧**（缓存签名里的焦点坐标量化到 4 米格）。
- 区块网格重建预算按**块数**给（3 块/帧 ≈ **24~44 ms/帧**）→ 改成**按时间**给（4 ms/帧，至少 1 块）。
- 性能面板的**阶段拆分补全**：原来只有"物理 / 模拟 / 渲染"三段，而"渲染"是**残差** → 区块重建、支撑面、UI 面板全被算进"渲染"，
  面板会一本正经地报"渲染是瓶颈"。现在分成 8 段、**各段各自计时**，渲染才是残差。

### M5 · 错误处理 / 面板管理 / 教学目录 / 文档（**进行中**）

**新增**

- `core/ErrorHandler.ts`：错误采集（window `error` / `unhandledrejection` / canvas `webglcontextlost` / 手动 `capture()`）。
  环形缓冲绝不 `shift()`、同 message+context 去重累加 `count`、拿不到栈就是 `null`、采集器自己绝不抛异常、
  `exportReport()` 带上 `limits` / `notes`（不让人误以为"这就是全部错误"）。
- `core/SafeMode.ts`：安全模式**只是状态 + 一份限制清单**（不认识 Engine/Three.js/DOM，**永远不会去关任何东西**），
  进入理由 5 种（WebGL 不可用 / 世界加载失败 / 存档损坏 / 错误太多 / 玩家手动）。
- `core/ResetManager.ts`、`core/CorruptSaveExport.ts`：重置与损坏存档导出。
- `ui/PanelManager.ts`（面板拖动 + 折叠 + 位置记忆，`data-panel` 约定，存储键 `gad-box-panel-layout-v1`）、
  `ui/ShortcutPanel.ts`、`ui/ThemeSwitch.ts`。
- `tutorial/TutorialCatalog.ts`：把三套教学表（3 + 6 + 6 = **15 关**）统一登记成 `TutorialLevelMeta`
  （**只登记不搬运**，绝不把 `name` / `goal` / `successHint` 抄成第二份）；配套 `TutorialProgress.ts` / `Onboarding.ts` / `Examples.ts`。
- `scripts/checks/errors.check.ts`：错误处理器与安全模式的断言模块。
- **文档**：重写 `README.md`（里程碑表 + 按主题归类的取舍清单 + 逐模块断言表 + FAQ）、
  新增 `docs/USER_GUIDE.md`（逐工具的具体操作步骤 + 从代码里核对出来的快捷键总表）、
  `docs/DEVELOPER.md`（架构分层 / 数据模型 / 扩展指南 / 性能守则 / 调试技巧）、
  新增 `CHANGELOG.md`、`CONTRIBUTING.md`、`LICENSE`（MIT）。

**已知问题**

- ⚠ **M5 的这些模块目前全部没有被接线**：`ErrorHandler` / `SafeMode` / `ResetManager` / `CorruptSaveExport` /
  `PanelManager` / `ShortcutPanel` / `ThemeSwitch` / `TutorialProgress` / `Onboarding` 都**没有被 `Engine` / `main.ts` / `index.html` 引用**；
  `index.html` 里还没有任何 `data-panel` 属性。
- ⚠ `scripts/checks/errors.check.ts` **没有出现在 `scripts/checks/runAll.mjs` 的 `ENTRIES` 里**，
  所以 `npm run verify` 不会跑它，**1876 条断言里不含它**。

---

## 已知问题

以下是**当前版本真实存在**的限制与缺陷，按重要程度排列。更完整的取舍说明见 [README.md](README.md) 的「已知限制与取舍」。

### 性能

- **10000 粒子约 12 Hz（84.8 ms/帧，Node 单线程实测）**，**没有达到"10000 粒子 60 FPS"**，差距约 5 倍。
  邻居收集与压力项是**内存延迟主导**（实测 46.8 个候选/粒子、每次散读约 63 ns），
  要再快一个量级需要"按空间哈希重排粒子数组"（结构性改动）或把求解搬进 Worker（流体自身降到 ~12 Hz，主线程成本归零）。
- **`fluidWorker`（流体求解 Worker）只做了构建层面的验证**，没有在浏览器里跑过（容器里没有 `Worker`，
  Node 的 `worker_threads` 不是浏览器 Worker）。
- **冲突检测的 Worker 版本没有接进流水线阶段 9**：实测"光打包地形快照就不比检测本身便宜"
  （新手档 1.6~2.7 ms 打包 vs 1.8~3.4 ms 检测；大档 30~40 ms 打包 vs 17.7~20.5 ms 检测，净亏 10~20 ms）。
  `ConflictRunner` 保留为"结果与同步路径逐字一致"的可用能力。

### 物理与流体

- **刚体不带水**：运动的刚体**不会带动流体**（没有尾流）。流体求解器只把刚体当**静止边界**，
  所以水会绕开箱子，但箱子划过去不会推开水面。要做需要把刚体速度作为 PBF 的边界条件传进去。
- **热力图是负载估计，不是每帧实际耗时**：图上数字永远是**加权物件数**（刚体权重 4 是**估计值**）。
  WebGL 没有"按屏幕区域计时"的接口，逐区域耗时在前端根本拿不到。
- **浮力不做姿态力矩**：一条侧翻的木头不会自己翻回来。
- **排水体积按 AABB 算**：空心船能浮靠的是"我们按盒子算"，不是"我们模拟了船体"。
- **应力不是有限元**：能回答"我这座桥看起来合理吗"，不能回答"这根梁 3.2 秒后会不会断"。
- **回溯不重算接触力**：回溯后物理读数要等再跑一步才准。
- **物理 LOD 的冻结是真的不碰撞**：远处已休眠的物体被 `setEnabled(false)` 后，有东西飞过去砸它会直接穿过去。
  这不是 bug，是功能的定义（两条硬规则把它限制到"几乎看不到"）。

### 存档

- **存档不含关节 / 触发器 / 逻辑连线**（需要先做"实例 id ↔ Rapier 刚体 handle"双向映射与重连）。
  保存时会有明确提示，**不静默丢数据**；接好关节的作品请用「导出蓝图」保存结构。
- **流体存档是有损压缩**：读回来之后微观状态会变（粒子不会精确回到原来的位置），宏观状态一致；粒子数精确相等。
- **旧存档的尺寸不匹配时不做重采样**：按存档里记录的尺寸重建世界（世界会回到那一档）。

### 功能缺口

- **6 个流体与沙土教学关卡玩家无法进入**：`tutorial/FluidSandTutorial.ts` 的逻辑与判定都在、也有断言覆盖，
  但 `index.html` 里没有对应的面板，`Engine.setFluidTutorialActive()` / `fluidTutorialState` 全仓库没有调用点。
- **浏览器兼容性未实测**：开发环境里没有浏览器（也无法截屏），
  所以全部 UI 与渲染效果只经过了 `tsc` + DOM id 静态核对 + jsdom 冒烟，**没有真跑过浏览器**。
  任何"看起来应该没问题"的渲染代码都需要人实际打开页面确认一次。**这是唯一未完成的验收项。**
- **没有 LOD、没有遮挡剔除、没有阴影贴图**（需求里 LOD 与遮挡剔除标了"可选"，资源投给了距离剔除与分帧调度）。
- **玩家自定义物品不能上传模型、不能自定义碰撞体形状、不能加新的物理组件类型。**
- **非门不能用拖拽连线配置**（它需要"抑制源"这个第二参照物，拖拽只能表达两个端点）。
- **1000 箱子堆叠永远跑不到 1000**（桌面动态刚体上限 800，移动端 300），超出部分退化成静态并记账。
- **洪水场景冲不倒建筑**（20000 粒子上限 = 81.9 m³ 水，把 20×20 街区淹到 0.5 米需要约 48828 个粒子）。
- **"大型城市"场景名不副实**（现成生成给不出大型城市：城市街区密度 1.8 → 11 栋）。

### 文档

- **`docs/screenshots/` 是空的（目录本身也不存在）**：README 里引用的 8 张截图需要人用真机在线上站点手动截，
  开发环境里没有浏览器，无法生成也不伪造图片文件。
- **`vite.config.ts` 的注释、`data/maps.ts` 里新手岛的描述文字、`src/ui/ShortcutHelp.ts` 的三行快捷键、
  `index.html` 的 `<title>` 与菜单标题**都还停留在旧状态（旧仓库名 `god-sandbox`、旧世界尺寸 `64×24×64`、旧键位、`M1.5` 字样）。
  这些**不在本版本的文档改动范围内**（属于代码文件），已在 README 里逐条标注了"以什么为准"。

---

[v1.0.0]: https://github.com/Kono1357/gad-box/releases/tag/v1.0.0
