// 文档是被断言的面：README/DESIGN 印出去的每一个「现值」都必须等于代码或脚本里的现在值。
//
// 为什么要有这个文件：引擎断言、bake 出来的读数、balance 的红线都有命令去重测，而一段散文没有。
// 它可以一直抄下去，直到某天代码改了字、文档还在引用上一个世界的数。本仓文档里有一整类这样的数——
// 菜单档位、`TOO_EXPENSIVE` 的四列读数、十条规则名、闸的腿×形态×报告、三个端口、节点预算、
// 默认抽样底、CI 里到底跑了哪几条门禁——每一个都能由一条等式钉住，于是这里钉住它们。
//
// 规矩（和 tools/balance.mjs 的 B5 一样）：
//   * 每一条等式都配一条「解析到的条数」的反空转断言——正则没命中不是绿，是红；
//   * 只比现值，不复测读数：med/p95/max 节点与毫秒是**观测值**，文档要把它们指向日志，
//     这里只检查"代码里的界"与"文档写的数"之间的关系（D5b）；
//   * 台账（README 的破坏试验一节）逐条验过这里的刀真的会红。
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIZES, TOO_EXPENSIVE } from '../js/engine/generate.js';
import { RULE_ORDER } from '../js/engine/pencil.js';
import { NODE_CAP } from '../js/engine/count.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const fail = [];
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  if (!cond) fail.push(label);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};
const grp = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DOCS = README + '\n' + DESIGN;
const CI = read('.github/workflows/ci.yml');
const BAL = read('tools/balance.mjs');
const VERIFY = read('tools/verify.sh');
const PKG = JSON.parse(read('package.json'));
const SERVER = read('server.cjs');
const PLAYTEST = read('tools/playtest.cjs');
const PENCIL = read('js/engine/pencil.js');

// ---- D1 档位表：文档列的菜单档 == SIZES，出菜单那几行的四个数 == TOO_EXPENSIVE 的字段 ----
const menuDoc = (README.match(/菜单只列 `([^`]+)`/) || [])[1];
const menuList = menuDoc ? menuDoc.trim().split(/\s+/) : [];
ok(!!menuDoc && menuList.length === SIZES.length && menuList.every((s, i) => s === SIZES[i]),
  `D1 文档列的菜单档逐档等于引擎的 SIZES（${SIZES.join(' ')}）`,
  menuDoc ? `文档 ${menuList.join(' ')} vs 代码 ${SIZES.join(' ')}` : '解析不到那一句（解析不到＝红，不是绿）');
// 页面也不许自带第二张表：菜单只能从引擎读——自带一张就会在引擎改档之后继续卖旧菜单。
const MAIN = read('js/main.js');
ok(!/SIZES\s*=\s*\[/.test(MAIN) && /import \{[^}]*\bSIZES\b[^}]*\} from '\.\/engine\/generate\.js'/.test(MAIN),
  'D1z 页面没有把档位写死成第二张表（它 import 引擎的那一份）',
  /SIZES\s*=\s*\[/.test(MAIN) ? 'main.js 里出现了一张自己的档位表' : 'main.js 只有 import 与读取');

const tierRows = [...README.matchAll(/^\| (\d+x\d+) \| (\d+) \| (\d+) \| (\d+) \| ([\d,]+) \|$/gm)];
ok(tierRows.length === TOO_EXPENSIVE.length,
  'D1a 出菜单那张表解析到的行数等于 TOO_EXPENSIVE 的条目数',
  `解析 ${tierRows.length} 行 vs 引擎 ${TOO_EXPENSIVE.length} 条（解析不到不等于通过）`);
for (const e of TOO_EXPENSIVE) {
  const row = tierRows.find((m) => m[1] === e.key);
  const nums = row && [+row[2], +row[3], +row[4], +row[5].replace(/,/g, '')];
  const want = [e.samples, e.attempts, e.over, e.maxNodes];
  ok(!!row && nums.every((v, i) => v === want[i]),
    `D1 ${e.key} 那一行的四个数等于引擎字段（种子/候选/越预算/出货最大节点）`,
    row ? `文档 ${nums.join('/')} vs 字段 ${want.join('/')}` : `表里没有 ${e.key} 这一行`);
  // 文档写千分位，字段是裸数：逗号格式也必须和引擎拼句子时用的是同一套，否则选择页与文档两种写法。
  ok(!!row && row[5] === grp(e.maxNodes), `D1b ${e.key} 的千分位写法与引擎拼那句理由时同一套`,
    row ? `文档 "${row[5]}" vs grp(${e.maxNodes})="${grp(e.maxNodes)}"` : '没有那一行');
}

// ---- D2 十条命名规则：两份文档列的名字序列 == RULE_ORDER，且不只活在注释里 ----
const rulesAfter = (src, anchor) => {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const run = src.slice(at + anchor.length).match(/^((?:\s*`[a-z][a-z-]+`){2,})/);
  return run ? (run[1].match(/`[a-z][a-z-]+`/g) || []).map((s) => s.replace(/`/g, '')) : null;
};
const docRuleLists = [
  ['README', rulesAfter(README, '一共 10 条：')],
  ['DESIGN', rulesAfter(DESIGN, '规则名固定十条（`RULE_ORDER`）：')],
].filter(([, l]) => l);
ok(docRuleLists.length === 2, 'D2a 两份文档都解析到了那一条规则名序列（少一份就是解析器空转）',
  `解析到 ${docRuleLists.map(([w]) => w).join(' + ') || '无'}`);
for (const [where, list] of docRuleLists) {
  ok(list.length === RULE_ORDER.length && list.every((r, i) => r === RULE_ORDER[i]),
    `D2 ${where} 列的规则名逐条等于 pencil.js 的 RULE_ORDER`,
    `代码 ${RULE_ORDER.join(' ')} vs ${where} ${list.join(' ')}`);
}
// 名字必须出现在**非注释行**里：整份文件一起数会被头部清单凑够次数，
// 那样「不只活在注释里」这句标签就在说谎。
const PENCIL_BODY = PENCIL.split('\n').filter((l) => !/^\s*\/+\s/.test(l)).join('\n');
const ghost = RULE_ORDER.filter((r) => PENCIL_BODY.split(r).length - 1 < 1);
ok(ghost.length === 0, 'D2b 每条规则名都不只活在注释里（非注释行里至少出现一次）',
  ghost.length ? `只有声明没有实现：${ghost.join(' ')}` : `${RULE_ORDER.length} 条名字在 pencil.js 的非注释行里各出现 ≥1 次`);
const textless = RULE_ORDER.filter((r) => !/RULE_TEXT/.test(PENCIL_BODY) || !(PENCIL.match(new RegExp(`'${r}':`))));
ok(textless.length === 0, 'D2c 每条规则都有一句说给玩家的话（RULE_TEXT 里有它）',
  textless.length ? `缺文案：${textless.join(' ')}` : '十条都有文案');

// ---- D3 闸的形状：腿数、形态数、每形态报告数、合计，全部从脚本现值推 ----
const legsM = VERIFY.match(/LEGS=\$\{LEGS:-([^}]*)\}/);
const legs = legsM ? legsM[1].trim().split(/\s+/) : [];
const shapesM = VERIFY.match(/SHAPES=\(([^)]*)\)/);
const shapes = shapesM ? (shapesM[1].match(/"([^"]+)"/g) || []).length : 0;
const scenarioRuns = (VERIFY.match(/^\s*run_scenario /gm) || []).length;
const cmdRuns = (VERIFY.match(/^\s*run_cmd /gm) || []).length;
const reportsPerShape = scenarioRuns + cmdRuns;
const shapeDoc = DOCS.match(/闸的形状：腿 (\d+) 条 · 形态 (\d+) 种 · 每形态 (\d+) 份报告 · 合计 (\d+) 份/);
ok(legs.length >= 5 && shapes >= 2 && reportsPerShape >= 5 && !!shapeDoc,
  'D3a 脚本与文档两边都解析到了闸的形状',
  `verify.sh: ${legs.length} 腿 × ${shapes} 形态 × ${reportsPerShape} 报告（${scenarioRuns} scenario + ${cmdRuns} cmd）· 文档句 ${shapeDoc ? '在' : '不在'}`);
ok(!!shapeDoc && +shapeDoc[1] === legs.length, `D3 文档写的腿数等于 LEGS 的默认值（${legs.join(' ')}）`,
  shapeDoc ? `文档 ${shapeDoc[1]} vs 脚本 ${legs.length}` : '解析不到');
ok(!!shapeDoc && +shapeDoc[2] === shapes, 'D3b 文档写的形态数等于 SHAPES 的条目数',
  shapeDoc ? `文档 ${shapeDoc[2]} vs 脚本 ${shapes}` : '解析不到');
ok(!!shapeDoc && +shapeDoc[3] === reportsPerShape,
  `D3c 文档写的每形态报告数等于脚本里的 run_scenario+run_cmd 次数（${reportsPerShape}）`,
  shapeDoc ? `文档 ${shapeDoc[3]} vs 脚本 ${reportsPerShape}` : '解析不到');
ok(!!shapeDoc && +shapeDoc[4] === reportsPerShape * shapes, 'D3d 合计份数 == 每形态 × 形态数',
  shapeDoc ? `文档 ${shapeDoc[4]} vs ${reportsPerShape}×${shapes}=${reportsPerShape * shapes}` : '解析不到');
// 报告名单也得是现值：文档那份名单的数量与脚本那 16 次调用一一对得上。
const namesDoc = (README.match(/16 份报告 = 脚本里 (\d+) 次 `run_scenario` \+ (\d+) 次 `run_cmd`：`([^`]+)`/) || []);
const nameList = namesDoc[3] ? namesDoc[3].trim().split(/\s+/) : [];
ok(!!namesDoc[3] && +namesDoc[1] === scenarioRuns && +namesDoc[2] === cmdRuns
  && nameList.length === reportsPerShape,
  `D3e 文档点名的报告名单与脚本的 ${reportsPerShape} 次调用同数同底`,
  namesDoc[3] ? `文档 ${namesDoc[1]}+${namesDoc[2]}=${nameList.length} 个名字 vs 脚本 ${scenarioRuns}+${cmdRuns}=${reportsPerShape}` : '解析不到那一句');

// ---- D4 端口：文档那一句 == verify.sh / package.json / playtest.cjs / server.cjs 的现值 ----
const httpM = VERIFY.match(/HTTP=\$\{HTTP_PORT:-(\d+)\}/);
const http2M = VERIFY.match(/HTTP2=\$\{HTTP_PORT2:-(\d+)\}/);
const cdpM = VERIFY.match(/PORT=\$\{CDP_PORT:-(\d+)\}/);
const devM = (PKG.scripts?.dev || '').match(/server\.cjs\s+(\d+)/);
const defM = SERVER.match(/DEFAULT_PORT = (\d+)/);
const phM = PLAYTEST.match(/CDP_PORT \|\| (\d+)/);
const pbM = PLAYTEST.match(/BASE_URL \|\| 'http:\/\/127\.0\.0\.1:(\d+)/);
const portDoc = DOCS.match(/端口：本地 (\d+) · 前缀形态 (\d+) · CDP (\d+)/);
ok(httpM && http2M && cdpM && devM && defM && phM && pbM && portDoc,
  'D4a 七个来源都解析到了端口（少一个就说明接线改了形状）',
  `verify ${httpM?.[1]}/${http2M?.[1]}/${cdpM?.[1]} · package ${devM?.[1]} · server ${defM?.[1]} · playtest ${pbM?.[1]}/${phM?.[1]} · 文档 ${portDoc?.[1]}/${portDoc?.[2]}/${portDoc?.[3]}`);
const localVals = [httpM?.[1], devM?.[1], defM?.[1], pbM?.[1]];
const prefixVals = [http2M?.[1]];
const cdpVals = [cdpM?.[1], phM?.[1]];
ok(!!portDoc && localVals.every((v) => +v === +portDoc[1]),
  `D4 本地端口四处一致且等于文档（${localVals.join('/')}）`, portDoc ? `文档 ${portDoc[1]}` : '解析不到');
ok(!!portDoc && prefixVals.every((v) => +v === +portDoc[2]),
  `D4b 前缀形态端口等于文档（${prefixVals.join('/')}），且与本地端口不是同一个（两个 server）`,
  portDoc ? `文档 ${portDoc[2]} vs 本地 ${portDoc[1]}` : '解析不到');
ok(!!portDoc && cdpVals.every((v) => +v === +portDoc[3]),
  `D4c CDP 端口两处一致且等于文档（${cdpVals.join('/')}）`, portDoc ? `文档 ${portDoc[3]}` : '解析不到');

// ---- D5 预算：文档写的界 == count.js 的 NODE_CAP；出菜单那档的读数必须真在界内 ----
const capDoc = (README.match(/`NODE_CAP = (\d+)`/) || [])[1];
ok(!!capDoc && +capDoc === NODE_CAP, `D5 文档写的节点预算等于 count.js 的 NODE_CAP（${NODE_CAP}）`,
  capDoc ? `文档 ${capDoc} vs 代码 ${NODE_CAP}` : '解析不到');
const overDose = TOO_EXPENSIVE.filter((e) => e.maxNodes >= NODE_CAP);
ok(overDose.length === 0, 'D5b 「越线的是候选、出货盘仍在预算内」这句是真的：每一档出货最大节点 < 预算',
  overDose.length ? `越界：${overDose.map((e) => `${e.key}=${e.maxNodes}`).join(' ')}`
    : TOO_EXPENSIVE.map((e) => `${e.key} ${grp(e.maxNodes)}<${grp(NODE_CAP)}`).join(' ，'));
// 预算必须还是节点数：毫秒参与判定的话，同一颗 seed 会在快慢机器上画出两张盘。
ok(!/msCap|MS_CAP|elapsedMs\s*[<>]/.test(read('js/engine/generate.js')),
  'D5c 生成器里没有第二个以毫秒为单位的界（成本只按节点数判）', 'generate.js 只认 cap/NODE_CAP');

// ---- D6 CI 覆盖表：文档声称在 CI 跑的门禁，必须真在那个 job 里 ----
const jobBlocks = {};
// 只在 jobs: 那一段里找 job——`on:` 与 `permissions:` 下也是两空格缩进的 key，
// 整份文件一起匹配会把 push/pull_request 当成 job 名。
const jobsSrc = CI.slice(CI.indexOf('\njobs:'));
for (const m of jobsSrc.matchAll(/^ {2}([A-Za-z0-9_-]+):([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:|\n(?=\S)|(?![\s\S]))/gm)) {
  jobBlocks[m[1]] = m[2];
}
const ciRows = [...README.matchAll(/^\| `([^`]+)` \| (check|browser) \| `([^`]+)` \|$/gm)];
ok(Object.keys(jobBlocks).length >= 2 && ciRows.length >= 4,
  'D6a CI 的 job 块与文档的覆盖表都解析到了东西',
  `job ${Object.keys(jobBlocks).join('/')} · 覆盖表 ${ciRows.length} 行`);
for (const r of ciRows) {
  const block = jobBlocks[r[2]] || '';
  ok(block.includes(r[3]) && block.includes(r[1].split(' ').slice(-2).join(' ')),
    `D6 覆盖表那一行真在 ${r[2]} job 里：${r[1]}`, `步骤名 ${r[3]}`);
}
const ciCommands = [...CI.matchAll(/node tools\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
const unlisted = [...new Set(ciCommands)].filter((c) => ![...ciRows].some((r) => r[1].includes(c)));
ok(unlisted.length === 0, 'D6b ci.yml 里跑的每个 tools 门禁都被覆盖表列了（文档不许比门禁松）',
  unlisted.length ? `漏了：${unlisted.join(' ')}` : `runner 里 ${[...new Set(ciCommands)].join(' ')} 全在表上`);
const jobNames = [...README.matchAll(/`([^`]*)`（node (20|22)）/g)];
const realJobNames = Object.values(jobBlocks).map((b) => (b.match(/name: (.+)/) || [])[1]).filter(Boolean);
ok(jobNames.length === 2 && jobNames.every((m) => realJobNames.includes(m[1])),
  'D6c 文档写出的两个 job 名与 job 名现值一致，且 node 版本对得上',
  `${jobNames.map((m) => `${m[1]}@${m[2]}`).join(' + ')} vs ci.yml ${realJobNames.join(' / ')}`);
// 只数**会执行的那一行**：ci.yml 与 README 都会写「npm install」这三个字（一条注释、一句承诺），
// 拿整份文件做子串匹配的话，这道门会把"解释为什么不装"当成"装了"，红得不讲道理。
const npmRuns = CI.split('\n').filter((l) => !/^\s*#/.test(l) && /\bnpm (install|ci)\b/.test(l));
const npmCache = CI.split('\n').filter((l) => !/^\s*#/.test(l) && /cache:\s*'?npm'?/.test(l));
ok(npmRuns.length === 0 && npmCache.length === 0, 'D6d CI 里没有一行会装东西（零运行时依赖不是口号）',
  npmRuns.length || npmCache.length ? `装了：${[...npmRuns, ...npmCache].map((l) => l.trim()).join(' ｜ ')}`
    : '跑起来的那一行里没有 npm install/npm ci，也没让 setup-node 去缓存 npm');

// 破坏台账（tools/sabotage.mjs）2026-10-03 之前住在仓外的 `_tmp-midloop-dose.mjs`：CI 看不见它、
// npm 调不到它，于是 README 那句"13 把刀逐条点名"只活在某一台机器的终端记录里。搬进仓里之后，
// "有人跑它"这句话得由四处一起撑着：browser job 的那一步 / package.json / README / 台架里那把
// 专门砍这条接线的刀（K14）。少一处，台账就重新变回一段没人执行的代码——而这句话本身也必须能红，
// 所以 K14 砍的是 ci.yml 那一处，其余三处仍然写着"有人在跑"。
// verify.sh 故意不在名单里：本地验收门不该压上一整轮剂量（它自己那一轮的读数住在它自己的日志里）。
const SAB = existsSync(join(ROOT, 'tools/sabotage.mjs')) ? read('tools/sabotage.mjs') : '';
const sabWires = {
  ci: /node tools\/sabotage\.mjs/.test(jobBlocks.browser || ''),
  pkg: ((PKG.scripts || {}).sabotage || '').trim() === 'node tools/sabotage.mjs',
  readme: /node tools\/sabotage\.mjs/.test(README),
  knife: /D6e 破坏台账接进了/.test(SAB),
};
ok(Object.values(sabWires).every(Boolean),
  'D6e 破坏台账接进了 browser job、package.json 与 README，而且这条接线自己有一把刀（砍掉任何一处它就只是一段代码）',
  Object.entries(sabWires).map(([k, v]) => `${k}=${v ? '在' : '缺'}`).join(' · ') + (SAB ? '' : ' · 台架文件不在树里'));

// ---- D7 默认抽样底：文档写的 == balance 的默认 == TOO_EXPENSIVE 那句理由的底 ----
const baseDoc = (README.match(/默认 (\d+) 张 × (\d+) 个候选 × (\d+) 档/) || []);
const samplesM = BAL.match(/SAMPLES = Number\(process\.env\.SAMPLES \|\| \(has\('--quick'\) \? \d+ : (\d+)\)/);
const attemptsM = BAL.match(/ATTEMPTS = Number\(process\.env\.ATTEMPTS \|\| \(LADDER \? \d+ : (\d+)\)/);
const probedM = BAL.match(/DEFAULT_PROBED = \[([^\]]*)\]/);
const tiersLive = SIZES.length + TOO_EXPENSIVE.length;
ok(!!baseDoc[1] && samplesM && attemptsM && probedM, 'D7a 文档与 balance 两边都读到了抽样底',
  `文档 ${baseDoc[1]}×${baseDoc[2]}×${baseDoc[3]} · 代码 ${samplesM?.[1]}×${attemptsM?.[1]}（档位来源 ${probedM?.[1] ? '在' : '不在'}）`);
ok(!!baseDoc[1] && +baseDoc[1] === +(samplesM || [])[1] && +baseDoc[2] === +(attemptsM || [])[1],
  `D7 文档写的默认抽样底等于 balance 的默认（${samplesM?.[1]} × ${attemptsM?.[1]}）`,
  baseDoc[1] ? `文档 ${baseDoc[1]}×${baseDoc[2]} vs 代码 ${samplesM?.[1]}×${attemptsM?.[1]}` : '解析不到');
ok(!!baseDoc[3] && +baseDoc[3] === tiersLive, `D7b 文档写的档数等于 SIZES+TOO_EXPENSIVE（${tiersLive}）`,
  baseDoc[3] ? `文档 ${baseDoc[3]} vs ${SIZES.length}+${TOO_EXPENSIVE.length}` : '解析不到');
ok(TOO_EXPENSIVE.every((e) => e.samples === +(samplesM || [])[1] && e.attempts === +(attemptsM || [])[1]),
  'D7c 每一条「太贵」的理由都是在这个底上量的（换底复测时 B5 只会 NOTE 不会逐数对账）',
  TOO_EXPENSIVE.map((e) => `${e.key}:${e.samples}×${e.attempts}`).join(' '));
const probe = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, 'tools/balance.mjs')], { env: { ...process.env, SAMPLES: '3' } });
  let buf = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(buf || '(no output)'); }, 20000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    if (/每档 \d+ 张/.test(buf)) { clearTimeout(timer); child.kill('SIGKILL'); resolve(buf.split('\n')[0]); }
  });
  child.on('close', () => { clearTimeout(timer); resolve(buf.split('\n')[0] || '(exited silently)'); });
});
ok(/每档 3 张/.test(probe), 'D7d 子进程探针：SAMPLES=3 必须真的改成 3 张（env 是接上的，不是装饰）',
  `balance 第一行：${probe}`);

// ---- D8 反空转的说法也要有闸：文档吹的每一组对照都得在 engine-test 里存在 ----
const ET = read('tools/engine-test.mjs');
const goldens = (README.match(/`(\d+) \/ (\d+) \/ (\d+) \/ (\d+)`/) || []);
const goldenLine = ET.match(/for \(const n of \[(\d+), (\d+), (\d+), (\d+)\]\)/);
const GOLD = [1, 13, 213, 9349];
ok(!!goldens[1] && !!goldenLine && goldenLine.slice(1, 5).join(',') === [2, 3, 4, 5].join(','),
  'D8 文档写的金标准环数与 engine-test 那段 C 的档位（n=2..5）对得上',
  goldens[1] ? `文档 ${goldens.slice(1, 5).join('/')} vs 断言 ${GOLD.join('/')}` : '解析不到');
ok(/eq\(`\$?\{n\}x\{n\} 无点/.test(ET) || ET.includes('无点：mrv='),
  'D8b 金标准那四个数是被断言的，不是散文', 'engine-test C 段存在');
const weakStrong = [...README.matchAll(/(\d+)\s*个环/g)].map((m) => +m[1]);
ok(ET.includes(', 26)') && ET.includes(', 1)') && weakStrong.includes(26),
  'D8c 强/弱读法那两个数（26 与 1）两边都在：README 印它、engine-test 断言它',
  `README 里的「N 个环」${weakStrong.join('/')} · engine-test 有 26 与 1 两条等式`);

// ---- D9 引用不漂：文档里每一个 path:NN 都指向真实文件里真实存在的那一行 ----
const cites = [...DOCS.matchAll(/((?:\.github\/workflows\/)?[\w./-]+\.[A-Za-z][A-Za-z0-9]{0,11}):(\d+)(?:-(\d+))?/g)];
// 一条引用能犯的错有三样：文件不在树里、行号越界、被指的行段整段是空行。第三样是这一轮补的：
// 在前面插几行之后 `:NN` 指的是隔壁的空行，可它照样"在界内"——只问"行号存在吗"的闸一路绿。
const citeMiss = (raw, fromRaw, toRaw) => {
  let src;
  try { src = read(raw); } catch { return `${raw}:${fromRaw}（文件不存在）`; }
  const L = src.split('\n');
  const to = +(toRaw || fromRaw);
  if (+fromRaw > L.length || to > L.length) return `${raw}:${fromRaw}${toRaw ? '-' + toRaw : ''}（该文件只有 ${L.length} 行）`;
  if (L.slice(+fromRaw - 1, to).join('').trim() === '') return `${raw}:${fromRaw}${toRaw ? '-' + toRaw : ''} 那几行整段是空行`;
  return '';
};
const bad = cites.map((c) => citeMiss(c[1], c[2], c[3])).filter(Boolean);
// 本仓文档今天一条 :NN 都不引，空行这一问就没有真靶子可打——所以靶子从本闸自己的文件里现量
// （写死行号会在有人把那一行填上的那天停止测试），量不到就改口变红，不许静默绿。
const ownLines = read('tools/doctest.mjs').split('\n');
let blankAt = 0;
for (let i = 1; i < ownLines.length; i++) if (String(ownLines[i]).trim() === '') { blankAt = i + 1; break; }
const blankKnife = blankAt ? citeMiss('tools/doctest.mjs', blankAt, null) : '';
ok(bad.length === 0 && !!blankKnife, `D9 文档里的 ${cites.length} 条 path:NN 引用都落在真实文件的行数内、且被指的那几行整段不许是空行（在界内不等于指到了代码；这一格自带一把指向空行的刀）`,
  bad.length ? `越界/不存在/空行：${bad.join('，')}`
    : blankKnife ? `${cites.length ? '全部在范围内' : '文档现在不引行号，只引文件名（那就没什么可漂的）'} · 刀：本闸第 ${blankAt} 行现量是空行，指过去判红「那几行整段是空行」`
      : '本闸自己的文件里现量不出空行靶子 —— 空行那一道没被证明过');

// ---- D10 红线标签双向：文档点名的每条红线都得存在，存在的每条红线都得有人写 ----
const realLabels = [...new Set([...BAL.matchAll(/\b(B\d(?:b)?)(?=[ 　])/g)].map((m) => m[1]))];
const docLabels = [...new Set([...DOCS.matchAll(/`?(B\d(?:b)?)`?(?=[ 　、)）/；;])/g)].map((m) => m[1]))];
ok(realLabels.length >= 6 && docLabels.length >= 6, 'D10a 两边的红线标签都解析到了',
  `balance ${realLabels.sort().join(' ')} · 文档 ${docLabels.sort().join(' ')}`);
const missing = docLabels.filter((l) => !realLabels.includes(l));
const undocumented = realLabels.filter((l) => !docLabels.includes(l));
ok(missing.length === 0, 'D10 文档点名的每条红线在 balance.mjs 里都还在',
  missing.length ? `文档引用了不存在的红线：${missing.join(' ')}` : `${docLabels.sort().join(' ')} 全部存在`);
ok(undocumented.length === 0, 'D10b balance.mjs 里每条红线都被文档点名（新增红线不能没人写）',
  undocumented.length ? `没写进文档：${undocumented.join(' ')}` : '一一对上');
// --dose 的覆盖面也得是现值：文档说剂量了哪几条，脚本里就得有哪几条。
const dosed = [...new Set([...BAL.slice(BAL.indexOf("if (has('--dose'))")).matchAll(/\['(B\d(?:b)?)',/g)].map((m) => m[1]))];
const doseDoc = (README.match(/`--dose` 剂量了 ([^；;]+)/) || [])[1];
const doseList = (doseDoc || '').match(/B\d(?:b)?/g) || [];
ok(dosed.length >= 4 && !!doseDoc && doseList.slice().sort().join(',') === dosed.slice().sort().join(','),
  `D10c 文档写的剂量覆盖面等于 --dose 里的剂量项（${dosed.sort().join(' ')}）`,
  doseDoc ? `文档 ${doseList.join('/')} vs 脚本 ${dosed.join('/')}` : '解析不到那一句');

// ---- D11 「门也在家门口」：verify.sh 现在自己跑三道逻辑闸，那两颗条数钉要有独立证人 ----
// 搬门的代价是新造了一个说谎面：verify.sh 里 `LOGIC_EXPECTS` 那个数是我手抄的，而本闸的项数
// 会跟着我改断言自己长。只写在脚本里的数，除了本闸没人核对——所以钉要被本闸反向核对，漂 1 就红。
const pinBlock = (VERIFY.match(/^LOGIC_EXPECTS="([^"]+)"/m) || [])[1] || '';
const pins = Object.fromEntries(pinBlock.split(/\s+/).filter(Boolean).map((kv) => kv.split(':')));
ok(Object.keys(pins).length === 2 && !!pins.doctest && !!pins.sabotage,
  'D11a verify.sh 里解析到 LOGIC_EXPECTS 那一行，而且正好两颗钉（doctest / sabotage）',
  pinBlock || 'verify.sh 里没有 LOGIC_EXPECTS 那一行');
const knives = (SAB.match(/^\s*\{ id: '(K\d+)'/gm) || []).length;
ok(!!pins.sabotage && +pins.sabotage === knives,
  `D11c verify.sh 钉的刀数等于台架源码里现数的刀数（${knives} 把）`,
  `钉 ${pins.sabotage || '无'} · 现数 ${knives}`);
const gateCalls = VERIFY.split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/^\s*(?:[A-Z][A-Z0-9_]*=\S*\s+)+/, ''))
  .filter((l) => /^(?:node|bash|python3)\s/.test(l));
const runs = (tool) => gateCalls.filter((l) => l.includes('tools/' + tool)).length;
const trio = [['engine-test.mjs', runs('engine-test.mjs')], ['doctest.mjs', runs('doctest.mjs')],
  ['sabotage.mjs', runs('sabotage.mjs')]];
ok(trio.every(([, n]) => n === 1),
  'D11d 三道逻辑闸在 verify.sh 里各有一条真调用（注释里提到路径不算调用）',
  trio.map(([t, n]) => `${t}=${n}`).join(' · '));
// D11b 与 D11e 排在最后：它们要拿本闸的总项数与全部刀的名录对账，上面那三条已经计入 rows。
const finalRows = rows + 2;
ok(!!pins.doctest && +pins.doctest === finalRows,
  `D11b verify.sh 钉的 doctest 项数等于本闸实跑的项数（${finalRows}，含 D11 这五条）`,
  `钉 ${pins.doctest || '无'} · 实跑 ${finalRows}`);
const docKnives = [...new Set([...README.matchAll(/^\| (K\d+) \|/gm)].map((m) => m[1]))];
ok(docKnives.length === knives,
  `D11e README 逐枪表解析到的刀数等于台账源码现数的刀数（${knives} 把）`,
  `文档 ${docKnives.length}（${docKnives.sort().join(' ')}） vs 台架 ${knives}`);

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`rows: ${rows} fail: ${fail.length}`);
if (fail.length) {
  for (const f of fail) console.log(`  未过：${f}`);
  process.exit(1);
}
