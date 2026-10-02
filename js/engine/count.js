// 不含任何推理规则的逐格穷举计数器：判据 1 用它证「唯一解」。
//
// 同一套约束、两种分支顺序，彼此互为独立对照：
//   countSolutionsRowMajor —— 按行扫，每格只分叉 E/S（N/W 早已定死）。单节点便宜，
//     但树深：同一批盘上中位 7,366 节点（7x7），最长 2,000,001 撞预算。
//   countSolutions —— 每次挑「剩余合法写法最少」的格下叉（MRV + 前沿优先）。单节点
//     贵一个量级，树却小两个量级：同一批盘 7x7 中位 110 节点，且 118/118 张都在预算内数完。
// 两者在 138 张两边都跑完的盘上解数完全相同，也没有吐出过一个非法解
// （tools/engine-test.mjs 每次都重跑这场对照，还拿独立枚举的 2..5 阶环数钉住底数）。
//
// 预算按节点数算，不按毫秒：节点数是整数逻辑，换机器换浏览器不会换盘；时间会。
import {
  emptyState, edgeRef, edgeAt, cellIndex, dotCells, dotStatus,
  hIndex, vIndex, UNKNOWN, LOOP, CUT, DR, DC,
} from './rules.js';

export const NODE_CAP = 2000000;

/** 独立的环数枚举：把 n x n 格图里所有简单环数一遍，不用任何 Mid-loop 知识 */
export function cyclesByDfs(n) {
  const id = (r, c) => r * n + c;
  const adj = Array.from({ length: n * n }, (_, v) => {
    const r = (v / n) | 0, c = v % n, out = [];
    if (r > 0) out.push(id(r - 1, c));
    if (c < n - 1) out.push(id(r, c + 1));
    if (r < n - 1) out.push(id(r + 1, c));
    if (c > 0) out.push(id(r, c - 1));
    return out;
  });
  let total = 0;
  const used = new Set(), path = [];
  for (let s = 0; s < n * n; s++) {
    used.clear(); used.add(s); path.length = 0; path.push(s);
    const rec = (first) => {
      for (const v of adj[first]) {
        if (v <= s || used.has(v)) continue;
        used.add(v); path.push(v);
        rec(v);
        path.pop(); used.delete(v);
      }
      if (path.length >= 4 && adj[first].includes(s) && path[1] < path[path.length - 1]) total++;
    };
    rec(s);
  }
  return total;
}

/** @returns {{count:number, solutions:Array, nodes:number, bounded:boolean, ms:number}} */
export function countSolutions(board, cap = NODE_CAP) {
  const { n, dots } = board;
  const st = emptyState(n);
  const assigned = new Uint8Array(n * n);
  const parent = new Int16Array(n * n);
  const onSize = new Int16Array(n * n);
  for (let i = 0; i < n * n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };

  const centre = new Set(dots.filter((d) => d.t === 'c').map((d) => cellIndex(n, d.r, d.c)));
  const dotsInRow = new Map(), dotsInCol = new Map();
  const pushDot = (map, k, i) => { if (!map.has(k)) map.set(k, []); map.get(k).push(i); };
  dots.forEach((d, i) => { pushDot(dotsInRow, d.r, i); pushDot(dotsInCol, d.c, i); });

  const dirsOf = (k) => {
    const r = (k / n) | 0, c = k % n, out = [];
    for (let d = 0; d < 4; d++) {
      const ref = edgeRef(n, r, c, d);
      if (ref !== null) out.push({ d, kind: ref[0], idx: ref[1], nb: cellIndex(n, r + DR[d], c + DC[d]) });
    }
    return out;
  };

  const log = [];
  let nodes = 0, stopped = false, onCount = 0;
  const solutions = [];

  const undo = (base) => {
    while (log.length > base) {
      const t = log.pop();
      if (t[0] === 'U') { parent[t[1]] = t[1]; onSize[t[2]] = t[3]; }
      else if (t[0] === 'O') onSize[t[1]] = t[2];
      else st[t[0]][t[1]] = UNKNOWN;
    }
  };

  /** 把格 k 补完的所有合法写法：度数 0 或 2，点不许破，环已闭就不许再开新线 */
  function options(k, closed) {
    const dirs = dirsOf(k);
    const fixedOn = dirs.filter((e) => st[e.kind][e.idx] === LOOP);
    const free = dirs.filter((e) => st[e.kind][e.idx] === UNKNOWN);
    const out = [];
    for (let mask = 0; mask < 1 << free.length; mask++) {
      const chosen = free.filter((_, i) => mask & (1 << i));
      const on = fixedOn.length + chosen.length;
      if (on !== 0 && on !== 2) continue;
      if (closed && chosen.length) continue;
      if (centre.has(k)) {
        const ds = new Set([...fixedOn, ...chosen].map((e) => e.d));
        if (!(ds.size === 2 && ((ds.has(0) && ds.has(2)) || (ds.has(1) && ds.has(3))))) continue;
      }
      const base = log.length;
      for (const e of free) { st[e.kind][e.idx] = (mask & (1 << free.indexOf(e))) ? LOOP : CUT; log.push([e.kind, e.idx]); }
      st.cell[k] = on === 0 ? CUT : LOOP;

      let ok = true, closes = false;
      if (on !== 0) {
        onCount++;
        const root0 = find(k);
        log.push(['O', root0, onSize[root0]]);
        onSize[root0]++;
        // 只并本次赋值新写出来的边：早就定死的边是它另一头的格负责并的，
        // 在这里再并一次会把每条边都读成「环在此闭合」
        for (const e of chosen) {
          const ra = find(k), rb = find(e.nb);
          if (ra === rb) { closes = true; continue; }
          parent[ra] = rb;
          log.push(['U', ra, rb, onSize[rb]]);
          onSize[rb] += onSize[ra];
        }
      }
      if (closes) {
        const root = find(k);
        if (onSize[root] !== onCount) ok = false;
        for (let di = 0; di < dots.length && ok; di++) {
          for (const ci of dotCells(dots[di], n)) if (st.cell[ci] === LOOP && find(ci) !== root) { ok = false; break; }
        }
      }
      // 点的两条臂沿整行/整列伸展，只在两端都定死时才有资格判等不等长：
      // 所以要剔除的是与 k 同行、同列的所有点，不只是压着 k 的那几个
      const r = (k / n) | 0, c = k % n;
      if (ok) for (const di of (dotsInRow.get(r) || [])) if (dotStatus(st, dots[di]) === 'bad') { ok = false; break; }
      if (ok) for (const di of (dotsInCol.get(c) || [])) if (dotStatus(st, dots[di]) === 'bad') { ok = false; break; }
      if (ok) out.push({ mask, closes, on });
      if (on !== 0) onCount--;
      undo(base);
      st.cell[k] = UNKNOWN;
    }
    return out;
  }

  function rec(remaining, closed) {
    nodes++;
    if (nodes > cap) { stopped = true; return; }
    if (remaining === 0) {
      // 收下靠量出来的状态，不靠一路剔除的历史：环必须已闭合，且每个点都判成 ok
      if (closed && dots.every((d) => dotStatus(st, d) === 'ok'))
        solutions.push({ cell: Int8Array.from(st.cell), H: Int8Array.from(st.H), V: Int8Array.from(st.V) });
      return;
    }
    let best = -1, bestOpts = null, bestAdj = -1;
    for (let k = 0; k < n * n; k++) {
      if (assigned[k]) continue;
      const opts = options(k, closed);
      // 一样受限时挑贴着已定区域的格：它的边多半已定死，选项数说的是棋盘的实情，
      // 不是一块四边全空的生地
      const r = (k / n) | 0, c = k % n;
      const adj = (r > 0 && assigned[k - n]) + (c > 0 && assigned[k - 1])
        + (r < n - 1 && assigned[k + n]) + (c < n - 1 && assigned[k + 1]);
      if (!bestOpts || opts.length < bestOpts.length || (opts.length === bestOpts.length && adj > bestAdj)) {
        best = k; bestOpts = opts; bestAdj = adj;
      }
      if (bestOpts.length === 0) break;                   // 有格无从下手 = 整枝死路，立刻回退
    }
    if (!bestOpts.length) return;
    for (const opt of bestOpts) {
      if (stopped) return;
      const base = log.length;
      const free = dirsOf(best).filter((e) => st[e.kind][e.idx] === UNKNOWN);
      const chosen = free.filter((_, i) => opt.mask & (1 << i));
      for (const e of free) { st[e.kind][e.idx] = (opt.mask & (1 << free.indexOf(e))) ? LOOP : CUT; log.push([e.kind, e.idx]); }
      st.cell[best] = opt.on === 0 ? CUT : LOOP;
      assigned[best] = 1;
      if (opt.on !== 0) {
        onCount++;
        const root0 = find(best);
        log.push(['O', root0, onSize[root0]]);
        onSize[root0]++;
        for (const e of chosen) {
          const ra = find(best), rb = find(e.nb);
          if (ra === rb) continue;
          parent[ra] = rb;
          log.push(['U', ra, rb, onSize[rb]]);
          onSize[rb] += onSize[ra];
        }
      }
      rec(remaining - 1, closed || opt.closes);
      assigned[best] = 0;
      st.cell[best] = UNKNOWN;
      if (opt.on !== 0) onCount--;
      undo(base);
    }
  }

  const t0 = Date.now();
  rec(n * n, false);
  return { count: solutions.length, solutions, nodes, bounded: stopped, ms: Date.now() - t0 };
}

/** 对照用的行序版本：同一套约束，只换分支顺序（每格只分叉 E/S） */
export function countSolutionsRowMajor(board, cap = NODE_CAP) {
  const { n, dots } = board;
  const st = emptyState(n);
  const parent = new Int16Array(n * n);
  const onSize = new Int16Array(n * n);
  for (let i = 0; i < n * n; i++) { parent[i] = i; onSize[i] = 0; }
  const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };

  const centre = new Set(), needE = new Set(), needS = new Set();
  const dotsInRow = new Map(), dotsInCol = new Map();
  for (const d of dots) {
    if (d.t === 'c') centre.add(cellIndex(n, d.r, d.c));
    if (d.t === 'v') needE.add(cellIndex(n, d.r, d.c - 1));
    if (d.t === 'h') needS.add(cellIndex(n, d.r - 1, d.c));
  }
  const push = (map, k, d) => { if (!map.has(k)) map.set(k, []); map.get(k).push(d); };
  for (const d of dots) { push(dotsInRow, d.r, d); push(dotsInCol, d.c, d); }

  let nodes = 0, stopped = false, onCount = 0;
  const solutions = [];
  const log = [];

  const rec = (k, closed) => {
    nodes++;
    if (nodes > cap) { stopped = true; return; }
    if (k === n * n) {
      if (closed) solutions.push({ cell: Int8Array.from(st.cell), H: Int8Array.from(st.H), V: Int8Array.from(st.V) });
      return;
    }
    const r = (k / n) | 0, c = k % n;
    const w = edgeAt(st, r, c, 3), up = edgeAt(st, r, c, 0);
    const fixed = (w === LOOP ? 1 : 0) + (up === LOOP ? 1 : 0);
    const eFree = c < n - 1, sFree = r < n - 1;
    // 右/下边界上那条边根本不存在，为它分叉会把同一个解数 2^(2n) 遍
    const eOpts = eFree ? [LOOP, CUT] : [CUT];
    const sOpts = sFree ? [LOOP, CUT] : [CUT];
    for (const e of eOpts) {
      for (const s of sOpts) {
        if (closed && (e === LOOP || s === LOOP)) continue;
        const deg = fixed + (e === LOOP ? 1 : 0) + (s === LOOP ? 1 : 0);
        if (deg !== 0 && deg !== 2) continue;
        if (centre.has(k) && !(deg === 2 && ((w === LOOP && e === LOOP) || (up === LOOP && s === LOOP)))) continue;
        if (needE.has(k) && e !== LOOP) continue;
        if (needS.has(k) && s !== LOOP) continue;

        const base = log.length;
        if (eFree) { st.H[hIndex(n, r, c)] = e; log.push(['H', hIndex(n, r, c)]); }
        if (sFree) { st.V[vIndex(n, r, c)] = s; log.push(['V', vIndex(n, r, c)]); }
        st.cell[k] = deg === 0 ? CUT : LOOP;

        let ok = true, closes = false;
        if (deg === 2) {
          onCount++;
          const root0 = find(k);
          log.push(['O', root0, onSize[root0]]);
          onSize[root0]++;
          const nbs = [];
          if (e === LOOP) nbs.push(k + 1);
          if (s === LOOP) nbs.push(k + n);
          for (const nb of nbs) {
            const ra = find(k), rb = find(nb);
            if (ra === rb) { closes = true; continue; }
            parent[ra] = rb;
            log.push(['U', ra, rb, onSize[rb]]);
            onSize[rb] += onSize[ra];
          }
        }
        if (closes) {
          const root = find(k);
          if (onSize[root] !== onCount) ok = false;
          for (let di = 0; di < dots.length && ok; di++) {
            for (const ci of dotCells(dots[di], n)) if (ci <= k && find(ci) !== root) { ok = false; break; }
          }
        }
        if (ok) for (const d of (dotsInRow.get(r) || [])) if (dotStatus(st, d) === 'bad') { ok = false; break; }
        if (ok) for (const d of (dotsInCol.get(c) || [])) if (dotStatus(st, d) === 'bad') { ok = false; break; }
        if (ok) rec(k + 1, closed || closes);

        while (log.length > base) {
          const t = log.pop();
          if (t[0] === 'U') { parent[t[1]] = t[1]; onSize[t[2]] = t[3]; }
          else if (t[0] === 'O') onSize[t[1]] = t[2];
          else st[t[0]][t[1]] = UNKNOWN;
        }
        if (deg === 2) onCount--;
        st.cell[k] = UNKNOWN;
        if (stopped) return;
      }
    }
  };

  const t0 = Date.now();
  rec(0, false);
  return { count: solutions.length, solutions, nodes, bounded: stopped, ms: Date.now() - t0 };
}
