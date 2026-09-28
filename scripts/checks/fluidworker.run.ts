/**
 * 可运行的断言入口（M4 第 7 批：粒子流体 Worker）。
 *
 * 跑法：
 *   npx esbuild scripts/checks/fluidworker.run.ts --bundle --format=esm --platform=node \
 *     --outfile=.verify/fluidworker.mjs && node .verify/fluidworker.mjs
 *
 * 为什么单独一个文件：`fluidworker.check.ts` 里只有断言，导出 `runFluidWorkerChecks`；
 * 这个文件负责"怎么跑、怎么统计、失败怎么退出"。
 *
 * ⚠ 这里导出的是 **async 版**（`runFluidWorkerChecks` 返回 `Promise<void>`），
 * 所以下面必须 `await`：流体断言里几乎每条都要 `await runner.run(...)`，
 * 写成同步版就只能把 Promise 链丢到函数外面，那样失败信息会与断言对不上。
 */

import { runFluidWorkerChecks } from './fluidworker.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    failed.push(name);
  }
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

await runFluidWorkerChecks(check);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败项：${failed.join(' / ')}`);
if (fail > 0) process.exit(1);
