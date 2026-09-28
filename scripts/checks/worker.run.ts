/**
 * 可运行的断言入口（M4 第 6 批）。
 *
 * 跑法：
 *   npx esbuild scripts/checks/worker.run.ts --bundle --format=esm --platform=node \
 *     --outfile=.verify/worker.mjs && node .verify/worker.mjs
 *
 * 为什么单独一个文件：`worker.check.ts` 里只有断言，导出 `runWorkerChecks`；
 * 这个文件负责"怎么跑、怎么统计、失败怎么退出"。
 * 这样同一批断言以后也能被主 verify.ts 直接复用（它的 check 签名是一样的）。
 */

import { runWorkerChecks } from './worker.check';

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

await runWorkerChecks(check);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
