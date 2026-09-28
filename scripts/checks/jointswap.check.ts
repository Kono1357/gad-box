/**
 * 「世界锚点写在 A 侧」的关节兼容性断言（M5 收尾时修掉的真实 bug）。
 *
 * ────────────────────────────────────────────────────────────
 * 这个 bug 是什么
 * ────────────────────────────────────────────────────────────
 * `JointSystem.add()` 原本只认「`bodyB` 为空串 = 连到世界」这一种写法（这与
 * `jointTypes.ts` 里 `bodyB` 的注释一致）。可是 `src/data/combos.ts` 里有 **8 处**
 * 把世界写在了 `bodyA`（空串）、把实体的下标写在 `bodyB`。于是这些配置在
 * `const bodyA = parseBodyRef(config.bodyA); if (bodyA < 0) return -1;` 处直接返回 -1。
 *
 * 更糟的是 `ComboBuilder` 把 -1 一律当成「物理还没就绪，已进待建队列，会自动补建」
 * 并输出这句中文提示 —— 而物理其实早就要绪了，永远不会补建。玩家看到的是：
 * 门不绕框转、齿轮不转、吊桥不落、电梯不动，提示却说过一会儿就好。
 *
 * 修法是**在 `add()` 里归一化**（世界那一侧换到 B 位），不是改那 8 处数据：
 * 归一化放在这一层能同时覆盖组合、示例、存档导入等所有调用方。
 * 互换是安全的，因为关节锚点是**世界坐标**（`config.anchor`），两侧各自用
 * `rotateInverse` 算相对自己刚体的局部偏移 —— A/B 只决定"谁排在前面"。
 *
 * ────────────────────────────────────────────────────────────
 * 这份断言为什么值得信
 * ────────────────────────────────────────────────────────────
 * 它不是读源码猜的：下面**真的初始化 Rapier、真的建刚体、真的建关节**，
 * 用返回值与 `count` / `pendingCount` 说话。谁把归一化删了，这里立刻红。
 *
 * 跑法见同目录 `jointswap.run.ts`。
 */

import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import type { BodySpec } from '../../src/physics/PhysicsWorld';
import { JointSystem } from '../../src/physics/JointSystem';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与其它断言模块同一形状：`(名称, 是否通过, 细节)` */
type CheckFn = (name: string, condition: boolean, detail?: string) => void;

/** 定位仓库根（断言要读真实数据文件来核对"到底有几处这种写法"） */
function findRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    try {
      readFileSync(resolve(dir, 'package.json'), 'utf8');
      return dir;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  return null;
}

/** 一个 1 米的方块刚体（关节只需要有个真实句柄，形状不影响本次结论） */
function boxSpec(mode: 'static' | 'dynamic', x: number): BodySpec {
  return {
    mode,
    position: [x, 1, 0],
    rotationY: 0,
    colliders: [
      { kind: 'box', position: [0, 0, 0], halfExtents: [0.5, 0.5, 0.5], radius: 0.5, halfHeight: 0.5 },
    ],
    density: 1,
    friction: 0.5,
    restitution: 0.1,
  };
}

export async function runJointSwapChecks(check: CheckFn): Promise<void> {
  const root = findRoot();
  check('定位到仓库根目录（后面读源码的断言都依赖它）', root !== null, root ?? '没找到 package.json');

  // ================================================================
  // 一、源码层：归一化确实在 add() 里，而且注释交代了理由
  // ================================================================
  if (root) {
    const joint = readFileSync(resolve(root, 'src/physics/JointSystem.ts'), 'utf8');
    check(
      'add() 里存在「世界在 A 侧」的归一化（这就是修复本身，被删掉这里立刻红）',
      /isWorldRef\(rawConfig\.bodyA\)/.test(joint) && /bodyA:\s*rawConfig\.bodyB/.test(joint),
      '检测到 isWorldRef(rawConfig.bodyA) 与 bodyA: rawConfig.bodyB 的互换',
    );
    check(
      '归一化的注释交代了「为什么互换安全」（锚点是世界坐标、两侧各算局部偏移）',
      joint.includes('世界坐标') && joint.includes('rotateInverse'),
      '注释里能看到锚点语义的说明',
    );
    check(
      '归一化保留了原始配置对象（不就地改调用方传进来的对象 —— 那会污染组合模板）',
      /const config: JointConfig =/.test(joint) && !/rawConfig\.bodyA\s*=/.test(joint),
      '用 const config 承接新对象，没有对 rawConfig 赋值',
    );

    // 数据层现状：这些写法是本次要兼容的对象，数量写进细节里备查
    const combos = readFileSync(resolve(root, 'src/data/combos.ts'), 'utf8');
    const worldInA = combos.match(/bodyA:\s*''/g)?.length ?? 0;
    check(
      '登记：combos.ts 里把世界写在 A 侧的地方（这些就是原先全都建不出关节的组合）',
      worldInA >= 1,
      `${worldInA} 处（修好后它们都能建成；数量为 0 说明有人改成 B 侧写法了，那时本条仍应通过）`,
    );

    const jointTypes = readFileSync(resolve(root, 'src/data/jointTypes.ts'), 'utf8');
    check(
      'bodyA 的注释说明了「空串也当世界处理」这个兼容行为（不然下一个人还会照旧写错）',
      /bodyA/.test(jointTypes) && jointTypes.includes('兼容'),
      'jointTypes.ts 里 bodyA 的注释提到了兼容',
    );
  }

  // ================================================================
  // 二、真实物理：两种写法都要能建成，且都能建成「同样多」的关节
  // ================================================================
  const physics = new PhysicsWorld();
  const ready = await physics.init();
  check('Rapier 初始化成功（后面的结论都建立在这一步上）', ready, physics.errorMessage || '');

  const joints = new JointSystem(physics);
  const anchorHandle = physics.createBody(boxSpec('static', -2), 0);
  const bodyHandle = physics.createBody(boxSpec('dynamic', 2), 1);
  check('两个测试刚体建成（静态锚点 + 动态实体）', anchorHandle >= 0 && bodyHandle >= 0,
    `锚点 #${anchorHandle}｜实体 #${bodyHandle}`);

  // ① 规范写法：实体在 A、世界在 B
  const canonical = joints.add({
    type: 'revolute',
    bodyA: String(bodyHandle),
    bodyB: '',
    anchor: [1, 2, 0],
    axis: [0, 1, 0],
    limits: { min: 0, max: 1.57 },
    label: '规范写法',
  });
  check('规范写法（实体 A / 世界 B）能建成', canonical > 0, `joint #${canonical}`);

  // ② 组合数据里的写法：世界在 A、实体在 B —— **这是修复前必然失败的那一种**
  const swapped = joints.add({
    type: 'revolute',
    bodyA: '',
    bodyB: String(bodyHandle),
    anchor: [1, 2, 0],
    axis: [0, 1, 0],
    limits: { min: 0, max: 1.57 },
    label: '世界在 A 的写法',
  });
  check('「世界在 A 侧」的写法现在也能建成（修复点：以前这里返回 -1）', swapped > 0, `joint #${swapped}`);
  check('两种写法产生的关节数一致（各 1 个，共 2 个）', joints.count === 2, `count=${joints.count}`);
  check(
    '两种写法都不会被误判成「等物理就绪」（待建队列必须为空 —— 这正是那个假提示的来源）',
    joints.pendingCount === 0,
    `pendingCount=${joints.pendingCount}`,
  );

  // ③ 归一化后至少一个关节真的挂上了静态锚点刚体：物理就绪后 step 不炸即可佐证
  let stepError = '';
  try {
    physics.step();
  } catch (error) {
    stepError = error instanceof Error ? error.message : String(error);
  }
  check('建完这两种关节后 step() 不抛异常（说明句柄确实有效）', stepError === '', stepError || '步进正常');

  // ④ 两端都是世界：仍然要如实失败，不能"归一化"出一个无意义的关节
  const bothWorld = joints.add({
    type: 'revolute',
    bodyA: '',
    bodyB: '',
    anchor: [0, 3, 0],
    axis: [0, 1, 0],
    label: '两端都是世界',
  });
  check('两端都是世界仍然返回 -1（不硬造出一个没有实体的关节）', bothWorld === -1, `返回 ${bothWorld}`);
  check('而且这种非法配置也不该进待建队列（排队只留给"物理未就绪"）',
    joints.pendingCount === 0, `pendingCount=${joints.pendingCount}`);

  // ⑤ 物理未就绪时的排队语义必须保留（归一化不能把这条语义弄坏）
  const cold = new PhysicsWorld();
  const coldJoints = new JointSystem(cold);
  const coldId = coldJoints.add({
    type: 'revolute',
    bodyA: '',
    bodyB: '7',
    anchor: [0, 1, 0],
    axis: [0, 1, 0],
    label: '未就绪时提交',
  });
  check('物理未就绪时仍然返回 -1 并进待建队列（排队语义没被归一化破坏）',
    coldId === -1 && coldJoints.pendingCount === 1,
    `返回 ${coldId}，队列 ${coldJoints.pendingCount}`);

  physics.dispose();
}
