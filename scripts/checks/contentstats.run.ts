/**
 * 内容使用统计断言的直接运行入口（Node，不需要浏览器）。
 *
 * 跑法：
 * ```bash
 * npx esbuild scripts/checks/contentstats.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/contentstats.mjs && node .verify/contentstats.mjs
 * ```
 *
 * 不并进 `scripts/verify.ts`（那个文件由并发编辑者持有），也不新增 package.json 脚本 ——
 * 上面的命令行就是全部契约。
 */

import { runContentStatsChecks } from './contentstats.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];

runContentStatsChecks((name, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    failed.push(name);
  }
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
});

console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log(`失败项：${failed.join(' / ')}`);
  process.exit(1);
}
