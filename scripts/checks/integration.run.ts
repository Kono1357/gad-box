/**
 * M5 引擎集成断言的直接运行入口（Node，不需要浏览器）。
 *
 * 跑法：
 * ```bash
 * npx esbuild scripts/checks/integration.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/integration.mjs --log-level=error && node .verify/integration.mjs
 * ```
 *
 * `scripts/checks/runAll.mjs` 已经把它登记成「M5 引擎集成」那一项（第 5 批）。
 *
 * ⚠ 命令要在项目根目录（`/root/work/god-sandbox`）下跑：其中几条断言会读 `src/core/Engine.ts`
 * 与 `index.html` 的文本，用来核对"模块真的被接上了"。不在根目录时它们按"跳过"记并在输出里
 * 说明，不会给出一个假通过 —— 但那样就没在防"接了又断了"，所以还是按上面的命令跑。
 */

import { runIntegrationChecks } from './integration.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];

runIntegrationChecks((name, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    failed.push(name);
  }
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
});

console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败项：${failed.join(' / ')}`);
if (fail > 0) process.exit(1);
