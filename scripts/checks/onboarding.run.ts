import { runOnboardingChecks } from './onboarding.check';

let pass = 0;
let fail = 0;
const failed: string[] = [];
runOnboardingChecks((name, ok, detail) => {
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
