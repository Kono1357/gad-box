/**
 * 可运行的入口：把预览与模板面板的断言跑一遍。
 *
 *   npx esbuild scripts/checks/preview.run.ts --bundle --format=esm --platform=node \
 *     --outfile=.verify/preview.mjs && node .verify/preview.mjs
 *
 * 有意用 `process.exit(1)` 让失败在 CI / shell 里能被看见（`&&` 链会在这一步断掉）。
 */

import { runPreviewChecks } from './preview.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];

runPreviewChecks((name, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    failed.push(name);
  }
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
});

console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failed.length > 0) console.log(`失败项：${failed.join('；')}`);
if (fail > 0) process.exit(1);
