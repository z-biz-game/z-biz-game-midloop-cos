// 铅笔求解器：判据 2 的那条路。只用下面这些有名字的规则，从空盘一遍遍推到底，
// 不分叉、不回溯、不看答案；推不动就 stall，推出矛盾就 conflict。
//
// 这里刻意重新实现了一遍边几何和中点判定，没有 import rules.js —— 两条路在同一盘
// 上会师，必须是两套编码互相印证，而不是共用一个 helper 的自我循环。唯一共享的是
// 三态编码这个约定（0/1/2），engine-test 会当场把两边的常量对齐。
//
// 规则表按「先定死点自己、再顺着线推、最后用中点的等长臂收口」的顺序跑：
//   1  dot-on-loop        环必须经过每个点
//   2  edge-cells-on      一条线的两头都是环上格
//   3  cell-off-clears    不在环上的格，四条边全排除
//   4  no-dead-end        还能用的方向不足两个 ⇒ 这格不在环上
//   5  cell-degree-two    环上格恰好两条线：不许第三条，也不许缺口补不满
//   6  dot-straight       点必须被直穿：定下一个轴，另一个轴全死
//   7  arm-symmetry       中点规则：轴上两段臂等长
//   8  one-dot-per-run    一段直线只有一个中点 ⇒ 两点之间的连线必须断
//   9  no-dotless-pocket  被排除边围出来、里面一个点都没有的口袋上不了环
//   10 no-early-cycle     还有点在圈外时，环不许提前闭合
export const UNKNOWN = 0, LOOP = 1, CUT = 2;

export const RULE_ORDER = [
  'dot-on-loop', 'edge-cells-on', 'cell-off-clears', 'no-dead-end', 'cell-degree-two',
  'dot-straight', 'arm-symmetry', 'one-dot-per-run', 'no-dotless-pocket', 'no-early-cycle',
];

export const RULE_TEXT = {
  'dot-on-loop': '环必须经过每一个点',
  'edge-cells-on': '一条线的两端都在环上',
  'cell-off-clears': '不在环上的格，四边全排除',
  'no-dead-end': '可用方向不足两个，这格不在环上',
  'cell-degree-two': '环上格恰好两条线',
  'dot-straight': '点必须被直穿',
  'arm-symmetry': '点两侧臂等长（中点规则）',
  'one-dot-per-run': '一段直线只能有一个中点',
  'no-dotless-pocket': '没有点的口袋里上不了环',
  'no-early-cycle': '还有点在圈外时不许闭环',
};

export function createState(board) {
  const n = board.n;
  return {
    n,
    dots: board.dots,
    cell: new Int8Array(n * n),
    H: new Int8Array(n * (n - 1)),
    V: new Int8Array((n - 1) * n),
  };
}

/** st → 一条规则跑完后的下一步推导（UI 的提示按钮就调它） */
export const valOf = (st, ref) => (ref === null ? CUT : st[ref[0]][ref[1]]);

const rc = (n, k) => [((k / n) | 0), k % n];

/**
 * 在一个状态上跑铅笔推导。
 * @param st 已落笔的状态（就地推进的副本；传进来什么不动它）
 * @param each true = 推一步就停（给提示按钮），false = 推到定点（给生成器判可推性）
 */
export function deduce(st, { each = false } = {}) {
  const n = st.n;
  const out = { state: copyState(st), pins: [], fired: new Map(), conflict: null, rounds: 0 };
  const s = out.state;

  const hAt = (r, c) => (c < 0 || c > n - 2 ? null : r * (n - 1) + c);
  const vAt = (r, c) => (r < 0 || r > n - 2 ? null : r * n + c);
  const hRef = (r, c) => { const i = hAt(r, c); return i === null ? null : ['H', i]; };
  const vRef = (r, c) => { const i = vAt(r, c); return i === null ? null : ['V', i]; };
  const cellRef = (k) => ['cell', k];
  const at = (ref) => (ref === null ? CUT : s[ref[0]][ref[1]]);
  const where = (ref) => {
    if (ref === null) return null;
    if (ref[0] === 'cell') return rc(n, ref[1]);
    if (ref[0] === 'H') { const [r, c] = rc(n - 1, ref[1]); return [r, c + 0.5]; }
    const [r, c] = rc(n, ref[1]); return [r + 0.5, c];
  };

  let pend = [];
  const ask = (ref, val, why) => {
    if (ref === null) { if (val === LOOP) pend.push(['OFFGRID', -1, val, why]); return; }
    pend.push([ref[0], ref[1], val, why]);
  };

  const rays = (axis, r, c, dir) => {
    const list = [];
    if (axis === 'h') for (let cc = c; ; cc += dir) { const e = hAt(r, dir > 0 ? cc : cc - 1); if (e === null) break; list.push(['H', e]); }
    else for (let rr = r; ; rr += dir) { const e = vAt(dir > 0 ? rr : rr - 1, c); if (e === null) break; list.push(['V', e]); }
    return list;
  };
  const leading = (ray) => { let k = 0; while (k < ray.length && at(ray[k]) === LOOP) k++; return k; };
  const settled = (ray, k) => k === ray.length || at(ray[k]) === CUT;

  /** 点所在直线段的两端：臂长从这里量 */
  const endsFor = (d, axis) => (d.t === 'c'
    ? [{ axis, r: d.r, c: d.c, dir: 1, base: 0 }, { axis, r: d.r, c: d.c, dir: -1, base: 0 }]
    : d.t === 'v'
      ? [{ axis: 'h', r: d.r, c: d.c, dir: 1, base: 1 }, { axis: 'h', r: d.r, c: d.c - 1, dir: -1, base: 1 }]
      : [{ axis: 'v', r: d.r, c: d.c, dir: 1, base: 1 }, { axis: 'v', r: d.r - 1, c: d.c, dir: -1, base: 1 }]);

  /**
   * 两臂等长。已经定死的一侧把另一侧钉成同样的长度；还没定死的一侧只给上限，
   * 而且上限只在对面已经长到它时才咬得动 —— 一段直线结束之后，同一条线还会被
   * 环的别段再用，直接按上限切会切出假矛盾。
   */
  function symmetry(ends, why) {
    const info = (E) => {
      const ray = rays(E.axis, E.r, E.c, E.dir);
      const lo = leading(ray);
      return { ray, lo, hi: settled(ray, lo) ? lo : ray.length };
    };
    for (let i = 0; i < 2; i++) {
      const A = info(ends[i]), armA = A.lo + ends[i].base;
      const B = info(ends[1 - i]);
      for (let j = 0; j < A.lo; j++) ask(B.ray[j], LOOP, `${why}：对面的臂已经走到 ${armA} 格`);
      if (A.hi < B.ray.length && leading(B.ray) >= A.hi) {
        ask(B.ray[A.hi], CUT, `${why}：另一侧只留 ${(A.hi + ends[1 - i].base)} 格的臂长`);
      }
    }
  }

  const dotSides = (d) => (d.t === 'c'
    ? [cellRef(d.r * n + d.c)]
    : d.t === 'v' ? [cellRef(d.r * n + d.c - 1), cellRef(d.r * n + d.c)]
      : [cellRef((d.r - 1) * n + d.c), cellRef(d.r * n + d.c)]);

  const dotEdge = (d) => (d.t === 'c' ? null : d.t === 'v' ? hRef(d.r, d.c - 1) : vRef(d.r - 1, d.c));

  const axisAt = (d) => {
    if (d.t !== 'c') return d.t === 'v' ? 'h' : 'v';
    const h = at(hRef(d.r, d.c - 1)) === LOOP && at(hRef(d.r, d.c)) === LOOP;
    const v = at(vRef(d.r - 1, d.c)) === LOOP && at(vRef(d.r, d.c)) === LOOP;
    if (h && v) return 'both';
    return h ? 'h' : v ? 'v' : null;
  };

  const cellDirs = (r, c) => [hRef(r, c - 1), hRef(r, c), vRef(r - 1, c), vRef(r, c)].filter(Boolean);

  const label = (d) => `点(${d.r},${d.c},${d.t})`;
  const cellName = (k) => { const [r, c] = rc(n, k); return `格(${r},${c})`; };

  const RULES = {
    'dot-on-loop': () => {
      for (const d of st.dots) {
        const why = `${label(d)} 在环上`;
        for (const ref of dotSides(d)) ask(ref, LOOP, why);
        if (d.t !== 'c') ask(dotEdge(d), LOOP, `${label(d)} 必须被环穿过`);
      }
    },
    'edge-cells-on': () => {
      for (let i = 0; i < s.H.length; i++) if (s.H[i] === LOOP) {
        const [r, c] = rc(n - 1, i), why = `横边(${r},${c}|${c + 1}) 是环边`;
        ask(cellRef(r * n + c), LOOP, why); ask(cellRef(r * n + c + 1), LOOP, why);
      }
      for (let i = 0; i < s.V.length; i++) if (s.V[i] === LOOP) {
        const [r, c] = rc(n, i), why = `竖边(${r}|${r + 1},${c}) 是环边`;
        ask(cellRef(i), LOOP, why); ask(cellRef(i + n), LOOP, why);
      }
    },
    'cell-off-clears': () => {
      for (let k = 0; k < n * n; k++) {
        if (s.cell[k] !== CUT) continue;
        const [r, c] = rc(n, k);
        for (const ref of cellDirs(r, c)) ask(ref, CUT, `${cellName(k)} 不在环上`);
      }
    },
    'no-dead-end': () => {
      for (let k = 0; k < n * n; k++) {
        if (s.cell[k] === LOOP) continue;
        const [r, c] = rc(n, k);
        const open = cellDirs(r, c).filter((ref) => at(ref) !== CUT).length;
        if (open < 2) ask(cellRef(k), CUT, `${cellName(k)} 只剩 ${open} 个可用方向`);
      }
    },
    'cell-degree-two': () => {
      for (let k = 0; k < n * n; k++) {
        if (s.cell[k] !== LOOP) continue;
        const [r, c] = rc(n, k);
        const dirs = cellDirs(r, c);
        const on = dirs.filter((ref) => at(ref) === LOOP);
        const open = dirs.filter((ref) => at(ref) === UNKNOWN);
        const why = `${cellName(k)} 在环上`;
        if (on.length > 2) ask(cellRef(k), UNKNOWN, `${why}，却已有 ${on.length} 条线`);
        else if (on.length === 2) for (const ref of open) ask(ref, CUT, `${why}，两条线已经齐了`);
        else if (on.length + open.length < 2) ask(cellRef(k), UNKNOWN, `${why}，可只有 ${on.length + open.length} 个方向存在`);
        else if (open.length === 2 - on.length) for (const ref of open) ask(ref, LOOP, `${why}，只剩 ${open.length} 个方向可走`);
      }
    },
    'dot-straight': () => {
      for (const d of st.dots) {
        if (d.t !== 'c') continue;
        const why = `${label(d)} 要被直穿`;
        const W = hRef(d.r, d.c - 1), E = hRef(d.r, d.c), U = vRef(d.r - 1, d.c), D = vRef(d.r, d.c);
        const live = (ref) => !!ref && at(ref) !== CUT;
        const on = (ref) => !!ref && at(ref) === LOOP;
        const hAlive = live(W) && live(E), vAlive = live(U) && live(D);
        if (on(W) || on(E)) {
          ask(W, LOOP, `${why}，而且已从西侧进入`); ask(E, LOOP, `${why}，而且已从西侧进入`);
          ask(U, CUT, `${why}，不许拐弯`); ask(D, CUT, `${why}，不许拐弯`);
        } else if (on(U) || on(D)) {
          ask(U, LOOP, `${why}，而且已从上方进入`); ask(D, LOOP, `${why}，而且已从上方进入`);
          ask(W, CUT, `${why}，不许拐弯`); ask(E, CUT, `${why}，不许拐弯`);
        } else if (hAlive && !vAlive) {
          ask(W, LOOP, `${why}，只剩横轴`); ask(E, LOOP, `${why}，只剩横轴`);
          ask(U, CUT, `${why}，竖轴已死`); ask(D, CUT, `${why}，竖轴已死`);
        } else if (vAlive && !hAlive) {
          ask(U, LOOP, `${why}，只剩竖轴`); ask(D, LOOP, `${why}，只剩竖轴`);
          ask(W, CUT, `${why}，横轴已死`); ask(E, CUT, `${why}，横轴已死`);
        } else if (!hAlive && !vAlive) {
          ask(cellRef(d.r * n + d.c), UNKNOWN, `${label(d)} 已无任何轴可走`);
        }
      }
    },
    'arm-symmetry': () => {
      for (const d of st.dots) {
        const why = `${label(d)} 是那段直线的中点`;
        if (d.t === 'c') {
          const ax = axisAt(d);
          if (ax === 'h' || ax === 'v') symmetry(endsFor(d, ax), why);
        } else {
          const e = dotEdge(d);
          if (!e || at(e) !== LOOP) continue;
          symmetry(endsFor(d), why);
        }
      }
    },
    'one-dot-per-run': () => {
      const hPos = (d) => (d.t === 'c' || d.t === 'v' ? d.c : null);
      const vPos = (d) => (d.t === 'c' || d.t === 'h' ? d.r : null);
      const pairs = (lineOf, posOf, refOf) => {
        const byLine = new Map();
        for (const d of st.dots) {
          const p = posOf(d);
          if (p === null) continue;
          const line = lineOf(d);
          if (!byLine.has(line)) byLine.set(line, []);
          byLine.get(line).push([p, d]);
        }
        for (const [line, list] of byLine) {
          list.sort((a, b) => a[0] - b[0]);
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const chain = [];
              for (let p = list[i][0]; p < list[j][0]; p++) chain.push(refOf(line, p));
              const on = chain.filter((ref) => ref && at(ref) === LOOP).length;
              const unknown = chain.filter((ref) => ref && at(ref) === UNKNOWN);
              if (chain.some((ref) => !ref || at(ref) === CUT)) continue;
              if (on === chain.length) ask(chain[0], CUT, `${label(list[i][1])} 和 ${label(list[j][1])} 会共用一段直线`);
              else if (unknown.length === 1) ask(unknown[0], CUT, `${label(list[i][1])} 与 ${label(list[j][1])} 之间的直线必须在这里断开`);
            }
          }
        }
      };
      pairs((d) => d.r, hPos, (r, p) => hRef(r, p));
      pairs((d) => d.c, vPos, (c, p) => vRef(p, c));
    },
    'no-dotless-pocket': () => {
      const dotCell = new Set();
      for (const d of st.dots) for (const ref of dotSides(d)) dotCell.add(ref[1]);
      const seen = new Int8Array(n * n);
      for (let start = 0; start < n * n; start++) {
        if (seen[start] || s.cell[start] === CUT) continue;
        const stack = [start], comp = [];
        seen[start] = 1;
        while (stack.length) {
          const k = stack.pop();
          comp.push(k);
          const [r, c] = rc(n, k);
          for (const ref of cellDirs(r, c)) {
            if (at(ref) === CUT) continue;
            const [kind, idx] = ref;
            const nb = kind === 'H' ? (idx % (n - 1) === c - 1 ? k - 1 : k + 1) : (idx === k ? k + n : k - n);
            if (nb < 0 || nb >= n * n || seen[nb] || s.cell[nb] === CUT) continue;
            seen[nb] = 1; stack.push(nb);
          }
        }
        if (comp.some((k) => dotCell.has(k))) continue;
        for (const k of comp) if (s.cell[k] === UNKNOWN) ask(cellRef(k), CUT, `(${rc(n, k).join(',')}) 所在的口袋里一个点都没有`);
      }
    },
    'no-early-cycle': () => {
      const parent = new Int32Array(n * n);
      const members = new Map();
      for (let i = 0; i < n * n; i++) parent[i] = i;
      const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };
      const link = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra === rb) return;
        parent[ra] = rb;
        const m = new Set([...(members.get(ra) || [ra]), ...(members.get(rb) || [rb])]);
        members.set(rb, m); members.delete(ra);
      };
      for (let i = 0; i < s.H.length; i++) if (s.H[i] === LOOP) { const [r, c] = rc(n - 1, i); link(r * n + c, r * n + c + 1); }
      for (let i = 0; i < s.V.length; i++) if (s.V[i] === LOOP) link(i, i + n);
      for (let k = 0; k < n * n; k++) if (!members.has(find(k))) members.set(find(k), new Set([k]));
      const dotRefs = st.dots.flatMap((d) => dotSides(d).map((ref) => [ref, d]));
      const tryEdge = (ref, a, b) => {
        if (at(ref) !== UNKNOWN || s.cell[a] !== LOOP || s.cell[b] !== LOOP) return;
        if (find(a) !== find(b)) return;                          // 接上它也闭不了圈
        const group = members.get(find(a));
        for (const [sideRef, d] of dotRefs) if (!group.has(sideRef[1])) { ask(ref, CUT, `在这里闭圈会把 ${label(d)} 关在圈外`); return; }
      };
      for (let i = 0; i < s.H.length; i++) { const [r, c] = rc(n - 1, i); tryEdge(['H', i], r * n + c, r * n + c + 1); }
      for (let i = 0; i < s.V.length; i++) tryEdge(['V', i], i, i + n);
    },
  };

  for (; ;) {
    out.rounds++;
    pend = [];
    for (const name of RULE_ORDER) {
      const before = pend.length;
      RULES[name]();
      for (let i = before; i < pend.length; i++) pend[i].push(name);
    }
    let changed = false;
    for (const [kind, idx, val, why, name] of pend) {
      if (out.conflict) break;
      if (kind === 'OFFGRID') { out.conflict = `${name}: ${why}`; continue; }
      const cur = s[kind][idx];
      if (val === UNKNOWN) {
        if (cur !== UNKNOWN) out.conflict = `${name}: ${why} —— 可它已经定了`;
        continue;
      }
      if (cur !== UNKNOWN && cur !== val) { out.conflict = `${name}: ${why} —— 可它必须是 ${cur === LOOP ? '环边' : '排除'}`; continue; }
      if (cur === UNKNOWN) {
        s[kind][idx] = val; changed = true;
        out.fired.set(name, (out.fired.get(name) || 0) + 1);
        out.pins.push({ rule: name, ruleText: RULE_TEXT[name], kind, idx, value: val, why, at: where([kind, idx]) });
        if (each) { out.stoppedEarly = true; return out; }
      }
    }
    if (each && out.pins.length) { out.stoppedEarly = true; return out; }
    if (out.conflict || !changed) break;
    if (out.rounds > 400) { out.conflict = '400 轮仍未收敛'; break; }
  }
  return out;
}

function copyState(st) {
  return { n: st.n, dots: st.dots, cell: Int8Array.from(st.cell), H: Int8Array.from(st.H), V: Int8Array.from(st.V) };
}

const unknownCount = (s) => Array.from(s.cell).filter((v) => v === UNKNOWN).length
  + Array.from(s.H).filter((v) => v === UNKNOWN).length
  + Array.from(s.V).filter((v) => v === UNKNOWN).length;

/** 从空盘推到底：pinned = 每格每边都定死，且没有矛盾 */
export function solve(board) {
  const st = createState(board);
  const run = deduce(st);
  const unknownCells = Array.from(run.state.cell).filter((v) => v === UNKNOWN).length;
  const unknownEdges = Array.from(run.state.H).filter((v) => v === UNKNOWN).length
    + Array.from(run.state.V).filter((v) => v === UNKNOWN).length;
  return {
    state: run.state, pins: run.pins, fired: run.fired, conflict: run.conflict, rounds: run.rounds - 1,
    unknownCells, unknownEdges, unknown: unknownCells + unknownEdges,
    pinned: !run.conflict && !unknownCells && !unknownEdges,
  };
}

/** 玩家当前局面上的下一步推导；没有可推的就说明卡在哪 */
export function nextDeduction(st) {
  const run = deduce(st, { each: true });
  if (run.conflict) return { contradiction: true, rule: run.conflict.split(':')[0], why: run.conflict };
  if (run.pins.length) return run.pins[0];
  const left = unknownCount(run.state);
  return { stalled: true, unknown: left, why: left ? `十条规则都推不动，还剩 ${left} 处没落笔` : '已经推完' };
}

/** 把一条推导落进状态（提示按钮用它；生成器不碰这个） */
export function applyDeduction(st, pin) {
  if (!pin || pin.contradiction || pin.stalled) return false;
  const box = pin.kind === 'cell' ? st.cell : st[pin.kind];
  if (box[pin.idx] !== UNKNOWN) return false;
  box[pin.idx] = pin.value;
  return true;
}

export { unknownCount };
