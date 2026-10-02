// 成本与承诺闸：每一档尺寸的「出盘率 / 可推率 / 唯一性证完率 / 线索最小性 / 规则开火」
// 都在这里量，菜单档位由这些读数决定，不是由手感决定。
//
//   node tools/balance.mjs                     出货菜单 + 每一条「太贵」的读数，每档 48 张
//   node tools/balance.mjs --quick             每档 8 张，只测菜单内尺寸（快查用）
//   node tools/balance.mjs --ladder 5,6,7,8,9,10   量整条尺寸梯，用来决定谁进菜单
//   node tools/balance.mjs --dose              阴性自证：每条红线都得能为它单独红一次
//   node tools/balance.mjs --ab                两个分支顺序逐张对照
//   SAMPLES=12 ATTEMPTS=6 node tools/balance.mjs   指定张数与每颗种子的候选数
//
// 默认跑法为什么是 48 张 × 3 个候选：TOO_EXPENSIVE 里那几条理由写的就是这个底，
// 而一条写着读数的理由必须能在同一次运行里被重新量出来（见 B5 的「不说谎」那组）。
// --quick 把底降到 8 张，那里就只剩方向可查（越没越线），逐数对账要跑默认或 --ladder。
//
// 红线一句话版本：
//   B1 出盘率  每档 ≥75% 的种子能出一张可出货的盘（撑不起菜单的档不进菜单）
//   B2 零猜测  出货盘 100% 由十条命名规则从空盘推满，且 verify 无词、环是单一闭环
//   B3 证得完  出货盘 100% 在 2,000,000 节点预算内被穷举计数器数出恰好 1 解，
//              而且换一种分支顺序再数一遍还是 1（不信生成器自己报的那个数）
//   B4 不浪费  出货盘的线索再摘一条就推不满（droppable === 0）
//   B5 尺寸线  菜单档内 0 次「越预算候选」；越线的档位不进菜单，且必须在
//              TOO_EXPENSIVE 里带着它自己的实测读数，不许说谎
//   B6 无装饰  每条命名规则在样本里至少开火一次；毫秒只观测，不参与判定
import { makeBoard, verify, loopOf } from '../js/engine/rules.js';
import { countSolutions, countSolutionsRowMajor, NODE_CAP } from '../js/engine/count.js';
import { RULE_ORDER, solve } from '../js/engine/pencil.js';
import { makePuzzle, SIZES, TOO_EXPENSIVE, parseSize } from '../js/engine/generate.js';
import { DOTS as NIKOLI5 } from './fixtures/nikoli-5x5.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
// 尺寸可以写成 5 或 5x5，两种都吃进
const toN = (s) => (/^\d+$/.test(String(s).trim()) ? Number(s) : parseSize(s));
const LADDER = has('--ladder');
// 默认测「菜单里的档 + 被写成太贵的档」：后者不测就没法知道那条理由是不是还在说谎。
const DEFAULT_PROBED = [...SIZES.map(parseSize), ...TOO_EXPENSIVE.map((e) => parseSize(e.key))];
const PROBED = [...new Set(LADDER ? String(val('--ladder', DEFAULT_PROBED.join(','))).split(',').map(toN) : DEFAULT_PROBED)]
  .sort((a, b) => a - b);
const SAMPLES = Number(process.env.SAMPLES || (has('--quick') ? 8 : 48));
const ATTEMPTS = Number(process.env.ATTEMPTS || (LADDER ? 4 : 3));
const SHIP = new Set(SIZES.map(parseSize));

const pad = (s, w) => String(s).padEnd(w);
const num = (v, w) => String(v).padStart(w);
const frac = (a, b) => `${a}/${b}`;
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
};
// B4 咬的那个数在这里自己算一遍，不转抄生成器报的 stats：dig 少摘一条、或者把「摘得动」的
// 盘当出货盘交出来，只有重数能看见（阳性对照见 --dose 的 B4：官方 Nikoli 5x5 就摘得动一条）。
const droppableOf = (n, dots) =>
  dots.filter((d) => solve(makeBoard(n, dots.filter((x) => x !== d))).pinned).length;

const lines = [], red = [];
const report = (name, ok, detail) => {
  lines.push(`${ok ? 'ok  ' : 'RED '} ${name}  ${detail}`);
  if (!ok) red.push(name);
};

const tiers = new Map();
for (const n of PROBED) {
  tiers.set(n, { shipped: 0, status: {}, attempts: { unpinnable: 0, overBudget: 0, notUnique: 0, illegal: 0 },
    totalAttempts: 0, nodes: [], genMs: [], dots: [], cand: [], droppableBad: 0, droppableLied: 0,
    notPinned: 0, illegalSol: 0,
    recountBad: 0, abCompared: 0, abDisagree: 0, abSkipped: 0, firing: new Map() });
}

console.log(`每档 ${SAMPLES} 张 × 每颗种子至多 ${ATTEMPTS} 个候选，预算 ${NODE_CAP} 节点，尺寸 ${PROBED.join('/')}`);
for (const n of PROBED) {
  const sizeKey = `${n}x${n}`;
  const t = tiers.get(n);
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    const p = makePuzzle(`balance|${sizeKey}|${i}`, sizeKey, { attempts: ATTEMPTS });
    t.genMs.push(Date.now() - t0);
    for (const [k, v] of Object.entries(p.tried || {})) if (k in t.attempts) t.attempts[k] += v;
    if (!p.ok) { t.status[p.status] = (t.status[p.status] || 0) + 1; continue; }
    t.shipped++;
    t.totalAttempts += p.stats.attempts;
    t.nodes.push(p.stats.nodes);
    t.dots.push(p.dotCount); t.cand.push(p.candidateCount);
    if (!p.stats.pencilPinned) t.notPinned++;
    const board = makeBoard(p.n, p.dots);
    if (verify(board, p.solution).length || !loopOf(board, p.solution)) t.illegalSol++;
    if (SHIP.has(n)) {
      // B4 不读生成器自报的 droppable：拿同一句承诺自己重数一遍，再和它报的对账
      const dropFresh = droppableOf(p.n, p.dots);
      if (dropFresh !== 0) t.droppableBad++;
      if (dropFresh !== p.droppable) t.droppableLied++;
      // B3 的复数不采信生成器自己报的那个数：从线索集合重新数一遍
      const fresh = countSolutions(board, NODE_CAP);
      if (fresh.bounded || fresh.count !== 1) t.recountBad++;
      // 对照（另一种分支顺序）能跑完多少就跑多少；跑不完不是承诺破了，
      // 但可比张数必须有下限，否则这条对照就是空转
      const other = countSolutionsRowMajor(board, NODE_CAP);
      if (other.bounded) t.abSkipped++;
      else { t.abCompared++; if (other.count !== fresh.count) t.abDisagree++; }
    }
    for (const [rule, cnt] of Object.entries(p.stats.firedByRule)) if (cnt) t.firing.set(rule, (t.firing.get(rule) || 0) + cnt);
  }
}

console.log(`\n档位读数（nodes 与「越预算候选数」是判据；ms 只是观测，不参与判定）`);
console.log(`  ${pad('size', 6)}${num('出货', 6)}${num('med节点', 10)}${num('p95节点', 10)}${num('max节点', 10)}${num('越预算', 8)}${num('med ms', 9)}${num('p95 ms', 9)}${num('med点', 7)}`);
for (const n of PROBED) {
  const t = tiers.get(n);
  const tried = Object.entries(t.status).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  console.log(`  ${pad(`${n}x${n}`, 6)}${num(frac(t.shipped, SAMPLES), 6)}${num(quantile(t.nodes, 0.5), 10)}${num(quantile(t.nodes, 0.95), 10)}`
    + `${num(t.nodes.length ? Math.max(...t.nodes) : 0, 10)}${num(t.attempts.overBudget, 8)}${num(quantile(t.genMs, 0.5), 9)}${num(quantile(t.genMs, 0.95), 9)}${num(quantile(t.dots, 0.5), 7)}`
    + `   弃盘: ${tried}`);
}

for (const n of PROBED) {
  if (!SHIP.has(n)) continue;
  const t = tiers.get(n);
  report(`B1 出盘率 ${n}x${n}`, t.shipped >= Math.ceil(SAMPLES * 0.75), `${frac(t.shipped, SAMPLES)} 张出货，候选共 ${t.totalAttempts} 个`);
  report(`B2 铅笔零猜测推满 ${n}x${n}`, t.notPinned === 0, `推不满 ${frac(t.notPinned, t.shipped)}`);
  report(`B2 答案合法 ${n}x${n}`, t.illegalSol === 0, `verify 有词或非单环 ${frac(t.illegalSol, t.shipped)}`);
  report(`B3 计数器复数恰好 1 ${n}x${n}`, t.recountBad === 0,
    `从线索集合重数：不符或越预算 ${frac(t.recountBad, t.shipped)}`);
  report(`B3b 两排序对照可比且同解 ${n}x${n}`,
    t.abDisagree === 0 && t.abCompared >= Math.ceil(t.shipped / 2),
    `可比 ${frac(t.abCompared, t.shipped)}（对照跑不完 ${t.abSkipped} 张），解数不符 ${t.abDisagree} 张`);
  report(`B4 线索最小 ${n}x${n}`, t.droppableBad === 0, `自己重数：还能再摘 ${frac(t.droppableBad, t.shipped)} 张`);
  report(`B5 档内无越预算候选 ${n}x${n}`, t.attempts.overBudget === 0,
    `越预算候选 ${t.attempts.overBudget} 个 / 共 ${t.totalAttempts} 个候选`);
}

{
  // B4 有两个方向的谎要防：出货盘其实摘得动一条（上面那条按档红），以及生成器自己报的数
  // 与重数不符（这一条）。后者只在两边都被算出来的时候才有意义，所以分母跟着 SHIP 走。
  const ship = PROBED.filter((n) => SHIP.has(n));
  const shipped = ship.reduce((s, n) => s + tiers.get(n).shipped, 0);
  const lied = ship.reduce((s, n) => s + tiers.get(n).droppableLied, 0);
  report('B4 复算与生成器自报的条数同意', lied === 0,
    `重数与 p.droppable 不符 ${frac(lied, shipped)} 张（生成器说摘不动而重数说摘得动＝它在自己那份账上说谎）`);
}

{
  const expensive = PROBED.filter((n) => tiers.get(n).attempts.overBudget > 0);
  const missing = expensive.filter((n) => !TOO_EXPENSIVE.some((e) => parseSize(e.key) === n));
  report('B5 越线的档位都被 TOO_EXPENSIVE 点名', missing.length === 0,
    `本次越线 = ${expensive.map((n) => `${n}x${n}`).join(',') || '无'}；未点名 = ${missing.map((n) => `${n}x${n}`).join(',') || '无'}`);
  const reasonless = TOO_EXPENSIVE.filter((e) => !/\d/.test(e.reason || ''));
  report('B5 每条理由都带着读数', reasonless.length === 0, `没有数字的理由 = ${reasonless.map((e) => e.key).join(',') || '无'}`);
  const unprobed = TOO_EXPENSIVE.filter((e) => !PROBED.includes(parseSize(e.key)));
  report('B5 每一条「太贵」本次都被重测', unprobed.length === 0,
    `本次没测到的档 = ${unprobed.map((e) => e.key).join(',') || '无'}（默认跑法会把菜单档与太贵档一起测）`);
  // 一条写着读数的理由，只有在**同一个底**上再量一次才谈得上逐数对账。底不同就不许它伪装成通过：
  // 窄底（--quick 的 8 张）只发一条 NOTE，不产出行；宽底只查方向（越线只许多不许少、最大只许大不许小）。
  for (const e of TOO_EXPENSIVE) {
    const n = parseSize(e.key);
    const t = tiers.get(n);
    if (!t) continue; // 上面那条「本次都被重测」已经为它红过了
    const maxNodes = t.nodes.length ? Math.max(...t.nodes) : -1;
    if (SAMPLES < e.samples || ATTEMPTS < e.attempts) {
      console.log(`NOTE B5 ${e.key} 的理由写的是 ${e.samples} 颗种子 × ${e.attempts} 个候选的底，本次是 ${SAMPLES} × ${ATTEMPTS} —— 本次不逐数复测（默认跑法会）`);
      continue;
    }
    if (SAMPLES > e.samples || ATTEMPTS > e.attempts) {
      report(`B5 ${e.key} 在更宽的底上不许把越线洗白`, t.attempts.overBudget >= e.over && maxNodes >= e.maxNodes,
        `本次（${SAMPLES}×${ATTEMPTS}）越预算候选=${t.attempts.overBudget} 出货最大=${maxNodes}；理由（${e.samples}×${e.attempts}）= ${e.over} / ${e.maxNodes}。种子是 balance|档|序号，宽底包含窄底，所以这两个数只许变大`);
      continue;
    }
    report(`B5 TOO_EXPENSIVE 不说谎 ${e.key}`, t.attempts.overBudget > 0,
      `本次越预算候选 = ${t.attempts.overBudget}（理由写的 ${e.over}）；已不越线却还挂在菜单外 = 说谎`);
    report(`B5 理由里的读数与本次一致 ${e.key}`,
      t.attempts.overBudget === e.over && maxNodes === e.maxNodes,
      `本次 越预算=${t.attempts.overBudget} 出货最大=${maxNodes}；理由 越预算=${e.over} 出货最大=${e.maxNodes}（底 ${SAMPLES}×${ATTEMPTS}）`);
    // 句子是字段拼出来的，那这句子里的数就必须还是那几个字段：手改句子不改字段，在这里红。
    const inReason = (e.reason.match(/\d[\d,]*/g) || []).map((s) => Number(s.replace(/,/g, '')));
    report(`B5 理由句子与它自己的字段同一批数 ${e.key}`,
      inReason.includes(e.samples) && inReason.includes(e.over) && inReason.includes(e.maxNodes) && inReason.includes(NODE_CAP),
      `句子里的数 = ${inReason.join(',')}；字段 = ${e.samples},${e.over},${e.maxNodes},${NODE_CAP}`);
  }
}

{
  const fired = new Map();
  for (const n of PROBED) for (const [r, c] of tiers.get(n).firing) fired.set(r, (fired.get(r) || 0) + c);
  const missing = RULE_ORDER.filter((r) => !fired.get(r));
  report('B6 无装饰性规则', missing.length === 0,
    `开火 ${RULE_ORDER.map((r) => `${r}=${fired.get(r) || 0}`).join(' ')}；从未开火 = ${missing.join(',') || '无'}`);
  const rogue = [...fired.keys()].filter((r) => !RULE_ORDER.includes(r));
  report('B6 开火名字都在规则表里', rogue.length === 0, rogue.join(',') || '全部对上');
}

for (const line of lines) console.log(line);

if (has('--dose')) {
  console.log('\n阴性自证：名单里的每条红线都得能被单独打破，打不中就是闸坏了（报 ERROR，不静默补一句）');
  console.log('名单外：B1 出盘率没有剂量项（它要的是"种子换一批就出不了盘"，不是能构造的盘），README「不承诺」写着这条');
  const one = (sizeKey) => makePuzzle(`dose|${sizeKey}`, sizeKey, { attempts: 8 });
  const doses = [
    ['B3', () => {
      const p = one(SIZES[0]);
      if (!p.ok) return { hit: false, note: `出不了盘 ${p.status}` };
      const loose = makeBoard(p.n, p.dots.slice(0, Math.max(1, p.dots.length - 2)));
      const c = countSolutions(loose, NODE_CAP);
      return { hit: c.count !== 1 || c.bounded, note: `摘掉两条线索后 count=${c.count} bounded=${c.bounded}` };
    }],
    ['B2', () => {
      const p = one(SIZES[SIZES.length - 1]);
      if (!p.ok) return { hit: false, note: `出不了盘 ${p.status}` };
      const thin = makeBoard(p.n, p.dots.filter((d) => d.t === 'c').slice(0, 2));
      const s = solve(thin), c = countSolutions(thin, NODE_CAP);
      return { hit: !s.pinned && c.count > 0, note: `只留两点：pinned=${s.pinned} unknown=${s.unknown}，可仍有 ${c.count} 个解` };
    }],
    ['B3b', () => {
      // B3b 有两条腿：解数要同、可比张数要有下限。后者才是"这条红线会不会空转"的那条腿——
      // 对照跑不完，红线就退化成只有生成器自己说话。剂量：把对照的预算压到 1 个节点。
      const p = one(SIZES[SIZES.length - 1]);
      if (!p.ok) return { hit: false, note: `出不了盘 ${p.status}` };
      const other = countSolutionsRowMajor(makeBoard(p.n, p.dots), 1);
      const compared = other.bounded ? 0 : 1;
      const floor = Math.ceil(1 / 2);
      return { hit: compared < floor,
        note: `对照预算压到 1 个节点之后 bounded=${other.bounded}，可比 ${compared}/1 张，下限 ${floor} ⇒ 「可比张数」这条腿会红（它红了就说明下限真的在守东西）` };
    }],
    ['B4', () => {
      // B4 说的是「出货盘的线索一条都摘不动」。先拿一张真盘证明这个数不是恒 0：
      // Nikoli 官方 5×5 的 6 条线索里就有一条摘掉仍可推满（夹具那一份，engine-test 读的是同一个文件）。
      const drop = droppableOf(5, NIKOLI5);
      return { hit: drop > 0,
        note: `官方 Nikoli 5x5 的 ${NIKOLI5.length} 条里还能再摘 ${drop} 条 ⇒ 「一条都摘不动」是可以红的，不是恒真` };
    }],
    ['B5', () => {
      const p = one(SIZES[SIZES.length - 1]);
      if (!p.ok) return { hit: false, note: `出不了盘 ${p.status}` };
      const c = countSolutions(makeBoard(p.n, p.dots), 50);
      return { hit: c.bounded, note: `cap=50 时 bounded=${c.bounded} nodes=${c.nodes}` };
    }],
    ['B6', () => {
      const p = one(SIZES[0]);
      if (!p.ok) return { hit: false, note: `出不了盘 ${p.status}` };
      const missing = RULE_ORDER.filter((r) => !p.stats.firedByRule[r]);
      return { hit: missing.length > 0, note: `单张 ${SIZES[0]} 就撑不起全部规则：未开火 ${missing.join(',')}` };
    }],
  ];
  let missed = 0;
  for (const [name, fn] of doses) {
    let out;
    try { out = fn(); } catch (e) { out = { hit: false, note: 'threw ' + e.message }; }
    if (!out.hit) { missed++; console.log(`ERROR 剂量 ${name} 没打中：${out.note}`); }
    else console.log(`ok   剂量 ${name} 打中：${out.note}`);
  }
  console.log(missed ? `${missed} 条红线自证失败（闸本身坏了）`
    : `名单里的 ${doses.length} 条红线都能被单独打破（B1 出盘率不在名单里）`);
  if (missed) red.push(...Array.from({ length: missed }, (_, i) => `DOSE#${i}`));
}

if (has('--ab')) {
  console.log('\n两个分支顺序逐张对照（出货用 mrv，行序是独立对照）');
  let compared = 0, disagreed = 0, mrvCheaper = 0, rowCheaper = 0, mrvSum = 0, rowSum = 0, skipped = 0;
  for (const sizeKey of SIZES) {
    for (let i = 0; i < Math.min(6, SAMPLES); i++) {
      const p = makePuzzle(`ab|${sizeKey}|${i}`, sizeKey, { attempts: ATTEMPTS });
      if (!p.ok) continue;
      const board = makeBoard(p.n, p.dots);
      const A = countSolutions(board, NODE_CAP);
      const B = countSolutionsRowMajor(board, NODE_CAP);
      if (A.bounded || B.bounded) { skipped++; continue; }
      compared++;
      if (A.count !== B.count) disagreed++;
      mrvSum += A.nodes; rowSum += B.nodes;
      if (A.nodes < B.nodes) mrvCheaper++; else if (B.nodes < A.nodes) rowCheaper++;
    }
  }
  console.log(`  比了 ${compared} 张（${skipped} 张因某一边越预算而未比）：解数不同 ${disagreed} 张；`
    + `节点合计 行序=${rowSum} mrv=${mrvSum}；mrv 更省 ${mrvCheaper} 张，行序更省 ${rowCheaper} 张`);
  report('AB 两排序逐张同解', disagreed === 0, `${disagreed}/${compared} 张不一致`);
  for (const line of lines.slice(-1)) console.log(line);
}

console.log(red.length ? `\n${red.length} 条红线红：${red.join(' | ')}` : `\n全部红线绿（${lines.length} 条）`);
process.exit(red.length ? 1 : 0);
