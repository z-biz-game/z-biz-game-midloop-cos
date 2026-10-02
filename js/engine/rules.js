// Mid-loop（ミッドループ）规则的唯一编码处：棋盘几何 + 一个点合法与否的判定。
//
// 规则按 Nikoli 官方例题裁定过（README「规则」节 + DESIGN 裁定表）：
// 一条不自交闭环穿过若干格心；每个点都必须是「经过它的那段最长直线段」的正中点。
// 点可以落在格心里，也可以落在两条相邻格之间的格线上 —— 后者意味着线上两侧
// 各有一格，且这两格都在环上。
//
// 为什么不是「直线穿过即可」：Nikoli 自己那盘 5x5 例题在弱读法下有 26 个解，在
// 这个读法下恰好 1 个，而且那一个就是它公布的答案（tools/engine-test.mjs 钉住）。
//
// 环画在格与格之间：`H[r*(n-1)+c]` 是 (r,c)-(r,c+1) 这条边，`V[r*n+c]` 是
// (r,c)-(r+1,c)。每条边三态：UNKNOWN 没落笔 / LOOP 环边 / CUT 排除叉。

export const UNKNOWN = 0, LOOP = 1, CUT = 2;
/** 方向下标：0=上 1=右 2=下 3=左 */
export const DR = [-1, 0, 1, 0], DC = [0, 1, 0, -1];
export const DIR_NAMES = ['上', '右', '下', '左'];

/** 点：{t:'c',r,c} 格心；{t:'v',r,c} 竖格线上（c 列左侧）；{t:'h',r,c} 横格线上（r 行上侧） */
export const DOT_KIND_TEXT = { c: '格心点', v: '竖线上的点', h: '横线上的点' };

export function makeBoard(n, dots) {
  for (const d of dots) {
    if (d.t === 'c' && !(d.r >= 0 && d.r < n && d.c >= 0 && d.c < n)) throw new Error('格心点越界: ' + JSON.stringify(d));
    if (d.t === 'v' && !(d.r >= 0 && d.r < n && d.c >= 1 && d.c <= n - 1)) throw new Error('竖线点越界: ' + JSON.stringify(d));
    if (d.t === 'h' && !(d.r >= 1 && d.r <= n - 1 && d.c >= 0 && d.c < n)) throw new Error('横线点越界: ' + JSON.stringify(d));
  }
  return { n, dots: dots.map((d) => ({ ...d })) };
}

export const hIndex = (n, r, c) => r * (n - 1) + c;   // (r,c)-(r,c+1)
export const vIndex = (n, r, c) => r * n + c;         // (r,c)-(r+1,c)
export const hRC = (n, i) => [((i / (n - 1)) | 0), i % (n - 1)];
export const vRC = (n, i) => [((i / n) | 0), i % n];
export const edgeCount = (n) => 2 * n * (n - 1);
/** 一条边在 st.H/st.V 里的扁平下标，供存档与 UI 使用 */
export function edgeId(st, kind, idx) { return kind === 'H' ? idx : nEdgesH(st.n) + idx; }
export function edgeById(st, id) {
  const h = nEdgesH(st.n);
  return id < h ? ['H', id] : ['V', id - h];
}
export const nEdgesH = (n) => n * (n - 1);

export function emptyState(n) {
  return { n, cell: new Int8Array(n * n), H: new Int8Array(n * (n - 1)), V: new Int8Array((n - 1) * n) };
}

/** 从 (r,c) 沿方向 d 出去的那条边；走出棋盘返回 null */
export function edgeRef(n, r, c, d) {
  if (d === 0) return r > 0 ? ['V', vIndex(n, r - 1, c)] : null;
  if (d === 1) return c < n - 1 ? ['H', hIndex(n, r, c)] : null;
  if (d === 2) return r < n - 1 ? ['V', vIndex(n, r, c)] : null;
  return c > 0 ? ['H', hIndex(n, r, c - 1)] : null;
}

/** 出界的边读作「不是环边」，规则里正好要这个语义 */
export function edgeAt(st, r, c, d) {
  const ref = edgeRef(st.n, r, c, d);
  return ref === null ? CUT : st[ref[0]][ref[1]];
}

export const cellIndex = (n, r, c) => r * n + c;
export const cellRC = (n, k) => [((k / n) | 0), k % n];

/** 一个点压住哪几格：格心点 1 格，线上点 2 格 */
export function dotCells(d, n) {
  return d.t === 'c' ? [cellIndex(n, d.r, d.c)]
    : d.t === 'v' ? [cellIndex(n, d.r, d.c - 1), cellIndex(n, d.r, d.c)]
      : [cellIndex(n, d.r - 1, d.c), cellIndex(n, d.r, d.c)];
}

/**
 * 拿一个点对着一局半成品测：'ok' | 'bad' | 'pending'。
 * 两条臂从点往外数「环继续走了几格」，走到棋盘边界或已知排除的边就封顶，
 * 遇到没落笔的边就只能 pending —— 它还没资格被判等不等长。
 */
export function dotStatus(st, dot) {
  const n = st.n;
  const walk = (r, c, d) => {
    let len = 0;
    for (; ; ) {
      const ref = edgeRef(n, r, c, d);
      if (ref === null) return { len, done: true };
      const v = st[ref[0]][ref[1]];
      if (v === UNKNOWN) return { len, done: false };
      if (v === CUT) return { len, done: true };
      len++; r += DR[d]; c += DC[d];
    }
  };

  if (dot.t === 'c') {
    const { r, c } = dot;
    if (st.cell[cellIndex(n, r, c)] === UNKNOWN) return 'pending';
    if (st.cell[cellIndex(n, r, c)] === CUT) return 'bad';
    const w = edgeAt(st, r, c, 3), e = edgeAt(st, r, c, 1);
    const up = edgeAt(st, r, c, 0), dn = edgeAt(st, r, c, 2);
    const horiz = w === LOOP && e === LOOP && up === CUT && dn === CUT;
    const vert = up === LOOP && dn === LOOP && w === CUT && e === CUT;
    if (!horiz && !vert) return 'bad';                     // 拐弯了，或者没直穿
    const a = horiz ? walk(r, c, 1) : walk(r, c, 2);
    const b = horiz ? walk(r, c, 3) : walk(r, c, 0);
    if (!a.done || !b.done) return 'pending';
    return a.len === b.len ? 'ok' : 'bad';
  }

  if (dot.t === 'v') {
    const { r, c } = dot;
    const e = st.H[hIndex(n, r, c - 1)];
    if (e === CUT) return 'bad';
    if (e === UNKNOWN) return 'pending';
    const a = walk(r, c, 1), b = walk(r, c - 1, 3);
    if (!a.done || !b.done) return 'pending';
    return a.len === b.len ? 'ok' : 'bad';
  }

  const { r, c } = dot;
  const e = st.V[vIndex(n, r - 1, c)];
  if (e === CUT) return 'bad';
  if (e === UNKNOWN) return 'pending';
  const a = walk(r, c, 2), b = walk(r - 1, c, 0);
  if (!a.done || !b.done) return 'pending';
  return a.len === b.len ? 'ok' : 'bad';
}

/** 一个点所在的那条直线轴向 */
export const dotAxis = (d) => (d.t === 'c' ? null : d.t === 'v' ? 'h' : 'v');

/**
 * 完整状态 → 环的经过顺序；边不是一条干净的闭环就返回 null。
 * 判据：每格度数 0 或 2、至少 4 格、从任一格走能不重复地走完所有环上格再回到起点。
 */
export function loopOf(board, st) {
  const n = board.n;
  const deg = (r, c) => {
    let d = 0; const nb = [];
    for (let k = 0; k < 4; k++) {
      const ref = edgeRef(n, r, c, k);
      if (ref !== null && st[ref[0]][ref[1]] === LOOP) { d++; nb.push([r + DR[k], c + DC[k]]); }
    }
    return { d, nb };
  };
  const on = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (st.cell[cellIndex(n, r, c)] === LOOP) on.push([r, c]);
  for (const [r, c] of on) if (deg(r, c).d !== 2) return null;
  if (on.length < 4) return null;
  const key = (p) => p[0] * n + p[1];
  const set = new Set(on.map(key));
  const path = [on[0]];
  let prev = null, cur = on[0];
  for (; ; ) {
    const nb = deg(cur[0], cur[1]).nb.filter((p) => set.has(key(p)));
    if (nb.length !== 2) return null;
    const nxt = prev === null || key(nb[0]) !== key(prev) ? nb[0] : nb[1];
    prev = cur; cur = nxt;
    if (key(cur) === key(on[0])) break;
    path.push(cur);
    if (path.length > on.length) return null;
  }
  return path.length === on.length ? path : null;
}

/** 一格现在有几条环边、都是哪个方向 */
export function cellDirs(st, r, c) {
  const out = [];
  for (let d = 0; d < 4; d++) if (edgeAt(st, r, c, d) === LOOP) out.push(d);
  return out;
}

/** 一局是不是合法答案（空数组 = 合法） */
export function verify(board, st) {
  const reasons = [];
  for (const d of board.dots) {
    const s = dotStatus(st, d);
    if (s !== 'ok') reasons.push(`${DOT_KIND_TEXT[d.t]}(${d.r},${d.c}) ${s === 'bad' ? '不是那段直线段的中点' : '还没落定'}`);
  }
  if (!loopOf(board, st)) reasons.push('边不是一条单一闭环');
  return reasons;
}

/** 环格集合 → 直接可写的状态（生成器与测试用它把答案装回棋盘） */
export function stateFromEdges(n, loopEdges) {
  const st = emptyState(n);
  st.cell.fill(CUT);
  for (const [r, c] of loopEdges.cells) st.cell[cellIndex(n, r, c)] = LOOP;
  for (const [r, c] of loopEdges.h) st.H[hIndex(n, r, c)] = LOOP;
  for (const [r, c] of loopEdges.v) st.V[vIndex(n, r, c)] = LOOP;
  for (let i = 0; i < st.H.length; i++) if (st.H[i] === UNKNOWN) st.H[i] = CUT;
  for (let i = 0; i < st.V.length; i++) if (st.V[i] === UNKNOWN) st.V[i] = CUT;
  return st;
}
