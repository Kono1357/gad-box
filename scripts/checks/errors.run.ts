/**
 * 错误处理 / 安全模式 / 损坏存档导出 / 重置断言的直接运行入口（Node，不需要浏览器）。
 *
 * 跑法：
 * ```bash
 * npx esbuild scripts/checks/errors.run.ts --bundle --format=esm --platform=node \
 *   --outfile=.verify/errors.mjs && node .verify/errors.mjs
 * ```
 *
 * 不并进 `scripts/verify.ts`（那个文件由并发编辑者持有），也不新增 package.json 脚本 ——
 * 上面的命令行就是全部契约。
 *
 * ⚠ 命令要在项目根目录（`/root/work/god-sandbox`）下跑：其中一条断言会去读 `src/**` 的源码文本，
 * 用来核对"重置的键清单有没有和源码漂移"。不在根目录时它按"跳过"记并在输出里说明，
 * 不会给出一个假通过 —— 但那样就没在防漂移了，所以还是按上面的命令跑。
 */

import { runErrorChecks } from './errors.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];

runErrorChecks((name, ok, detail) => {
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
