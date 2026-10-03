#!/usr/bin/env node
// 破坏试验台账：文档/闸的每一条"会红"的说法都得真被打破一次，而且要跑在定稿的树上。
//
// 这个文件 2026-10-03 之前住在仓外的 `_tmp-midloop-dose.mjs`，那句话有两处不对：
//   * 住在仓外 = 不进版本控制、CI 看不见它、npm script 也调不到它。README 写"13 把刀逐条点名"，
//     于是那句话只活在某一台机器的终端记录里，改断言的人不会撞上它；
//   * 旧的那台架在**真树上**原地改文件、靠备份逐字节恢复。一次 SIGKILL 或一次人手打断，
//     就把改坏 的 README 留在树里，而这个仓的工作树是几个人共用的。
// 搬进仓里的同时换成副本作业：刀下在 `_sabotage-copy/`（.gitignore 里），真仓一个字节不动。
//
// 规矩（本仓的账）：
//   * 刀口是字面 needle：为空、命中 0 次或多次 → 报 ERROR 并退 2，不静默补一句（N2 死过一次）；
//   * 每一刀都要跑出 rc≠0，且红的那一行必须点名叫出预期的那条断言（红不说闸名＝第二宗罪，记 NOT-NAMED）；
//   * 下刀之前先在副本上跑一遍对照组：树本来就是红的，剂量出来的红不作数；
//   * 台账读的是它自己这一次的 rc，不转抄上一次的漂亮话；"与预期不符" 决定本脚本的退出码。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPY = join(ROOT, '_sabotage-copy');

// file/needle/repl 是刀口；cmd+args 是这把刀归谁管；want 是红必须点名叫出的那条断言里出现的串；
// promise 是这把刀守的那句承诺（台账打印它，红在别处时一眼看得出刀与承诺脱节）。
const KNIVES = [
  { id: 'K1', name: '档位表那行的越预算数被改小', file: 'README.md',
    needle: '| 9x9 | 48 | 3 | 1 | 1,020,156 |', repl: '| 9x9 | 48 | 3 | 0 | 1,020,156 |',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D1 9x9', promise: '菜单那一行四个数等于引擎字段' },
  { id: 'K2', name: 'README 的规则名表被改名', file: 'README.md',
    needle: '`arm-symmetry` `one-dot-per-run`', repl: '`arm-length` `one-dot-per-run`',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D2 README', promise: '文档列的规则名逐条等于 pencil.js 的 RULE_ORDER' },
  { id: 'K3', name: '闸的腿数被写成 8', file: 'README.md',
    needle: '闸的形状：腿 7 条', repl: '闸的形状：腿 8 条',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D3 文档写的腿数', promise: '文档写的腿数 == verify.sh 的 LEGS 默认值' },
  { id: 'K4', name: '前缀形态端口被改错', file: 'README.md',
    needle: '端口：本地 5281 · 前缀形态 5282', repl: '端口：本地 5281 · 前缀形态 5280',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D4b', promise: '两个 server 两个端口，前缀形态不是同一端口顺手兜底' },
  { id: 'K5', name: '节点预算被写小十倍', file: 'README.md',
    needle: '`NODE_CAP = 2000000`', repl: '`NODE_CAP = 200000`',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D5 文档写的节点预算', promise: '文档写的预算 == count.js 的 NODE_CAP' },
  { id: 'K6', name: '覆盖表少一行门禁', file: 'README.md',
    needle: '| `node tools/doctest.mjs` | check | `Docs are asserted surface` |\n', repl: '',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D6b', promise: 'CI 里跑的每个 tools 门禁都被覆盖表列了' },
  { id: 'K7', name: '默认抽样底被抄成 24', file: 'README.md',
    needle: '默认 48 张 × 3 个候选 × 6 档', repl: '默认 24 张 × 3 个候选 × 6 档',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D7 文档写的默认抽样底', promise: '文档写的抽样底 == balance 的默认' },
  { id: 'K8', name: '剂量覆盖面被夸大', file: 'README.md',
    needle: '`--dose` 剂量了 B2/B3/B3b/B4/B5/B6 六条', repl: '`--dose` 剂量了 B2/B3 两条',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D10c', promise: '文档写的剂量覆盖面 == --dose 里的剂量项' },
  { id: 'K9', name: '文档插一条越界的行号引用', file: 'DESIGN.md',
    needle: '## 1. 三套互不信任的实现', repl: '## 1. 三套互不信任的实现（见 js/engine/rules.js:999999）',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D9 文档里的 1 条', promise: '每条 path:NN 引用都落在真实文件的行数内' },
  { id: 'K10', name: '文档点名一条不存在的红线', file: 'DESIGN.md',
    needle: '## 7. 尺寸菜单是被量出来的', repl: '## 7. 尺寸菜单是被量出来的（另有一条红线 B7）',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D10 文档点名的每条红线', promise: '文档点名的每条红线在 balance.mjs 里都还在' },
  { id: 'K11', name: '计数器预算被砍到 30 个节点', file: 'js/engine/count.js',
    needle: 'export const NODE_CAP = 2000000;', repl: 'export const NODE_CAP = 30;',
    cmd: 'node', args: ['tools/engine-test.mjs'], want: '计数器在官方 5x5 上恰好数出 1',
    promise: '判据 1 的预算是真预算，不是摆设' },
  { id: 'K12', name: '页面那支笔的步数被翻倍', file: 'js/ui/game.js',
    needle: '    const rec = { kind: arr, idx, prev, value: kind, a: cell, b: nb };\n'
      + '    if (this._group) this._group.push(rec);\n    else {\n      this.undoStack.push([rec]);\n      this.moves++;',
    repl: '    const rec = { kind: arr, idx, prev, value: kind, a: cell, b: nb };\n'
      + '    if (this._group) this._group.push(rec);\n    else {\n      this.undoStack.push([rec]);\n      this.moves += 2;',
    cmd: 'bash', args: ['tools/verify.sh'], env: { LEGS: 'play', WD_TIMEOUT: '900' },
    want: '步数 = 落下的笔数', promise: '浏览器层数出来的步数等于落下的笔数（真事件，不是内部标志位）' },
  { id: 'K13', name: '--dose 六条剂量全打中（B1 出盘率不在名单里，文档写了这条）', probe: true,
    cmd: 'node', args: ['tools/balance.mjs', '--dose'], env: { SAMPLES: '6' },
    want: '都能被单独打破', promise: '名单里每条红线都能被单独打破（小底只为省机器）' },
  { id: 'K14', name: '台账在 CI 里那一步被摘掉（台架还在、没人跑它）', file: '.github/workflows/ci.yml',
    needle: 'run: node tools/sabotage.mjs', repl: 'run: echo "ledger not wired"',
    cmd: 'node', args: ['tools/doctest.mjs'], want: 'D6e 破坏台账接进了',
    promise: '"有台账"与"有人跑台账"是两句话，后者也需要一把自己的刀' },
];

const sh = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: COPY, encoding: 'utf8', env: { ...process.env, ...env } });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

// 副本自己走树，不用 cpSync 也不用 rsync：
//   * rsync 是外部二进制，"零运行时依赖"是本仓 README 写着的一条（D6d 还为此钉了 CI 里没有 npm install）；
//   * cpSync 更直接——它在跑 filter 之前就先判定"目标在源的子树里"，而 `_sabotage-copy/` 恰恰必须落在
//     仓内那一个位置（.gitignore 里那一行、CI 不用额外准备目录），于是报 ERR_FS_CP_EINVAL 死给你看。
//     第一版就是这么死的（`_tmp-midloop-cpsync-crash.log`）：对照组一行闸都没跑。
const SKIP = /(^|[\\/])(\.git|node_modules|_tmp[^\\/]*|_sabotage-copy)([\\/]|$)/;

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    if (SKIP.test(s)) continue;
    if (e.isDirectory()) copyTree(s, join(dest, e.name));
    else if (e.isFile()) copyFileSync(s, join(dest, e.name));
  }
}

function freshCopy() {
  rmSync(COPY, { recursive: true, force: true });
  copyTree(ROOT, COPY);
}

function cut(k) {
  const p = join(COPY, k.file);
  if (!k.needle) throw new Error('刀口是空的：不许用空 needle 改文件');
  if (typeof k.repl !== 'string') throw new Error('刀口没有替换文（删除要传空串，不是 undefined）');
  const src = readFileSync(p, 'utf8');
  if (!src.length) throw new Error(`${k.file} 读回来是空的（这棵树不对，别下刀）`);
  const hits = src.split(k.needle).length - 1;
  if (hits !== 1) throw new Error(`${k.file} 里 needle 命中 ${hits} 次（要正好 1 次）：${k.needle.slice(0, 40)}`);
  const next = src.replace(k.needle, k.repl);
  // 一刀最多改一行表；写成 0 字节那种"顺手清空"曾把 78 KB 变成 12 MB 的反面案例。
  if (next.length < src.length - 200) throw new Error(`${k.file} 这一刀改掉了 ${src.length - next.length} 个字符，太宽`);
  writeFileSync(p, next, 'utf8');
}

const dose = (k) => {
  freshCopy();
  if (k.probe) {
    const r = sh(k.cmd, k.args, k.env);
    const hits = (r.out.match(/ok   剂量 B\d(?:b)? 打中/g) || []).length;
    const miss = (r.out.match(/ERROR 剂量/g) || []).length;
    const red = (r.out.match(/^RED /gm) || []).length;
    // 分母不抄文档也不写死：从 balance.mjs 的 --dose 那段现数（D10c 走的是同一条路）。
    const bal = readFileSync(join(COPY, 'tools/balance.mjs'), 'utf8');
    const doseBlock = bal.slice(bal.indexOf("if (has('--dose'))"));
    const wantHits = [...new Set([...doseBlock.matchAll(/\['(B\d(?:b)?)',/g)].map((m) => m[1]))].length;
    const named = r.rc === 0 && miss === 0 && hits === wantHits && red === 0 && wantHits >= 4;
    return { rc: r.rc, named,
      line: `rc=${r.rc} 打中 ${hits} 条 / 落空 ${miss} 条 / 主表 RED ${red} 条（脚本里有 ${wantHits} 条剂量项）` };
  }
  cut(k);
  const r = sh(k.cmd, k.args, k.env);
  const named = r.rc !== 0 && r.out.split('\n').some((l) => /^\s*(FAIL|RED|ERROR)/.test(l) && l.includes(k.want));
  const line = (r.out.split('\n').find((l) => /^\s*(FAIL|RED|ERROR)/.test(l) && l.includes(k.want))
    || r.out.split('\n').find((l) => /^\s*(FAIL|RED|ERROR)/.test(l))
    || `rc=${r.rc} 一条 FAIL 都没发（闸在断言之前就死了）`).trim();
  return { rc: r.rc, named, line };
};

const only = (process.env.SAB_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const picked = only.length ? KNIVES.filter((k) => only.includes(k.id)) : KNIVES;

console.log('=== 台架自己是什么样 ===');
console.log(`台账 ${KNIVES.length} 把刀，这一轮打 ${picked.length} 把${only.length ? '（SAB_ONLY 子集）' : ''}`);
const legs = [...new Set(KNIVES.map((k) => [k.cmd, ...k.args].join(' ')))];
console.log(`腿：${legs.join(' ｜ ')}`);
console.log(`副本：${COPY.replace(ROOT, '')}（真仓不动）`);

console.log('\n=== 台账 0：下刀之前，被剂量的是绿的 ===');
// 一记刀只有在"没下刀时它绿"的前提下才说明红是刀造成的。树是红的就别下刀（红树配红刀＝什么都没证）。
{
  const ctrl = [];
  for (const [label, cmd, args] of [['doctest', 'node', ['tools/doctest.mjs']],
    ['engine-test', 'node', ['tools/engine-test.mjs']]]) {
    freshCopy();
    const r = sh(cmd, args);
    ctrl.push(`${label} rc=${r.rc}`);
    if (r.rc === 0) continue;
    console.log(`ERROR 对照跑 ${label} 本来就是红的（rc=${r.rc}），这台树上剂量出来的红不作数：\n`
      + r.out.split('\n').filter((l) => /^\s*(FAIL|RED|ERROR)/.test(l.trim())).slice(0, 6).join('\n'));
    console.log('\nrows: 0 每刀都必须红（闸不红＝台账红）: NO');
    rmSync(COPY, { recursive: true, force: true });
    process.exit(2);
  }
  console.log(`ok   对照组 ${ctrl.join(' · ')}（两条都 rc=0，下面每一记刀的红才能归给刀）`);
}

const rows = [];
console.log('\n=== 台账 1：每一条"文档/闸会红"的说法都得真被打破（跑在定稿的树上）===');
for (const k of picked) {
  let r;
  try {
    r = dose(k);
  } catch (e) {
    rows.push({ k, rc: null, named: false, line: String(e.message), bad: true });
    console.log(`ERR  ${k.id} ${k.name} :: ${e.message}`);
    continue;
  }
  const bad = k.probe ? !r.named : (r.rc === 0 || !r.named);
  rows.push({ k, ...r, bad });
  const note = r.rc === 0 ? '（这一刀没把闸跑红）'
    : (!r.named ? '（红了但没点名要的那条断言）' : '');
  console.log(`${bad ? 'RED ' : 'ok  '} ${k.id} ${k.name} rc=${r.rc ?? '-'} ${r.line.slice(0, 120)}${note}`);
}

console.log('\n=== 台账汇总 ===');
let bad = 0;
for (const r of rows) {
  if (r.bad) bad++;
  console.log(`  ${r.bad ? 'RED' : 'ok '} ${r.k.id} ${r.k.name} :: ${[r.k.cmd, ...r.k.args].join(' ')} :: ${r.line.slice(0, 100)}`);
  if (!r.bad) console.log(`        承诺：${r.k.promise}`);
}
console.log(`\n每刀都必须红且点名: ${bad === 0 ? 'yes' : 'NO'} · 不符 ${bad} 把`);
console.log(`rows: ${rows.length} 每刀都必须红（闸不红＝台账红）: ${bad === 0 ? 'yes' : 'NO'}`);
// 副本里躺着的是最后一把刀改过的树；留着它，下一个读仓的人会把 `_sabotage-copy/js/...` 当成真源。
rmSync(COPY, { recursive: true, force: true });
if (bad) process.exit(1);
if (only.length && process.env.CI) {
  console.log('CI 里不许打子集：台账整跑才算这一轮的读数');
  process.exit(1);
}
