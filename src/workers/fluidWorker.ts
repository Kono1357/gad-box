/**
 * 粒子流体求解 Worker 的入口（M4 第 7 批）。
 *
 * 这里**只做接线**，一行逻辑都不写：入口越薄，「worker 里算的」与「Node 断言里算的」
 * 就越不可能是两份代码。逻辑全在 `fluidWorkerCore.ts`。
 *
 * 构建方式必须是 Vite 能静态分析的那一种（在 `FluidWorkerRunner` 里）：
 * `new Worker(new URL('../workers/fluidWorker.ts', import.meta.url), { type: 'module' })`。
 * 写成变量拼接或者 `new Function` 之类，打包时这个文件就会**静默地不进产物**，
 * 而那在开发机上完全看不出来（只有部署到子路径的 GitHub Pages 上才会 404）。
 */

import { attachWorkerScope } from './fluidWorkerCore';
import type { WorkerScopeLike } from './fluidWorkerTypes';

// module worker 里 `self` 一定存在。这里做存在性判断只有一个目的：
// 让 Node 侧的断言脚本也能 import 这个文件（Node 里既没有 `self` 也没有 `Worker`），
// 从而证明「入口没有依赖 DOM」—— 而不是靠"我觉得它没依赖"。
const scope = typeof self === 'undefined' ? undefined : (self as unknown as WorkerScopeLike);

if (scope !== undefined) {
  attachWorkerScope(scope);
}
