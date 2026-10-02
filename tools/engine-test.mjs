// 引擎保证闸：判据 1（穷举计数器）与判据 2（纯铅笔推导）各钉一排断言，
// 每条都有名字，红了要能点名自己死在哪一句。
//
//   node tools/engine-test.mjs          全跑
//   node tools/engine-test.mjs --quick  跳过独立环枚举（A1/A2/C 那几条，最慢的一组）
//
// 关键设计：凡「两条路会师」的断言，两边必须是各自实现的；凡「数出来一个数」的
// 断言，旁边得站着一个能数出别的数的对照（负样本 0、松绑样本 >1、独立枚举）。
import { readFileSync } from 'node:fs';
import {
  makeBoard, emptyState, verify, loopOf, dotStatus, stateFromEdges,
  LOOP, CUT, UNKNOWN, DR, DC, cellIndex, hIndex, vIndex,
} from '../js/engine/rules.js';
import { countSolutions, countSolutionsRowMajor, cyclesByDfs, NODE_CAP } from '../js/engine/count.js';
import { RULE_ORDER, RULE_TEXT, solve } from '../js/engine/pencil.js';
import { makePuzzle, SIZES, toView } from '../js/engine/generate.js';

let fails = 0, checks = 0;
const eq = (name, got, want) => {
  checks++;
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { fails++; console.log(`FAIL ${name}\n       got  ${a}\n       want ${b}`); }
  else console.log(`ok   ${name}`);
};
const asSet = (path) => path.map(([r, c]) => `${r},${c}`).sort().join(' ');

/** Nikoli 官方 5x5 例题（_tmp-midloop-src-nikoli-*.html + 例题 gif 逐格转录） */
const NIKOLI5 = [
  { t: 'v', r: 0, c: 1 }, { t: 'c', r: 1, c: 2 }, { t: 'h', r: 2, c: 0 },
  { t: 'c', r: 2, c: 4 }, { t: 'c', r: 3, c: 2 }, { t: 'c', r: 3, c: 3 },
];
const NIKOLI5_ANSWER = [
  [0, 0], [0, 1], [1, 1], [1, 2], [1, 3], [0, 3], [0, 4], [1, 4], [2, 4], [3, 4],
  [4, 4], [4, 3], [3, 3], [2, 3], [2, 2], [3, 2], [4, 2], [4, 1], [3, 1], [3, 0],
  [2, 0], [1, 0],
];

/**
 * 独立枚举：把 n x n 格图里所有简单环走一遍，再按两种读法各自筛一遍。
 * 这一条不借计数器、不借铅笔，是「中点规则到底是哪一种」的原始裁定。
 */
function weakVsStrong(n, dots) {
  const adj = (v) => {
    const r = (v / n) | 0, c = v % n, out = [];
    if (r > 0) out.push(v - n);
    if (c < n - 1) out.push(v + 1);
    if (r < n - 1) out.push(v + n);
    if (c > 0) out.push(v - 1);
    return out;
  };
  const board = makeBoard(n, dots);
  const st = emptyState(n);
  let weak = 0, strong = 0;
  const path = [], used = new Set();
  const walk = (first, done) => {
    if (done) {
      if (path.length < 4) return;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) st.cell[r * n + c] = CUT;
      for (let i = 0; i < st.H.length; i++) st.H[i] = CUT;
      for (let i = 0; i < st.V.length; i++) st.V[i] = CUT;
      for (let i = 0; i < path.length; i++) {
        const a = path[i], b = path[(i + 1) % path.length];
        st.cell[a] = LOOP;
        const ar = (a / n) | 0, ac = a % n, br = (b / n) | 0, bc = b % n;
        if (br === ar && bc === ac + 1) st.H[ar * (n - 1) + ac] = LOOP;
        else if (br === ar && bc === ac - 1) st.H[ar * (n - 1) + ac - 1] = LOOP;
        else if (bc === ac && br === ar + 1) st.V[ar * n + ac] = LOOP;
        else st.V[(ar - 1) * n + ac] = LOOP;
      }
      const straight = dots.every((d) => {
        // 弱读法：格心点要被直穿，线上点要被横越 —— 都不要求两段臂等长
        if (d.t === 'c') {
          if (st.cell[cellIndex(n, d.r, d.c)] !== LOOP) return false;
          const horiz = edge(st, n, d.r, d.c, 1) && edge(st, n, d.r, d.c, 3);
          const vert = edge(st, n, d.r, d.c, 0) && edge(st, n, d.r, d.c, 2);
          return horiz !== vert;
        }
        return d.t === 'v' ? st.H[hIndex(n, d.r, d.c - 1)] === LOOP : st.V[vIndex(n, d.r - 1, d.c)] === LOOP;
      });
      if (!straight) return;
      weak++;
      if (dots.every((d) => dotStatus(st, d) === 'ok')) strong++;
      return;
    }
    for (const v of adj(first)) {
      if (v <= path[0] || used.has(v)) continue;
      used.add(v); path.push(v);
      walk(v, false);
      path.pop(); used.delete(v);
    }
    if (adj(first).includes(path[0]) && path.length >= 3 && path[1] < path[path.length - 1]) walk(first, true);
  };
  for (let s = 0; s < n * n; s++) { used.clear(); used.add(s); path.length = 0; path.push(s); walk(s, false); }
  return { weak, strong };
}
const edge = (st, n, r, c, d) => {
  if (d === 0) return r > 0 && st.V[(r - 1) * n + c] === LOOP;
  if (d === 1) return c < n - 1 && st.H[r * (n - 1) + c] === LOOP;
  if (d === 2) return r < n - 1 && st.V[r * n + c] === LOOP;
  return c > 0 && st.H[r * (n - 1) + c - 1] === LOOP;
};

console.log('A. 规则裁定：中点 = 最长直线段正中，不是「直穿即可」');
{
  const board = makeBoard(5, NIKOLI5);
  if (!process.argv.includes('--quick')) {
    const w = weakVsStrong(5, NIKOLI5);
    eq('官方 5x5 在弱读法下有 26 个环', w.weak, 26);
    eq('官方 5x5 在强读法下只剩 1 个环', w.strong, 1);
  }
  const pub = stateFromEdges(5, {
    cells: NIKOLI5_ANSWER,
    h: NIKOLI5_ANSWER.flatMap(([r, c], i) => {
      const [nr, nc] = NIKOLI5_ANSWER[(i + 1) % NIKOLI5_ANSWER.length];
      return nr === r && Math.abs(nc - c) === 1 ? [[r, Math.min(c, nc)]] : [];
    }),
    v: NIKOLI5_ANSWER.flatMap(([r, c], i) => {
      const [nr, nc] = NIKOLI5_ANSWER[(i + 1) % NIKOLI5_ANSWER.length];
      return nc === c && Math.abs(nr - r) === 1 ? [[Math.min(r, nr), c]] : [];
    }),
  });
  eq('公布的答案本身合法（verify 无词）', verify(board, pub), []);
  const one = countSolutions(board, NODE_CAP);
  eq('计数器在官方 5x5 上恰好数出 1', [one.count, one.bounded], [1, false]);
  eq('计数器找到的那一环就是公布的答案', asSet(loopOf(board, one.solutions[0])), asSet(NIKOLI5_ANSWER));
  // 破坏试验：把一处臂长改歪，两个判定都得说不是
  const broken = { n: 5, cell: Int8Array.from(pub.cell), H: Int8Array.from(pub.H), V: Int8Array.from(pub.V) };
  broken.H[1 * 4 + 1] = CUT;                                     // (1,1)-(1,2) 断开
  broken.V[1 * 5 + 1] = LOOP;                                    // 从 (1,1) 另开一路
  broken.V[2 * 5 + 1] = LOOP;
  broken.cell[3 * 5 + 1] = LOOP;
  eq('改歪一处之后 verify 必须拒绝', verify(board, broken).length > 0, true);
}

console.log('\nB. 反空转对照：计数器得能数出 0，也能数出多于 1');
{
  eq('角上的格心点无解（它不可能被直穿）',
    countSolutions(makeBoard(5, [{ t: 'c', r: 0, c: 0 }]), NODE_CAP).count, 0);
  const loose = countSolutions(makeBoard(5, NIKOLI5.filter((d) => d.t === 'c')), NODE_CAP);
  eq('只留格心点就不唯一（松绑对照）', [loose.count, loose.bounded], [8, false]);
}

console.log('\nC. 无点盘：两个排序都得等于独立环枚举');
if (!process.argv.includes('--quick')) {
  for (const n of [2, 3, 4, 5]) {
    const want = cyclesByDfs(n);
    eq(`${n}x${n} 无点：mrv=${want} 且 行序=${want}`, [
      countSolutions(makeBoard(n, []), NODE_CAP).count,
      countSolutionsRowMajor(makeBoard(n, []), NODE_CAP).count,
    ], [want, want]);
  }
}

console.log('\nD. Cross+A 10x10 例题（图逐格转录）：真尺寸会师');
{
  const raw = JSON.parse(readFileSync(new URL('./fixtures/crossa-10x10.json', import.meta.url), 'utf8'));
  const kind = { center: 'c', vborder: 'v', hborder: 'h' };
  const dots = raw.dots.map(([k, r, c]) => ({ t: kind[k], r, c }));
  const board = makeBoard(raw.N, dots);
  const pub = stateFromEdges(raw.N, {
    cells: raw.loop.map(([r, c]) => [r, c]),
    h: raw.loop.filter(([, , d]) => d[1]).map(([r, c]) => [r, c]),
    v: raw.loop.filter(([, , d]) => d[2]).map(([r, c]) => [r, c]),
  });
  eq(`${raw.dots.length} 点 / ${raw.loop.length} 格的公布环合法`, verify(board, pub), []);
  for (const [label, counter] of [['mrv', countSolutions], ['行序', countSolutionsRowMajor]]) {
    const r = counter(board, NODE_CAP);
    eq(`${label} 在 10x10 上恰好数出 1 且不越预算`, [r.count, r.bounded, r.nodes < NODE_CAP], [1, false, true]);
    if (r.count === 1) eq(`${label} 的那一环等于公布答案`, asSet(loopOf(board, r.solutions[0])), asSet(raw.loop.map(([a, b]) => [a, b])));
  }
}

console.log('\nE. 铅笔（判据 2）：官方 5x5 从空盘推到底，一次不猜');
{
  const board = makeBoard(5, NIKOLI5);
  const p = solve(board);
  eq('十条命名规则推到全盘定死，无矛盾', [p.pinned, p.conflict, p.unknown], [true, null, 0]);
  eq('推出来的环与计数器/公布答案一致', asSet(loopOf(board, p.state)), asSet(NIKOLI5_ANSWER));
  const fired = [...p.fired.keys()];
  eq('每条落笔都点得出规则名', fired.every((r) => RULE_ORDER.includes(r)), true);
  eq('官方 5x5 上开火的规则条数', fired.length, 9);
}

console.log('\nF. 两个排序在出货盘上逐张对照');
{
  let compared = 0, disagreed = 0, illegal = 0, mrvBounded = 0, rowBounded = 0;
  for (const sizeKey of SIZES) {
    for (let i = 0; i < 4; i++) {
      const p = makePuzzle(`crosscheck|${sizeKey}|${i}`, sizeKey);
      if (!p.ok) continue;
      const board = makeBoard(p.n, p.dots);
      const A = countSolutions(board, NODE_CAP);
      if (A.bounded) { mrvBounded++; continue; }                     // 承诺的那一版，跑不完就是红
      if (A.count !== 1) { disagreed++; continue; }
      for (const s of A.solutions) if (verify(board, { n: p.n, cell: s.cell, H: s.H, V: s.V }).length) illegal++;
      const B = countSolutionsRowMajor(board, NODE_CAP);
      if (B.bounded) { rowBounded++; continue; }                     // 对照跑不完：观测值，不是承诺破了
      compared++;
      if (A.count !== B.count) disagreed++;
    }
  }
  eq('出货用的那一版全部在预算内数完', mrvBounded, 0);
  eq('对照能跑完的盘数（防「一条都没比」的空转）', compared >= 3 * SIZES.length - 2, true);
  eq('解数逐张相同', [disagreed, compared], [0, compared]);
  eq('没有一张盘吐出非法解', illegal, 0);
  console.log(`     对照（行序）跑不完 ${rowBounded} 张 —— 这一版只当对照，菜单成本按出货那一版算`);
}

console.log('\nG. 生成器：出货盘必须唯一、可推、再挖就崩、且同种子同盘');
{
  const firing = new Map();
  let shipped = 0, bad = [];
  for (const sizeKey of SIZES) {
    for (let i = 0; i < 6; i++) {
      const seed = `shipcheck|${sizeKey}|${i}`;
      const p = makePuzzle(seed, sizeKey);
      if (!p.ok) { bad.push(`${sizeKey}#${i} status=${p.status}`); continue; }
      shipped++;
      const board = makeBoard(p.n, p.dots);
      if (verify(board, p.solution).length) bad.push(`${sizeKey}#${i} 答案非法`);
      if (countSolutions(board, NODE_CAP).count !== 1) bad.push(`${sizeKey}#${i} 重数不是 1`);
      if (!p.stats.pencilPinned) bad.push(`${sizeKey}#${i} 铅笔推不满`);
      if (p.droppable !== 0) bad.push(`${sizeKey}#${i} 还能再挖 ${p.droppable} 条线索`);
      if (makePuzzle(seed, sizeKey).fingerprint !== p.fingerprint) bad.push(`${sizeKey}#${i} 同种子换了盘`);
      if (asSet(toView(p).loop.map(([r, c]) => [r, c])) !== asSet(loopOf(board, p.solution))) bad.push(`${sizeKey}#${i} 视图与答案不符`);
      for (const [rule, cnt] of Object.entries(p.stats.firedByRule)) firing.set(rule, (firing.get(rule) || 0) + cnt);
      console.log(`     ${sizeKey}#${i} dots=${p.dotCount}/${p.candidateCount} runs nodes=${p.stats.nodes} rounds=${p.stats.pencilRounds}`);
    }
  }
  eq('出货样本无违规', bad, []);
  eq('出货样本张张落地', shipped, 6 * SIZES.length);
  console.log('     规则开火统计（跨样本）：');
  const missing = [];
  for (const rule of RULE_ORDER) {
    const cnt = firing.get(rule) || 0;
    console.log(`       ${rule} = ${cnt}${cnt ? '' : '   <== 从未开火'}`);
    if (!cnt) missing.push(rule);
  }
  eq('没有装饰性规则（每条都至少开火一次）', missing, []);
}

console.log('\nH. 两套编码的约定对齐');
{
  eq('三态编码两边同值', [UNKNOWN, LOOP, CUT], [0, 1, 2]);
  eq('规则名与文案一一对应', RULE_ORDER.filter((r) => !RULE_TEXT[r]), []);
  eq('方向数组是上右下左', [DR.join(','), DC.join(',')], ['-1,0,1,0', '0,1,0,-1']);
  eq('预算是节点数、不是毫秒', NODE_CAP, 2000000);
}

console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
