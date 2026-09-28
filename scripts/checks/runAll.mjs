/**
 * 断言总入口（`npm run verify`）。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么每个检查模块跑在**独立进程**里
 * ────────────────────────────────────────────────────────────
 * M4 加进来的四个检查模块（内容统计 / 生成预览 / Worker / 自定义物品）都是
 * 独立写的，各自用"手搓的全局桩"来覆盖 DOM 与 localStorage 分支：
 * 装一个假 `document`、装一个假 `localStorage`、跑完再卸掉。
 *
 * 单独跑每个模块时全绿；合到一个进程里跑就红了，而且红得**看不出是谁的错**：
 * - `preview` 的 DOM 断言因为"全局里已经有 document"而失败 —— 那是别的模块留下的桩；
 * - `customitem` 的导入断言失败，因为它读到的 localStorage 里已经有**别人**塞进去的
 *   120 个自定义物品（它假设自己拿到的是空存储）；
 * - 失败信息读起来像是这些模块自己有 bug，实际上是"断言之间互相污染"。
 *
 * 我第一反应是改断言去迁就现状（"接管别人留下的桩"就算一种）。但那种改法只是把
 * 症状往后推：桩会越来越多，到底是"谁该清理"永远说不清，而下一个人照样会踩。
 * 所以这里从结构上解决：**每个模块一个进程**，进程退出时内核回收它的全局环境，
 * 谁也没法污染谁。代价是启动几次 Node（这几十毫秒换来的确定性非常值）。
 *
 * 每个模块自己打印中文的逐条结果与"结果：N 通过 / M 失败"，本脚本只负责
 * 汇总计数与退出码 —— 不解析、不重排、不改写它们的输出。
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = resolve(root, '.verify');

/**
 * 要跑的模块。顺序刻意把**主验证脚本放最后**：
 * 它最长、最慢，前面先跑完的模块能在出问题时先报出来。
 */
const ENTRIES = [
  { name: '内容统计热力图', entry: 'scripts/checks/contentstats.run.ts' },
  { name: '生成预览与模板面板', entry: 'scripts/checks/preview.run.ts' },
  { name: 'Worker 冲突检测', entry: 'scripts/checks/worker.run.ts' },
  { name: '自定义物品编辑器', entry: 'scripts/checks/customitem.run.ts' },
  { name: '流体核心（PBF / 空间哈希 / 粒子池）', entry: 'scripts/checks/fluid.run.ts' },
  { name: '流体渲染与编辑工具', entry: 'scripts/checks/fluid2.run.ts' },
  { name: '沙土物理（安息角 / 沙崩 / 编辑）', entry: 'scripts/checks/sand.run.ts' },
  { name: '流体-刚体耦合（浮力 / 阻力 / 冲击 / 力矩）', entry: 'scripts/checks/coupling.run.ts' },
  { name: '沙水交互（变湿 / 侵蚀 / 沉积 / 压塌）', entry: 'scripts/checks/sandwater.run.ts' },
  { name: '流体存档与教学关卡', entry: 'scripts/checks/savetutorial.run.ts' },
  { name: '压力测试场景与报告', entry: 'scripts/checks/stress.run.ts' },
  { name: '性能热力图与录制', entry: 'scripts/checks/perfrec.run.ts' },
  { name: '流体求解 Worker', entry: 'scripts/checks/fluidworker.run.ts' },
  { name: '主验证（M1.5~M4）', entry: 'scripts/verify.ts' },
];

mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

for (const { name, entry } of ENTRIES) {
  const outfile = resolve(outDir, `${entry.split('/').pop().replace(/\.ts$/, '')}.mjs`);
  process.stdout.write(`\n${'='.repeat(66)}\n▶ ${name}（${entry}）\n${'='.repeat(66)}\n`);

  try {
    await build({
      entryPoints: [resolve(root, entry)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      logLevel: 'error',
    });
  } catch (error) {
    // 打包失败＝源码有语法/导入错误，这条路必须让整个 verify 失败
    failed += 1;
    failures.push(`${name}：打包失败（${error instanceof Error ? error.message : String(error)}）`);
    console.error(`✗ ${name}：打包失败`);
    continue;
  }

  const run = spawnSync(process.execPath, [outfile], {
    cwd: root,
    encoding: 'utf8',
    // 断言脚本会大段打印中文结果，给足缓冲
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  // 只认模块自己那行汇总。解析不到就**当失败**：
  // "没有汇总"不能算通过 —— 那可能意味着脚本中途崩了却返回了 0
  const summary = /结果：(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(run.stdout ?? '');
  if (!summary) {
    failed += 1;
    failures.push(`${name}：没有输出"结果：N 通过 / M 失败"（退出码 ${run.status}）`);
    continue;
  }
  passed += Number(summary[1]);
  failed += Number(summary[2]);
  if (run.status !== 0 || Number(summary[2]) > 0) {
    failures.push(`${name}：${summary[2]} 条失败`);
  }
}

process.stdout.write(`\n${'='.repeat(66)}\n`);
process.stdout.write(`全部模块合计：${passed} 通过 / ${failed} 失败（${ENTRIES.length} 个模块，各自独立进程）\n`);
if (failures.length > 0) {
  process.stdout.write(`有失败的模块：\n${failures.map((item) => `  · ${item}`).join('\n')}\n`);
}
process.stdout.write(`${'='.repeat(66)}\n`);
process.exit(failed === 0 ? 0 : 1);
