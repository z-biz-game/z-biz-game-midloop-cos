// 出题：长一条环 → 按「铅笔还能不能推到底」挖线索 → 最后交给穷举计数器证唯一。
//
// 挖线索而不是按解数挖：唯一性的代价只付一次（结尾那一遍计数），而不是每挖一条
// 线索就在搜索里付一次。反过来说，一张盘的难度来自「哪些直线段开口说话」——
// 一段最长直线只允许一个合法的中点位置（奇数格落在正中场格心，偶数格落在正中
// 那条格线上），所以候选点恰好等于直线段数，挖线索就是决定哪几段说话。
//
// 出货前必须用计数器那张覆盖回棋盘：grow 出来的环在补/挖线索之后可能已经不是
// 任何解了（这是本仓踩过一次的坑，README「测试过程」节记着）。
import {
  makeBoard, cellIndex, verify, loopOf, stateFromEdges,
  LOOP, hIndex, vIndex,
} from './rules.js';
import { countSolutions, NODE_CAP } from './count.js';
import { solve } from './pencil.js';
import { rngFor, shuffle } from './rng.js';

/**
 * 菜单档位由实测成本决定；越线的档位不进菜单，理由印在选择页上。
 *
 * 下面每一个数都是从 `node tools/balance.mjs` 的默认跑法（48 颗种子 × 每颗至多 3 个候选，
 * 预算 NODE_CAP）里量出来的，不是手感：`samples/over/maxNodes` 三个数一起写，是因为
 * B5 要把它们和本次跑出来的读数逐个对账（对不上就红，见 tools/balance.mjs 的「不说谎」那组）。
 * 一条只写了句漂亮话、没有读数支撑的理由是不许存在的，所以这里由字段拼出句子，
 * 而闸再检查句子与字段是不是同一批数。
 *
 * 8x8 留在菜单里：B5 要求菜单内每一档在本次抽样里 0 个「越预算候选」，这条线红了它就是证据。
 * 9x9 / 10x10 请出菜单：越线的候选被生成器当场弃掉，所以「玩家拿到的一定是数得完的盘」
 * 仍然成立，但这一档的成本分布已经不允许它作为一个**承诺**卖出去（线一个不挪）。
 * 这一档的最大节点数只活在 balance 的档位读数表里，不在这里抄一遍——抄了就要靠下一次复跑来推翻，
 * 而下面那两条理由里的数是 B5 逐数对账的，抄得住。
 */
function tooExpensive(key, samples, attempts, over, maxNodes) {
  // 千分位自己拼，不用 toLocaleString：那句话要印在玩家的选择页上，也要被闸逐字符对账，
  // 而 ICU 的分组规则随环境变（一个 locale 的差异就能让闸在别人机器上红）。
  const grp = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    key, samples, attempts, over, maxNodes,
    reason: `${samples} 颗种子 × 每颗至多 ${attempts} 个候选的抽样里 ${over} 个候选在 ${grp(NODE_CAP)} 节点内证不完`
      + `（该档出货盘最大 ${grp(maxNodes)} 节点）`,
  };
}

export const SIZES = ['5x5', '6x6', '7x7', '8x8'];
export const TOO_EXPENSIVE = [
  tooExpensive('9x9', 48, 3, 1, 1020156),
  tooExpensive('10x10', 48, 3, 3, 645560),
];

export const parseSize = (key) => {
  const m = /^(\d+)x(\d+)$/.exec(String(key));
  if (!m) throw new Error('尺寸形如 6x6: ' + key);
  const n = Number(m[1]);
  if (n !== Number(m[2])) throw new Error('Mid-loop 只用正方盘: ' + key);
  return n;
};

/** 2x2 起环，靠 bump 把环推开：一条已用的边整体横移一行/一列，跨过两格新地 */
function bumpTargets(n, on) {
  const out = [];
  const free = (r, c) => r >= 0 && r < n && c >= 0 && c < n && !on.cells.has(cellIndex(n, r, c));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n - 1; c++) {
      if (!on.h.has(r + ',' + c)) continue;
      if (free(r - 1, c) && free(r - 1, c + 1)) out.push(['h', r, c, -1]);
      if (free(r + 1, c) && free(r + 1, c + 1)) out.push(['h', r, c, 1]);
    }
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n; c++) {
      if (!on.v.has(r + ',' + c)) continue;
      if (free(r, c - 1) && free(r + 1, c - 1)) out.push(['v', r, c, -1]);
      if (free(r, c + 1) && free(r + 1, c + 1)) out.push(['v', r, c, 1]);
    }
  }
  return out;
}

/** 环的原始表示：三个集合，构造过程中只增删，最后一次性铺成状态 */
function growLoop(n, rng, { minBumps = 6, maxBumps = 400 } = {}) {
  const cells = new Set(), h = new Set(), v = new Set();
  const addCell = (r, c) => cells.add(cellIndex(n, r, c));
  const r0 = Math.floor(rng() * (n - 1)), c0 = Math.floor(rng() * (n - 1));
  for (const [r, c] of [[r0, c0], [r0, c0 + 1], [r0 + 1, c0], [r0 + 1, c0 + 1]]) addCell(r, c);
  h.add(r0 + ',' + c0); h.add((r0 + 1) + ',' + c0);
  v.add(r0 + ',' + c0); v.add(r0 + ',' + (c0 + 1));

  let bumps = 0;
  for (; ;) {
    const moves = bumpTargets(n, { cells, h, v });
    if (!moves.length) break;
    if (bumps >= minBumps && (bumps >= maxBumps || rng() < 0.12)) break;
    const [axis, r, c, side] = moves[Math.floor(rng() * moves.length)];
    // 把一条横边整体搬到相邻那一行：旧的那两格各失去这条横边、各得到一条竖边，
    // 度数不动，环仍然是单一闭环；新的两格必须都是生地
    if (axis === 'h') {
      h.delete(r + ',' + c);
      const nr = r + side;
      for (const cc of [c, c + 1]) {
        addCell(r, cc); addCell(nr, cc);
        v.add(Math.min(r, nr) + ',' + cc);
      }
      h.add(nr + ',' + c);
    } else {
      v.delete(r + ',' + c);
      const nc = c + side;
      for (const rr of [r, r + 1]) {
        addCell(rr, c); addCell(rr, nc);
        h.add(rr + ',' + Math.min(c, nc));
      }
      v.add(r + ',' + nc);
    }
    bumps++;
  }
  return { cells: [...cells], h: [...h], v: [...v] };
}

function loopState(n, loop) {
  const st = stateFromEdges(n, {
    cells: loop.cells.map((k) => [((k / n) | 0), k % n]),
    h: loop.h.map((s) => s.split(',').map(Number)),
    v: loop.v.map((s) => s.split(',').map(Number)),
  });
  return st;
}

/** 环上连续的直线段：每段只容得下一个合法中点 */
export function runsOf(n, st) {
  const runs = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n - 1) {
      if (st.H[hIndex(n, r, c)] !== LOOP) { c++; continue; }
      let k = c;
      while (k < n - 1 && st.H[hIndex(n, r, k)] === LOOP) k++;
      runs.push({ axis: 'h', r, from: c, to: k, len: k - c + 1 });
      c = k + 1;
    }
  }
  for (let c = 0; c < n; c++) {
    let r = 0;
    while (r < n - 1) {
      if (st.V[vIndex(n, r, c)] !== LOOP) { r++; continue; }
      let k = r;
      while (k < n - 1 && st.V[vIndex(n, k, c)] === LOOP) k++;
      runs.push({ axis: 'v', c, from: r, to: k, len: k - r + 1 });
      r = k + 1;
    }
  }
  return runs;
}

export const dotForRun = (run) => (run.axis === 'h'
  ? (run.len % 2 ? { t: 'c', r: run.r, c: run.from + (run.len - 1) / 2 } : { t: 'v', r: run.r, c: run.from + run.len / 2 })
  : (run.len % 2 ? { t: 'c', r: run.from + (run.len - 1) / 2, c: run.c } : { t: 'h', r: run.from + run.len / 2, c: run.c }));

const sameDot = (a, b) => a.t === b.t && a.r === b.r && a.c === b.c;
/** 只用铅笔：这一组线索能不能把整盘推到底 */
const pinnable = (n, dots) => solve(makeBoard(n, dots)).pinned;

/** 随机顺序往下摘线索，摘到铅笔推不动为止；droppable 是事后再查一遍的「还能再摘」条数 */
function dig(n, cands, rng) {
  if (!pinnable(n, cands)) return null;
  let dots = cands.slice();
  for (const drop of shuffle(cands, rng)) {
    const trial = dots.filter((d) => !sameDot(d, drop));
    if (pinnable(n, trial)) dots = trial;
  }
  const droppable = dots.filter((d) => pinnable(n, dots.filter((x) => !sameDot(x, d)))).length;
  return { dots, droppable };
}

/**
 * @returns {ok, status, seed, sizeKey, n, dots, solution, loopLength, stats}
 *   status: 'ok' | 'no-loop' | 'unpinnable' | 'over-budget' | 'not-unique' | 'illegal-solution'
 */
export function makePuzzle(seed, sizeKey = '6x6', opts = {}) {
  const n = parseSize(sizeKey);
  const attempts = opts.attempts || 12;
  const rng = rngFor(seed);
  const tried = { unpinnable: 0, overBudget: 0, notUnique: 0, illegal: 0 };
  let lastUnknown = null;

  for (let a = 0; a < attempts; a++) {
    const loop = growLoop(n, rng);
    if (loop.cells.length < 4) continue;
    const st = loopState(n, loop);
    const runs = runsOf(n, st);
    const cands = runs.map(dotForRun);
    if (!cands.length) continue;
    if (!pinnable(n, cands)) { tried.unpinnable++; lastUnknown = solve(makeBoard(n, cands)).unknown; continue; }

    const dug = dig(n, cands, rng);
    if (!dug) { tried.unpinnable++; continue; }

    const board = makeBoard(n, dug.dots);
    const counted = countSolutions(board, opts.cap || NODE_CAP);
    if (counted.bounded) { tried.overBudget++; continue; }
    if (counted.count !== 1) { tried.notUnique++; continue; }

    // 答案以计数器那张为准，不以 grow 出来那张为准
    const sol = counted.solutions[0];
    const state = { n, cell: Int8Array.from(sol.cell), H: Int8Array.from(sol.H), V: Int8Array.from(sol.V) };
    const reasons = verify(board, state);
    if (reasons.length) { tried.illegal++; continue; }
    const order = loopOf(board, state);
    const pencil = solve(board);
    const fired = new Map();
    for (const pin of pencil.pins) fired.set(pin.rule, (fired.get(pin.rule) || 0) + 1);

    return {
      ok: true, status: 'ok', seed: String(seed), sizeKey, n,
      dots: dug.dots, dotCount: dug.dots.length, candidateCount: cands.length,
      droppable: dug.droppable, loopLength: order.length, solution: state,
      fingerprint: fingerprint(n, dug.dots),
      stats: {
        attempts: a + 1, runs: runs.length, nodes: counted.nodes,
        pencilRounds: pencil.rounds, pencilPins: pencil.pins.length, pencilPinned: pencil.pinned,
        grownLoop: loop.cells.length, firedRules: [...fired.keys()], firedByRule: Object.fromEntries(fired),
        tried,
      },
    };
  }
  return {
    ok: false, status: tried.overBudget ? 'over-budget' : tried.notUnique ? 'not-unique'
      : tried.illegal ? 'illegal-solution' : 'unpinnable',
    seed: String(seed), sizeKey, n, attempts, tried, unknownAfterFullClues: lastUnknown,
  };
}

/** 线索集合的稳定指纹：存档靠它认出「同一局」 */
export function fingerprint(n, dots) {
  const key = (d) => `${d.t}${d.r},${d.c}`;
  return `${n}|${dots.map(key).sort().join(';')}`;
}

/** 渲染层要的纯数据（不含 TypedArray） */
export function toView(p) {
  const loop = [];
  for (let k = 0; k < p.n * p.n; k++) if (p.solution.cell[k] === LOOP) loop.push([((k / p.n) | 0), k % p.n]);
  const h = [], v = [];
  for (let i = 0; i < p.solution.H.length; i++) if (p.solution.H[i] === LOOP) h.push(i);
  for (let i = 0; i < p.solution.V.length; i++) if (p.solution.V[i] === LOOP) v.push(i);
  return { n: p.n, dots: p.dots, sizeKey: p.sizeKey, seed: p.seed, loop, h, v, fingerprint: p.fingerprint };
}

export { NODE_CAP };
