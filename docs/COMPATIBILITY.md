# 兼容性说明（M5 第 5 批 · 兼容性）

> ## ⚠️ 先读这一句
>
> **本文件是静态分析，不是真机测试。**
>
> 写这份文件的环境里**没有浏览器、没有 WebGL、没有真机**（容器里只有 Node 22/24 与源码），
> 所以本文里的每一条结论都只有两种来源：
>
> 1. **本项目自己的文件**：`package.json` / `tsconfig.json` / `vite.config.ts` / `index.html` /
>    `src/**` / `node_modules` 里**已安装依赖的真实产物**（版本号、字节数、有没有某个语法块）；
> 2. **公开的浏览器兼容资料**（MDN / caniuse，链接随文给出），用来判断"某个已确认用到的特性
>    从哪个版本开始有"。
>
> 凡是需要"真的开一个浏览器看一眼"的东西 —— 渲染结果、触摸手感、弱网表现、某个版本上到底能不能跑 ——
> **本文一条都没有验证**。请对照第 ⑤ 节的真机清单自己补上那部分，别把本文当成验收结论。
>
> 本文的所有数字都是**实测出来的**（扫源码得到的位置、量出来的字节数、跑出来的行为），
> 没有一条来自"大概"/"应该"。断言脚本：`scripts/checks/compat.check.ts`
> （80 条，跑法见文末）。

审计快照：2026-09-28 09:32 UTC，工作区 `src/**` 共 **206 个 `.ts` 文件**。
⚠️ **行号是当时的快照**：审计期间 `src/core/Engine.ts` 正在被另一个批次修改（文件已近 9800 行），
行号可能已经漂移。断言脚本**不硬编码行号**，每次运行都重新扫，所以脚本里的位置永远是最新的。

---

## ① 结论摘要

**这个项目没有在任何配置里声明过目标浏览器。** `package.json` 里**没有** `browserslist`（也没有 `engines`），
`README.md` 只写了一句话"支持 WebGL2 的现代浏览器"。真正能当依据的只有两处：
`tsconfig.json` 的 `target: "ES2022"` 与 `vite.config.ts` 的 `build.target: 'es2022'`。

从这两处 + 依赖产物推出来的实际下限是：

| 浏览器 | 推出来的最低版本 | 卡住它的是什么 |
| --- | --- | --- |
| Chrome / Edge（桌面与 Android） | **94+** | three 0.186.1 产物里的 class static block |
| Safari（macOS）/ iOS Safari | **16.4+** | 同上（class static block 是 ES2022 里 Safari 最晚补齐的一项） |
| Firefox | **93+** | 同上 |
| 其它 | 不支持 | three ≥ r163 需要 WebGL2，全项目没有 WebGL1 回退路径 |

**三个"线上致命项"的排查结论（这三条是这一批的重点）：**

1. **SharedArrayBuffer / Atomics —— 干净，没有高危。** 源码里**一处都没用**（只在 5 处注释里
   被提到，用来说明"它不可转移"）。这一点很重要：GitHub Pages **不发** `Cross-Origin-Opener-Policy` /
   `Cross-Origin-Embedder-Policy` 响应头，拿不到跨源隔离，用 SharedArrayBuffer 会直接
   `ReferenceError` 或 `SecurityError` —— 本项目没有踩这个坑。`crossOriginIsolated` 也一处没用。
2. **WASM 加载 —— 有中文兜底，且不依赖任何服务器配置。** `rapier3d-compat` 把 2.94 MiB 的 wasm
   **以 base64 内联进了 JS**（实测 base64 串 4,109,472 字符），`init()` 解出字节后交给
   `WebAssembly.instantiate(bytes, imports)` —— **不是** `fetch('.wasm')`、**不是**
   `WebAssembly.instantiateStreaming`。所以线上既不需要 `application/wasm` 这个 MIME 头，
   也没有跨源/COEP 要求（GitHub Pages 的静态托管约束一条都碰不到）。
   加载失败时 `RapierWorld` 抛出的错误被 Engine 接住，给出中文提示条 + "换 WiFi 后刷新"，
   沙盘其余功能照常可用。
3. **localStorage —— 读写方法都有兜底，但"读属性本身"有 16 处没兜住。**
   33 处 `getItem/setItem/removeItem/clear/key` 方法调用**全部**在 `try` 里（硬断言，见断言脚本）；
   但有 **14 处 `typeof localStorage === 'undefined'` 守卫**与 **2 处把 `window.localStorage`
   直接当参数传出去**的写法写在 `try` **之外**。在"禁用站点数据 / 禁止全部 Cookie"的浏览器里，
   **读 `window.localStorage` 这个属性本身就会抛 `SecurityError`**，而 `typeof` 只吞"未声明"、
   不吞 getter 抛的异常 —— 这 16 处在那种浏览器里会直接抛出去，其中 2 处（`Engine` 的主题初始化
   与物品面板偏好）位于**启动路径**上。详见第 ④ 节风险表 R1（严重度：高）。

---

## ② 目标浏览器与最低版本

### 2.1 配置里**已有**的（可核对，不是我编的）

| 位置 | 真实内容 | 出处 |
| --- | --- | --- |
| `tsconfig.json` | `target: "ES2022"`，`lib: ["ES2022","DOM","DOM.Iterable"]` | 读文件得到 |
| `vite.config.ts` | `build.target: 'es2022'` | 读文件得到 |
| `package.json` | 依赖 `three ^0.186.1`（实际安装 `0.186.1`）、`@dimforge/rapier3d-compat ^0.21.0` | 读文件 + 读 `node_modules` |
| `package.json` | **没有** `browserslist`、**没有** `engines` | 读文件得到 |
| `index.html` | 唯一脚本 `<script type="module" src="./src/main.ts">`；样式由 `main.ts` import；无 `crossorigin` | 读文件得到 |
| `README.md` | 只写了"支持 WebGL2 的现代浏览器"（无版本号） | 读文件得到 |

> 参考：Vite 7 自己有一个默认的 `build.target`，叫 `baseline-widely-available`
> （在安装的 `vite` 包里能搜到这个常量名，它对应的列表里包含 `chrome107`）。
> 本项目**显式覆盖**成了 `es2022`。**这处覆盖让 Safari 的下限反而更高**：
> `safari16` 会让 esbuild 去降级 class static block，而 `es2022` 允许它原样留在产物里（见 2.3 的实测）。

### 2.2 我**建议**的声明（配置里没有，这一段是建议不是事实）

建议在 `package.json` 里补一条 `browserslist`（本批次**不改** `package.json`，只写在这里）：

```jsonc
"browserslist": [
  "chrome >= 94",     // three 的 class static block 要求 94+；也是 Android 主力内核
  "edge >= 94",
  "firefox >= 93",
  "safari >= 16.4",   // 同上；这一条是整个下限的瓶颈
  "ios_saf >= 16.4"   // iOS 上所有浏览器都是 WebKit，跟 Safari 同一条线
]
```

理由：这四行正好等于"当前构建配置 + 依赖产物"能保证的范围。**声明比现状更宽就是撒谎**，
比现状更窄则会白白劝退能跑的设备 —— 所以建议直接写实际值。

如果希望把 Safari 下限拉回 **16.0**（覆盖 iOS 16.0~16.3 这批还在用的设备），
唯一的办法是让产物里**不再出现 class static block**。实测（见 2.3）把 `build.target` 设成
`safari16` 就能做到，但**这需要真的在 Safari 16.0~16.3 上跑一遍才算数**：
esbuild 只降语法、不补运行时 API，three 里如果还有别的较新 API 依赖，降级也救不回来。
本批次**没有做这个改动**（`vite.config.ts` 禁改）。

### 2.3 三条卡住下限的实测证据

**(a) WebGL2 是硬要求。** `three@0.186.1` 需要 WebGL2（`node_modules/three/build/three.module.js`
里有 "WebGL 2 to display scenes." 这段提示；three 从 r163 起移除了 WebGL1 支持）。
全项目**没有** `isWebGLAvailable()` 之类的预检，拿不到上下文时由 three 抛异常 → `main.ts`
的 `try/catch` 接住 → 显示中文"启动失败"覆盖层（`.fatal` 样式在 `style.css` 里有定义）。
参考 WebGL2 的支持起点（MDN 兼容数据）：Chrome 56 / Edge 79 / Firefox 51 / **Safari 15 / iOS 15**
（[MDN: WebGL2RenderingContext](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext)）。

**(b) class static block 把 Safari 抬到 16.4。** `three@0.186.1` 的产物
`node_modules/three/build/three.core.js` 里有 **6 处 `static { … }`**（`Vector2` / `Vector3` /
`Matrix3` 等类用它给原型打标记）。我用真实的 Vite 管线各构建了一次（产物写到 `/tmp`，没动仓库）：

| 构建命令 | 产物里的 class static block |
| --- | --- |
| `npx vite build --target es2022`（= 项目当前配置） | **6 处** |
| `npx vite build --target safari16` | **0 处**（esbuild 降级掉了） |

class static block 的支持起点（据 MDN 与第三方项目因它放弃 Safari 16.4 以下的公开记录）：
Chrome 94 / Firefox 93 / **Safari 16.4**（[MDN: 静态初始化块](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/Static_initialization_blocks)、
[chai#1687 "Safari versions below v16.4 are unsupported"](https://github.com/chaijs/chai/issues/1687)）。
Safari 16.3 及以下打开线上页面时，这 6 个块是**解析期语法错误**，整个 bundle 都跑不起来 ——
连 `main.ts` 的中文"启动失败"覆盖层都来不及显示（那是模块解析失败，不是运行时异常）。

**(c) 4.3 MB 的 rapier chunk 是真字节数。** 审计时 `dist/assets/rapier.js` 实测 **4,336,685 字节**
（≈ 4.34 MB 十进制 / 4.14 MiB；`dist/` 是构建产物，重新构建后这个数字可能略有变化，断言脚本每次运行都会重新量）。
Engine 的进度文案写的是"约 4.3 MB"，与实测相符（断言脚本会把这条对上，防止以后文案与产物脱节）。

### 2.4 WASM 相关的三个常见坑，逐条给结论

| 坑 | 结论 | 证据 |
| --- | --- | --- |
| WASM 本身的支持 | 不是瓶颈（Chrome 57 / Safari 11 / Firefox 52 起就有） | 远低于 WebGL2 与 static block 的下限 |
| `WebAssembly.instantiateStreaming` 对 `Content-Type: application/wasm` 敏感 | **不适用**：本项目不走这条路径 | `rapier3d-compat` 的 `init()` 是 `{ module_or_path: <解码后的字节> }`，直接走 `WebAssembly.instantiate` |
| 是否需要 SharedArrayBuffer（也就是要不要 COOP/COEP 头） | **不需要，且确实没用** | 代码里 0 处 `SharedArrayBuffer` / `Atomics` / `crossOriginIsolated` |

---

## ③ src/** 里用到的现代 API 与现代语法（逐条判断）

扫描口径：`src/**/*.ts`（206 个文件）。判断分两层 ——"**代码里**有没有用"（注释与字符串先被抹掉，
否则中文注释里出现的 API 名字会算成使用），以及"这个特性从哪个版本开始有"（据 MDN / caniuse 公开资料，
**未在本项目实测**）。

### 3.1 用了、且在范围内（不是瓶颈）

| API / 语法 | 出现位置 | 是否超出目标范围 | 判断依据 |
| --- | --- | --- | --- |
| `??`（空值合并） | 740 处 | 否 | ES2020，Chrome 80 / Safari 13.1 起 |
| `?.`（可选链） | 493 处 | 否 | ES2020，Chrome 80 / Safari 13.1 起 |
| `String.prototype.replaceAll` | 12 处：`ui/ComboPanel.ts`、`ui/HistoryPanel.ts`、`ui/PrefabPanel.ts`（各 4 处，全是 HTML 转义） | 否 | Chrome 85 / Safari 13.1 / Firefox 77 起 |
| `Array.prototype.flatMap` | 2 处（`selection/PickupSystem.ts`、`tutorial/Examples.ts`） | 否 | Chrome 69 / Safari 12 起 |
| `Object.fromEntries` / `Object.entries` | 多处（`world/GenerationContent.ts` 等） | 否 | Chrome 73 / Safari 12.1 起 |
| `globalThis` | 10 处（`ErrorHandler`、`ThemeSwitch`、`PanelManager` 等，用于"拿不到就降级"） | 否 | Chrome 71 / Safari 12.1 起 |
| `toLocaleString` / `toLocaleTimeString` / `toLocaleDateString` | 11 处（性能面板、历史面板等，都显式传了 `'en-US'` / `'zh-CN'`） | 否 | 老 API；显式传 locale 也避开了 ICU 差异 |
| `<script type="module">` | `index.html` 1 处 | 否 | Chrome 61 / Safari 10.1 起 |
| Pointer Events（`pointerdown/move/up/cancel` + `setPointerCapture`） | 16 处 / 5 处 | 否 | Chrome 55 / Safari 13 起 |
| `IntersectionObserver`（**有**降级分支） | `ui/CatalogPanel.ts:885`、`ui/MapTemplateUI.ts:514` | 否 | Chrome 51 / Safari 12.1 起；拿不到就走"直接算" |
| `matchMedia`（**4 处调用全在 try 里**） | `mobile/DeviceCapability.ts:252,297`、`ui/ThemeSwitch.ts:250,251` | 否 | Chrome 9 / Safari 5.1 起 |
| `navigator.deviceMemory`（**已做可用性判断**） | `mobile/DeviceCapability.ts` | 否 | Chromium 专有且被粗粒度分档；拿不到就是 `null` |
| `performance.memory`（**窄接口 + null 兜底**） | `world/ResourceMonitor.ts:107` 等 | 否 | Chromium 专有；拿不到**不假装 0**，面板写"测不到" |
| 模块化 Worker（`new Worker(new URL(...), {type:'module'})`） | `world/FluidWorkerRunner.ts`、`world/ConflictRunner.ts`（各 1 处） | 部分是 | 老 Firefox / 老 Safari 不支持模块 Worker（确切版本见 MDN 的 Worker 兼容表，本次没有逐版本核对）——**但两处构造都在 try 里，失败会退回主线程同步路径**，所以不致命 |
| `navigator.vibrate`（**先探测 canVibrate**） | 2 处使用 / 4 处探测 | 否 | Chromium / Android 专有；iOS Safari 没有，探测已在 `DeviceCapability` 里 |
| `navigator.clipboard.writeText`（**在 try/catch 里，失败返回 false**） | `core/Engine.ts`（2 处） | 否 | 需要安全上下文 + 用户手势；GitHub Pages 是 https，满足安全上下文 |
| `AudioContext` | 24 处（`fluid/FluidAudio.ts` 等） | 否 | 需要用户手势后才能出声（面板上已写明"点击后才会出声"） |

### 3.2 **没有**用（所以不会成为风险；这些是"以后别顺手引进来"的清单）

以下 API / 语法在 `src/**` 的**代码**里都是 **0 处**（若将来有人引入，断言脚本会立刻变红）：

| 类别 | 具体项 | 支持起点（据公开资料，未实测） | 为什么本项目不用 |
| --- | --- | --- | --- |
| 拷贝 / 属性判断 | `structuredClone`、`Object.hasOwn` | Chrome 98 / Safari 15.4；Chrome 93 / Safari 15.4 | 太新；`Object.prototype.hasOwnProperty.call` 全版本可用（`ui/CustomItemUI.ts:185` 就是这么写的） |
| 新数组方法 | `.at()`、`findLast`、`toSorted`、`toReversed`、`toSpliced`、`Array.fromAsync` | Chrome 9x~11x / Safari 15.4+ | 太新 |
| 逻辑赋值 | `??=`、`||=`、`&&=` | Chrome 85 / Safari 14 / Firefox 79 | 没必要 |
| 类语法 | `static { … }`（**src 里 0 处**）、`#private` 字段 | Safari 16.4 / Chrome 74 | 用的是 TS 的 `private` 修饰符；three 的产物里有 static block，那是依赖的账 |
| 顶层 await | `^await ` | Chrome 89 / Safari 15 | 没有异步初始化需求 |
| 正则 | lookbehind `(?<=` `(?<!`、`d` 标志 | Safari 16.4 之前完全不支持 lookbehind | 扫了 44 个正则字面量，一个都没用这两个特性 |
| 并发 / 中断 | `queueMicrotask`、`requestIdleCallback`、`AbortSignal`、`AbortController` | 各版本不一，`requestIdleCallback` Safari 至今没有 | 用 `Promise` + `requestAnimationFrame` 就够 |
| 观察器 / 画布 | `ResizeObserver`、`OffscreenCanvas`、`createImageBitmap` | Safari 13.1 / 16.4 / 15 | 窗口 `resize` 已够用；不需要离屏画布 |
| GPU / 存储 / 加密 | `navigator.gpu`、`navigator.storage`、`crypto.randomUUID` | Chrome 113 / Safari 26；Safari 缺 `estimate()`；Safari 15.4 | 都不需要 |
| 视口 | `visualViewport` | Safari 13 起 | **没用到**，所以 iOS 上地址栏/键盘变化算不准（见风险表 R6） |
| 跨源隔离 | `SharedArrayBuffer`、`Atomics`、`crossOriginIsolated` | 需要 COOP/COEP 头 | **GitHub Pages 不提供这些头，用了就是线上必坏** |
| Intl | `Intl.*` | 老版本缺 `Intl.ListFormat` 等 | 一律用 `toLocale*` 并显式传 locale |

### 3.3 `index.html` / `vite.config.ts` 的静态事实

| 项 | 现状 |
| --- | --- |
| 脚本 | 只有 1 个：`<script type="module" src="./src/main.ts">`（无内联脚本、无 `modulepreload`、无 `crossorigin`） |
| 样式 | 0 个 `<link rel="stylesheet">`（由 `main.ts` 里的 `import './style.css'` 走 Vite 管线，路径会按 `base` 重写） |
| viewport | `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover` |
| `base` | 不是硬编码：`VITE_BASE` → `GITHUB_REPOSITORY` → 兜底 `gad-box`，线上是 `/gad-box/` 子路径 |
| `assetsInlineLimit` | 没有覆盖（用 Vite 默认） |
| rapier chunk 名 | `assets/rapier.js`（无 hash），与 `src/physics/RapierWorld.ts` 的 `RAPIER_CHUNK_FILE` 常量**两处一致**（断言会核对这一致性） |
| 产物里的独立 `.wasm` | 0 个（wasm 内联在 JS chunk 里） |
| 压缩 / 缓存 | **未核实**（本次没有访问线上站点的响应头）；rapier chunk 无内容 hash，改版本后依赖 HTTP 缓存头重新验证 |

---

## ④ 已知风险表

严重度口径：**致命** = 线上必坏或整站打不开；**高** = 特定（但真实存在的）浏览器/网络条件下整站不可用；
**中** = 部分功能不可用但有别的路径；**低** = 体验问题。

| # | 现象（玩家看到什么） | 触发条件 | 证据（文件:行号，审计时快照） | 严重度 | 修法 |
| --- | --- | --- | --- | --- | --- |
| **R1** | 打开页面直接进"启动失败"页（或某个面板点了没反应） | 浏览器**禁止站点数据 / 禁止全部 Cookie**（Chromium 系会抛 `SecurityError: Failed to read the 'localStorage' property from 'Window'`）（[Chromium 的这份说明](https://chromium.googlesource.com/experimental/website/+/2381c9d8305fee4a2d02fab5cbee46d209f50483/site/for-testers/bug-reporting-guidelines/uncaught-securityerror-failed-to-read-the-localstorage-property-from-window-access-is-denied-for-this-document/index.md)） | 启动路径 2 处：`src/ui/ThemeSwitch.ts:261`（`ThemeSwitch` 构造函数 `:327` 里的 `:331` 调它）、`src/core/Engine.ts:4002`（`loadCatalogPrefs()`，Engine 构造时 `:1318` 调）；其余 12 处漏兜的 `typeof` 守卫：`Engine.ts:4021`、`data/contentPacks.ts:130,147`、`data/customItems.ts:265,289`、`ui/MapTemplateUI.ts:735,759`（sessionStorage）、`ui/PanelManager.ts:646`、`ui/ShortcutPanel.ts:487,506,517`、`ui/ThemeSwitch.ts:272`；另有 2 处 `window.localStorage` 直传：`Engine.ts:6573,6609` | **高** | 禁改 `src/**`（本批次），所以**未修**。正确做法：把 `typeof x === 'undefined'` 与随后的读写**一起**放进同一个 `try`（`src/data/physicsMaterials.ts:383` 的 `storage()` 就是对的写法），或统一走一个 `safeStorage()` 帮助函数。⚠️ 注意：`typeof localStorage` **挡不住**这条 —— `typeof` 只吞"未声明"（ReferenceError），属性 getter 抛的异常照样抛出来。断言脚本里有一条**真的跑了一遍**的登记断言复现了这个行为 |
| **R2** | 页面**完全白屏**，连"启动失败"覆盖层都看不到（控制台是 `SyntaxError`） | Safari / iOS Safari **16.0~16.3**（以及任何不支持 class static block 的浏览器） | `node_modules/three/build/three.core.js` 里 6 处 `static { … }`；实测 `vite build --target es2022` 的产物里仍有 6 处、`--target safari16` 则 0 处 | **高** | 两条路：① 把 `vite.config.ts` 的 `build.target` 降成 `safari16`（实测能去掉 static block）**并在真机上验证**；② 保持现状，把 `browserslist` 声明成 Safari ≥ 16.4，并在 README/页面上写明要求（本批次禁改这两处文件，所以都**未做**） |
| **R3** | 弱网 / 断网首次加载：进度条走一段后停住，然后弹出"⚠️ 物理引擎没加载成功…"提示条；重力与碰撞失效（地形、建筑、存档仍可用） | 4.3 MB 的 rapier chunk 下载失败（弱网、切网、代理拦截） | 兜底：`src/physics/RapierWorld.ts` 的 `catch`（上报 `phase:'failed'` + `lastError` + 中文说明）、`src/core/Engine.ts` 的 `onPhysicsFailed()`（toast + 中文提示条 + "换 WiFi 后刷新"） | **中** | **没有"重试"按钮**：`physics.init()` 在整个 src 里只有 1 处调用（`Engine.ts:1652`，启动时），失败后只能刷新。`RapierWorld.init()` 本身允许重试（失败时清了 `initializing`，断言在盯这条），所以补一个"重试加载物理"的按钮即可 —— 要改 `src`，本批次**未做** |
| **R4** | 手机切后台/锁屏较久再回来：画面还在但 3D 部分卡住或变黑，之后一直转圈/花屏 | 系统回收 WebGL 上下文（iOS 与低内存 Android 常见） | 有采集：`src/core/ErrorHandler.ts:156,195` 监听 `webglcontextlost` 并记一条中文错误；**没有** `webglcontextrestored` 监听、没有渲染器重建（全项目 0 处） | **中** | 监听 `webglcontextrestored` 后重建 `WebGLRenderer`（或提示玩家刷新）。要改 `src`，本批次**未做** |
| **R5** | 手机上不是"不能玩"，而是**部分只有快捷键的入口找不到**（例如某些开关只能按键） | 触屏设备（没有键盘） | 工具栏有 17 个 `data-action` 可点入口（含"⌨ 快捷键"按钮），`index.html` 共 155 个 `<button>`；`ui/PlacementUI.ts:50`、`ui/BrushUI.ts` 都专门做了"手机按不了方括号"的可点替代行 | **低** | 待核：我**无法静态证明**"每个快捷键都有等价按钮"。真机清单里第 ⑤-6 条请逐项点一遍。若发现确实缺，补按钮即可 |
| **R6** | iOS Safari 上展开地址栏时，面板底部被切掉一点（要滑一下才看全） | iOS Safari（`100vh` = 地址栏收起后的高度） | `src/style.css:200,210,843,851` 用 `calc(100vh - …)`；全项目 **0 处** `visualViewport`、0 处 `dvh/svh` | **低** | 用 `dvh` 或 `visualViewport.height`。要改 `style.css`（本批次禁改），**未做** |
| **R7** | 手机上首次进站会下载 4.34 MB 的 JS（含内联 wasm），且要在主线程上 base64 解码 | 首次访问 / 缓存被清 | `dist/assets/rapier.js` 实测 4,336,685 字节；base64 串 4,109,472 字符；有真实字节进度（`prefetchChunk()` 先 `fetch(url,{cache:'force-cache'})` 读 `Content-Length`，失败就退回阶段进度） | **低** | 已经是"预取 + 真进度 + 失败可降级"的形态；要进一步改善只能换非 compat 版 rapier（会多一个 `.wasm` 请求，但能流式实例化）——**不建议**，那会引入新的 MIME/CORS 面 |
| **R8** | 首次点"开始模拟声音"之前没有声音 | iOS / Safari 要求用户手势之后才能创建/恢复 AudioContext | `src/fluid/FluidAudio.ts`（24 处 AudioContext 相关）；面板文案已写"点击后才会出声" | **低** | 无需修（已声明并有文案） |
| **R9** | 屏幕阅读器基本读不出面板里的内容 | 无障碍场景 | `index.html`：`aria-*` 属性只有 4 处、`role` 只有 4 处；`<button>` 155 个里 49 个带 `title`（触屏上 `title` 本来也不显示） | **低** | 本轮**未做**无障碍改造（没有真机/辅助技术可验，做了也无法验收） |
| **R10** | 手机上两个摇杆默认是关的，玩家以为"不能转视角" | 触屏设备 | `src/mobile/MobileController.ts` 头部注释：摇杆默认关闭（两个 112px 圆盘会压掉近一半操作区），双指手势已覆盖转视角需求，需要的人自己在右上角开 | **低** | 无需修（刻意取舍）；手势教学会自动弹一次（`GestureTutorial`） |

### 4.1 存储兜底的实测细节（R1 的依据）

断言脚本**真的跑了**三种环境（跑在 Node 里，不是浏览器；但走的是被审计代码的真实分支）：

| 环境 | 观测结果 |
| --- | --- |
| 完全没有 `localStorage`（Node / 无痕） | `loadEnabledPacks()` 不抛，回落到默认启用集（2 个内容包）；`saveEnabledPacks()` 如实返回 `false` ✅ |
| `localStorage` **方法**抛异常（配额满 / 被策略禁用） | 读回落默认集、写返回 `false`，**不抛** ✅ |
| `localStorage` **属性读取**抛 `SecurityError` | `loadEnabledPacks()` **把异常抛出来** ❌ ← 这就是 R1 |

存储引用的全量口径（审计快照）：**60 处**引用，分布在 14 个文件里 ——
其中**方法调用 33 处**（全部在 `try` 内 ✅）、`typeof` 守卫 20 处（**14 处在 `try` 外** ⚠️）、
其余属性访问 7 处（**2 处在 `try` 外**且是往函数里直传 ⚠️）。
`SaveSystem`（存档读写删）的 9 处方法调用全部在 `try` 内，失败给中文说明（含"本地存储空间不足（约 5MB），请改用「导出 JSON」"）。

---

## ⑤ 真机测试清单（这部分我做不到，请你在手机上跑）

> 线上地址：**https://kono1357.github.io/gad-box/**
> 每一步都写了"点什么、看什么、期望什么"。看不出来或对不上，就是发现了本文静态分析没抓到的问题 ——
> 请把现象（哪个浏览器、哪一步、看到什么）记下来，比"打不开"这句有用得多。

1. **能不能打开（第一优先）**
   - Chrome（桌面/Android）：打开线上地址 → 期望：出现加载遮罩 → 进度条（可能显示"正在下载物理引擎 x / 4.3 MB"）→ 出现沙盘地形，右上角有工具栏。
   - Safari（macOS）/ 手机 Safari：同上。**重点**：如果整页白屏且控制台报 `SyntaxError`，那就是本文 R2（说明这台设备的 Safari < 16.4），请把"iOS 版本 + Safari 版本"记下来。
   - Firefox：同上。
2. **WebGL 兜底**
   - 桌面浏览器设置里关掉"硬件加速"（Chrome：设置 → 系统 → 使用硬件加速），重启浏览器后再打开 → 期望：要么能跑（软件渲染），要么看到中文"启动失败"覆盖层 + "请确认浏览器支持 WebGL2"这句，**不是**纯白屏。
3. **手机触摸（重点，因为我完全没法测）**
   - 单指拖动 → 期望：光标跟着手指走，**镜头不动**。
   - 单指轻点 → 期望：在光标处放置/选择（建筑工具下是放置）。
   - 单指长按 → 期望：拿起物体（有震动反馈的话会震一下）。
   - 单指双击 → 期望：取消当前放置。
   - 双指开合 → 期望：缩放；双指同向拖动 → 期望：旋转镜头。
   - 首次进入若弹出"手势教学"，跟着做一遍。
4. **屏幕旋转与后台切回**
   - 竖屏 ⇄ 横屏切换 → 期望：面板收起/展开合理，画面不被拉伸，触控位置不偏。
   - 切到别的 App 停 1 分钟（或锁屏）再切回来 → 期望：画面正常、物理没"瞬移/炸开"；若 3D 部分变黑卡死，那就是 R4。
5. **弱网 / 断网（R3）**
   - 用浏览器 DevTools 限速到 "Slow 3G" 或开飞行模式后打开页面 → 期望：进度条给出真实百分比或明确写"阶段进度"，失败时出现中文提示条并说明"沙盘仍可使用"。**记下有没有重试入口**（应该没有，需要刷新）。
6. **键盘可用性（R5）**
   - 手机上：逐个点工具栏按钮，确认"我想做的每件事都能点到"；特别是快捷键面板里的功能，逐条找找有没有对应的可点入口。
   - 桌面上：按 `?` / `F1` 能开快捷键面板；按 `Ctrl+Z` 撤销、`M` 开地图菜单、`H` 开帮助。
7. **存储被禁用（R1，最能验证本文最重的一条）**
   - Chrome 桌面：设置 → 隐私和安全 → 网站设置 → 其他权限/ Cookie → 选"阻止所有 Cookie"（或把本站加入"不允许使用 Cookie"），刷新线上页面 → 期望：**能正常进沙盘**（主题回落到默认、偏好不保存）。若看到"启动失败"页，就是命中了 R1，请把控制台的报错原文截下来。
8. **主题与无障碍抽查**
   - 切深色/浅色两档（工具栏里的主题按钮）→ 期望：文字与背景对比度足够（源码注释里自算的比值见下），浅色档下按钮文字不发灰。
   - 用系统"减少动态效果"（iOS：辅助功能 → 动态效果 → 减弱动态效果）打开页面 → 期望：项目里已有 `prefers-reduced-motion` 探测（`src/mobile/DeviceCapability.ts`），确认动画确实变少。
9. **信息回传格式**：`浏览器与版本 + 设备型号 + 操作系统版本 + 第几步 + 现象 + 控制台报错原文`。

### 5.1 本文引用的对比度数字（**引用源码注释里的自算值，不是我算的**）

出处：`src/ui/ThemeSwitch.ts:30-37`（注释里自述"用 WCAG 2.x 相对亮度公式算出的实测值"）：

- 深色档：正文 `#d8e2ea` / 背景 `#0b0e11` = **14.73**；正文 / 面板 `#141a21` = **13.33**；
  次要文字 `#8b9aa8` / 背景 = **6.71**；/ 面板 = **6.07**；强调色 `#7fd06a` / 背景 = **10.26**
- 浅色档：正文 `#16202a` / 背景 `#f2f4f7` = **14.96**；正文 / 面板 `#ffffff` = **16.48**；
  次要文字 `#55606d` / 背景 = **5.81**；/ 面板 = **6.40**；强调色 `#2f7d22` / 背景 = **4.67**
  （压白字 = **5.15**）；次强调 `#8a5200` / 背景 = **5.80**；危险色 `#c0392b` / 背景 = **4.94**
- 边框**不在 4.5 约束内**（注释里写明是刻意取舍：边框只做分隔，不承担文字可读性，实际 1.4~1.5）。

断言脚本会把这些数字从注释里解析出来并检查每一档 ≥ 4.5（16 个比值，最小 4.5 ——就是那句"≥ 4.5"自己）。
**注意**：这是"注释里写的数字"，不是"我用渲染结果量出来的对比度"；真机上还要靠第 ⑤-8 步目视抽查。

---

## ⑥ 本次**未做**的测试，以及原因

| 没做的事 | 原因 |
| --- | --- |
| 在 Chrome / Safari / Firefox / Edge 上真的打开页面 | 容器里**没有浏览器**、没有 WebGL、没有 GPU 驱动 |
| 手机真机触摸、旋转、后台切回、震动、手势 | 没有真机；容器里也没有触摸设备 |
| 弱网 / 断网 / 代理拦截下的加载表现 | 需要真的发请求并限速；本次只做了"代码里有没有兜底分支"的静态判断 |
| WebGL2 缺失、软件渲染、上下文丢失后的恢复 | 同上：没有 GL 环境，无法制造这些条件 |
| Safari 16.0~16.3 的解析失败（R2） | 只能靠"产物里有 static block + 公开的兼容资料"推断，**没有真机验证**。这条最需要真机确认 |
| 线上响应头（缓存 / 压缩 / MIME） | 本次没有访问线上站点（只审计本地源码与构建产物） |
| 无障碍（屏幕阅读器 / 键盘 Tab 顺序 / 对比度的真实渲染值） | 没有辅助技术与真机；对比度只引用源码注释里的自算值 |
| iOS 上 `100vh` 的实际观感（R6） | 需要 iOS Safari 真机 |
| 存储被禁用时的整站行为（R1） | 用 Node 里的假 `localStorage` 复现了**代码路径**（属性读取抛 → 异常被抛出），但"整站在那种浏览器里会不会真的进不了"要在真机/真浏览器上第 ⑤-7 步确认 |
| 把 `build.target` 降到 `safari16` 后的真机验证 | 改动 `vite.config.ts` 属本批次禁改范围；而且降级后仍需真机验证（esbuild 只降语法不补 API） |

---

## ⑦ 断言脚本（怎么跑、盯住了什么）

```bash
npx esbuild scripts/checks/compat.run.ts --bundle --format=esm --platform=node \
  --outfile=.verify/compat.mjs && node .verify/compat.mjs
```

**80 条**中文断言（全部通过时输出 `结果：80 通过 / 0 失败`），盯住的是"以后别把下限悄悄抬高 / 别把兜底删掉"：

- **配置一致性**：`tsconfig.target` 与 `vite.build.target` 口径一致；`vite.config.ts` 里的 rapier chunk 名与
  `RapierWorld.RAPIER_CHUNK_FILE` 一致；进度文案里的 MB 数与 `dist/assets/rapier.js` 的真实字节数相符。
- **不许引入的新特性**（每条都会打印真实位置）：`static {}`、`#私有字段`、`??=|===`、顶层 await、
  `.at()/findLast/toSorted`、`structuredClone`、`Object.hasOwn`、lookbehind 正则、`d` 标志、`Intl.*`，
  以及 `queueMicrotask / requestIdleCallback / AbortSignal / AbortController / ResizeObserver /
  OffscreenCanvas / createImageBitmap / navigator.gpu / navigator.storage / crypto.randomUUID /
  performance.memory / visualViewport`。
- **线上致命项**：`SharedArrayBuffer` / `Atomics` / `crossOriginIsolated` 必须 0 处；
  rapier 的 init 必须仍然走"内联 base64 → 字节"这条路（换成 `.wasm` 请求就会红）；
  `dist` 里不许出现独立 `.wasm`。
- **兜底必须还在**：WASM 失败的中文提示 + `lastError` + 可重试；`matchMedia` 4 处调用全在 `try` 内；
  模块 Worker 构造在 `try` 内且主线程回退还在；`IntersectionObserver` 两处降级分支；
  `clipboard` 在 `try` 内；切后台清零帧时间戳；`MAX_FRAME_DELTA` 仍然夹着 delta。
- **存储**（硬断言）：33 处方法调用**全部**在 `try` 内；`SaveSystem` 9 处全在 `try` 内；
  第 1/2 批的 10 个模块逐个文件核对。另有两条**真的跑了一遍**的降级断言（无 localStorage / 方法抛）
  与一条**登记事实**断言（属性读取抛 SecurityError 时确实会抛 —— 对应 R1，修它要改 `src`，本批次禁改）。
- **口径自检**：扫描器必须能区分"代码里用到"与"注释里提到"，且能正确判断"在不在 try 里"
  （否则上面所有结论都不可信）。

最后一条提醒：`scripts/checks/runAll.mjs`（`npm run verify` 的入口）本批次**禁改**，
所以这个模块**没有**被自动收进 `npm run verify`；请在合适的时候把
`{ name: '兼容性静态审计', entry: 'scripts/checks/compat.run.ts' }` 加进 `ENTRIES`。
另外 `tsconfig.json` 的 `include` 只有 `["src","vite.config.ts"]`，也就是说
**`scripts/**` 不在 `tsc --noEmit` 的覆盖范围内** —— 这个断言模块是被 esbuild 打包时才发现类型/语法错误的。
