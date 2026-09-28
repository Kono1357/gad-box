/**
 * 性能热力图与帧录制断言的直接运行入口（Node，不需要浏览器）。
 *
 * 跑法：
 * ```bash
 * npx esbuild scripts/checks/perfrec.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/perfrec.mjs && node .verify/perfrec.mjs
 * ```
 *
 * 不并进 `scripts/verify.ts`（那个文件由并发编辑者持有），也不新增 package.json 脚本 ——
 * 上面的命令行就是全部契约。
 */

import { runPerfRecorderChecks } from './perfrec.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];

runPerfRecorderChecks((name, ok, detail) => {
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
