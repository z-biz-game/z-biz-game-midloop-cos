// 对局状态。这一层**不含任何 Mid-loop 规则**：它只把玩家落下的笔写进引擎自己那两条边数组
// （js/engine/rules.js 的 st.H / st.V：UNKNOWN=0 没落笔 / LOOP=1 环边 / CUT=2 排除叉），
// 并且只通过 verify() 问一句「这算赢了吗」。UI 里没有第二份记分板，所以画面和判胜不可能各说一套。
//
// 边号一律经 rules.js 的 edgeRef(n,r,c,dir) 拿，本文件不重算任何索引几何 —— 重算一次就多一个
// 「画对了但点偏一格」的来源。格号与边号的双向读法用 rules.js 的 cellIndex/hIndex/vIndex/hRC/vRC。
//
// 关于 st.cell（格状态）：玩家**永远不直接点格**。格状态是笔迹的影子，只有两条路能改它：
//   1) syncCell()：由这条边上落下的笔推出来（有一条环边 ⇒ LOOP；四条边全落定且无环边 ⇒ CUT；
//      否则 UNKNOWN）。这是引擎 rule 2「一条线的两端都在环上」的强制结果，不是第二套判断。
//   2) 铅笔的一条关于格的结论（applyPin）：那种格被记进 pinnedCells，从此不再被 (1) 覆写 ——
//      否则玩家随手补一笔就会把提示刚说出的「这格在环上」擦掉。
// 撤销栈只记玩家与提示真的写下的东西（边、以及 pinned 的格），影子格随写随推，不占一步。

import {
  makeBoard, cellIndex, edgeRef, edgeAt, cellDirs, verify, loopOf,
  edgeId, edgeById, hIndex, vIndex, hRC, vRC, nEdgesH,
  DR, DC, DIR_NAMES, DOT_KIND_TEXT,
  UNKNOWN, LOOP, CUT,
} from '../engine/rules.js';
import { createState, applyDeduction } from '../engine/pencil.js';
import { toView } from '../engine/generate.js';

/** 方向下标：0=上 1=右 2=下 3=左（顺序与命名都取自 rules.js，不在这里另立一套） */
export const DIRS = [0, 1, 2, 3];
export const DIR_NAME = DIR_NAMES;
export const NAME_BY_DIR = { 0: '上', 1: '右', 2: '下', 3: '左' };

// 三态字符表：一格 / 一条边一个字符。'0' 是「没落笔」，'1' 是环边，'2' 是排除叉。
export const MARK_CHAR = { [UNKNOWN]: '0', [LOOP]: '1', [CUT]: '2' };
const CHAR_MARK = { 48: UNKNOWN, 49: LOOP, 50: CUT };

/**
 * 存档串 `marks` 的**唯一权威顺序**（js/store.js 只搬运它，不解释它）：
 *   先 st.H 全体（下标 hIndex(n,r,c)=r*(n-1)+c，即逐行、每行从左到右的横边），
 *   再 st.V 全体（下标 vIndex(n,r,c)=r*n+c，即逐行、每行从左到右的竖边），
 *   最后 st.cell 全体（下标 cellIndex(n,r,c)=r*n+c，逐行从左到右的格）。
 * 长度 = nEdgesH(n) + nEdgesH(n) + n*n = H.length + V.length + n*n。
 * 顺序由 rules.js 的三个下标函数决定，本文件与 Game.decode 都是按这三个数循环，
 * 所以「同一局」在任何一台机器上必然是同一个串。
 */
export function marksLength(n) {
  return nEdgesH(n) * 2 + n * n;
}

export class Game {
  constructor(puzzle) {
    if (!puzzle || !puzzle.ok) throw new Error('拿不到题面，开不了局');
    this.puzzle = puzzle;
    this.seed = puzzle.seed;
    this.sizeKey = puzzle.sizeKey;
    this.n = puzzle.n;
    // 视图形状由引擎的渲染适配器给（round 约定的 toView）。这里**只取题面那两个字段**：
    // toView 顺手带的 loop/h/v 是答案，本层一个字都不读，所以「提示替玩家看了一眼解」这种
    // 事故在数据结构上就不成立（视图想读答案得先绕过这个白名单）。
    const view = toView(puzzle);
    this.face = { n: view.n, dots: view.dots };
    this.board = makeBoard(this.n, puzzle.dots);
    // 权威状态：dots 只读，cell/H/V 就是玩家画的那支笔。用 pencil.createState 造它，
    // 于是「提示」那条路（nextDeduction(st)）读的是同一份对象，不是副本的副本。
    this.st = createState(this.board);
    /** 铅笔结论写下的格（影子推导不许覆写它们） */
    this.pinnedCells = new Set();
    this.undoStack = [];
    this._group = null;
    this.moves = 0;
  }

  // ---- 几何读数：全部经 rules.js ----------------------------------------------
  rc(k) {
    return [Math.floor(k / this.n), k % this.n];
  }

  cellOf(r, c) {
    return cellIndex(this.n, r, c);
  }

  inside(r, c) {
    return r >= 0 && c >= 0 && r < this.n && c < this.n;
  }

  /** 从 k 号格沿 dir 出去的那一格；出盘返回 -1（DR/DC 取自 rules.js） */
  neighbor(k, dir) {
    const [r, c] = this.rc(k);
    const nr = r + DR[dir], nc = c + DC[dir];
    return this.inside(nr, nc) ? this.cellOf(nr, nc) : -1;
  }

  /** 这一格这条方向有没有边、是哪条边（['H'|'V', idx] | null） */
  refOf(cell, dir) {
    const [r, c] = this.rc(cell);
    return edgeRef(this.n, r, c, dir);
  }

  /** 玩家（或提示）落笔的唯一入口：kind 就是引擎的三态 —— LOOP 画环、CUT 排除叉、UNKNOWN 擦掉 */
  setEdge(cell, dir, kind) {
    const ref = this.refOf(cell, dir);
    if (ref === null) return null; // 那里根本没有边（出盘了）
    const [arr, idx] = ref;
    const prev = this.st[arr][idx];
    if (prev === kind) return null;
    this.st[arr][idx] = kind;
    const nb = this.neighbor(cell, dir);
    this.syncCell(cell);
    if (nb >= 0) this.syncCell(nb);
    const rec = { kind: arr, idx, prev, value: kind, a: cell, b: nb };
    if (this._group) this._group.push(rec);
    else {
      this.undoStack.push([rec]);
      this.moves++;
    }
    return rec;
  }

  // 一条边在「叉」和「没落笔」之间来回：右键那一下走的就是这里。
  // LOOP 时也一步变成叉 —— 那是「这条我原先画错了，现在排除」，撤销照旧能退回环边；
  // 已经是叉再点一次才回到 UNKNOWN。两步都在 setEdge 的账上，不另开记分板。
  toggleCut(cell, dir) {
    const ref = this.refOf(cell, dir);
    if (ref === null) return null;
    return this.setEdge(cell, dir, this.st[ref[0]][ref[1]] === CUT ? UNKNOWN : CUT);
  }

  /** 边号 → [格号, 方向]：号是 rules.js edgeId 的那套扁平编号（提示与门禁都读它） */
  edgeCellDir(id) {
    if (!Number.isInteger(id)) return null;
    const ref = edgeById(this.st, id);
    if (!ref) return null;
    const [arr, idx] = ref;
    const [r, c] = arr === 'H' ? hRC(this.n, idx) : vRC(this.n, idx);
    if (!this.inside(r, c)) return null;
    return [this.cellOf(r, c), arr === 'H' ? 1 : 2];
  }

  /** 只有边号、没有 (格, 方向) 的调用方走的公开入口（门禁与旧代码用它，路径与手画同一条） */
  setEdgeById(id, kind) {
    const cd = this.edgeCellDir(id);
    if (!cd) return null;
    const [cell, dir] = cd;
    // 号 →（格,方向）→ 号 必须回到同一条边，否则宁可不写也不写错格
    const ref = this.refOf(cell, dir);
    if (ref === null || edgeId(this.st, ref[0], ref[1]) !== id) return null;
    return this.setEdge(cell, dir, kind);
  }

  /**
   * 铅笔的一条结论落地：写入走的必须是引擎的 applyDeduction（它只认 UNKNOWN 的位置，
   * 所以「提示覆写玩家已经画定的笔」在这一条路上不可能发生），落成的那一笔照样进撤销栈、
   * 照样在 moves 上记一步 —— 撤销与存档不会把提示当成局外之事。
   * @returns 撤销记录 | null（没落下去）
   */
  applyPin(pin) {
    if (!pin) return null;
    const kind = pin.kind;
    const idx = pin.idx;
    if (kind !== 'cell' && kind !== 'H' && kind !== 'V') return null;
    if (idx < 0 || idx >= this.st[kind].length) return null;
    const prev = this.st[kind][idx];
    if (!applyDeduction(this.st, pin)) return null;
    let rec;
    if (kind === 'cell') {
      this.pinnedCells.add(idx);
      rec = { kind: 'cell', idx, prev, value: pin.value, a: idx, b: -1 };
    } else {
      const [r, c] = kind === 'H' ? hRC(this.n, idx) : vRC(this.n, idx);
      const a = this.cellOf(r, c);
      const b = this.neighbor(a, kind === 'H' ? 1 : 2);
      this.syncCell(a);
      if (b >= 0) this.syncCell(b);
      rec = { kind, idx, prev, value: pin.value, a, b };
    }
    if (this._group) this._group.push(rec);
    else {
      this.undoStack.push([rec]);
      this.moves++;
    }
    return rec;
  }

  /**
   * 格状态是笔迹的影子（文件头那条约定）：有一条环边 ⇒ LOOP；四条边（出盘的读作排除，
   * 与 rules.js 的 edgeAt 同一个语义）全落定且都不是环边 ⇒ CUT；其余 UNKNOWN。
   * 铅笔直接说过的那一格不参与 —— 那是「已经知道它在环上/不在环上」的证据，比影子强。
   */
  syncCell(k) {
    if (this.pinnedCells.has(k)) return;
    const [r, c] = this.rc(k);
    let onLoop = false;
    let open = false;
    for (const d of DIRS) {
      const v = edgeAt(this.st, r, c, d);
      if (v === LOOP) { onLoop = true; break; }
      if (v === UNKNOWN) open = true;
    }
    this.st.cell[k] = onLoop ? LOOP : open ? UNKNOWN : CUT;
  }

  // 一次拖拽 = 一个撤销组。
  beginGesture() {
    this._group = [];
  }

  endGesture() {
    const g = this._group || [];
    this._group = null;
    if (!g.length) return false;
    this.undoStack.push(g);
    this.moves++;
    return true;
  }

  // 擦掉一格引出的全部边（环边和叉都算，一律回到 UNKNOWN）：「擦掉」这一笔和键盘退格走的是这条。
  // 右键不在这里——右键是「就动指针压着的那一条边」，见 toggleCut。
  eraseAt(cell) {
    let touched = 0;
    for (const d of DIRS) if (this.setEdge(cell, d, UNKNOWN)) touched++;
    return touched;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return false;
    // 逐条退回落笔前的那个值：三态里的哪一种都照原样退（环退回环、叉退回叉），
    // 不存在「撤销把叉变成没落笔」这种偷偷的第二义。
    for (let i = g.length - 1; i >= 0; i--) {
      const rec = g[i];
      this.st[rec.kind][rec.idx] = rec.prev;
      // 提示钉过的那一格退回去之后就再也轮不到影子推导替它说话：先摘钉，再让这一格（或
      // 这条边的两端）照着剩下的笔迹重算。
      if (rec.kind === 'cell') this.pinnedCells.delete(rec.idx);
      this.syncCell(rec.a);
      if (rec.b >= 0) this.syncCell(rec.b);
    }
    this.moves++;
    return true;
  }

  // 「全清」= 盘上一点笔迹都不留：环边、叉、以及提示说过的那些格全在清扫范围内
  //（只扫 LOOP 会留一地没人认领的叉，还有几格被提示钉在环上）。
  clearAll() {
    const pairs = [];
    for (let cell = 0; cell < this.n * this.n; cell++) {
      for (const d of [1, 2]) {
        const ref = this.refOf(cell, d);
        if (ref && this.st[ref[0]][ref[1]] !== UNKNOWN) pairs.push(ref);
      }
    }
    for (const [arr, idx] of pairs) this.st[arr][idx] = UNKNOWN;
    this.pinnedCells.clear();
    for (let k = 0; k < this.n * this.n; k++) this.syncCell(k);
    this.undoStack = [];
    this._group = null;
    this.moves++;
    return pairs.length;
  }

  // ---- 只是数一数（形状证据，不是第二套判胜）------------------------------------
  /** 这一格现在引出的环边方向（rules.js 的 cellDirs） */
  dirsOf(cell) {
    const [r, c] = this.rc(cell);
    return cellDirs(this.st, r, c);
  }

  degree(cell) {
    return this.dirsOf(cell).length;
  }

  /** 「这一格的环边接不通」——3 条以上就不是简单环了。度数 1 不在这里：那是拖到一半的开口。 */
  badCells() {
    const out = [];
    for (let cell = 0; cell < this.n * this.n; cell++) if (this.degree(cell) >= 3) out.push(cell);
    return out;
  }

  endpoints() {
    const out = [];
    for (let cell = 0; cell < this.n * this.n; cell++) if (this.degree(cell) === 1) out.push(cell);
    return out;
  }

  /** 环上格（引擎写下的那一层，不是这里数出来的） */
  loopCells() {
    const out = [];
    for (let k = 0; k < this.n * this.n; k++) if (this.st.cell[k] === LOOP) out.push(k);
    return out;
  }

  /** 被排除的格：四条边都落定且没有环边（或提示说过这格不在环上） */
  cutCells() {
    const out = [];
    for (let k = 0; k < this.n * this.n; k++) if (this.st.cell[k] === CUT) out.push(k);
    return out;
  }

  loopEdges() {
    const out = [];
    for (let cell = 0; cell < this.n * this.n; cell++) {
      for (const d of [1, 2]) {
        const ref = this.refOf(cell, d);
        if (ref && this.st[ref[0]][ref[1]] === LOOP) out.push(ref);
      }
    }
    return out;
  }

  cutEdges() {
    const out = [];
    for (let cell = 0; cell < this.n * this.n; cell++) {
      for (const d of [1, 2]) {
        const ref = this.refOf(cell, d);
        if (ref && this.st[ref[0]][ref[1]] === CUT) out.push(ref);
      }
    }
    return out;
  }

  /** 玩家已经落笔的格数（LOOP 或 CUT）——状态行要说「几格已定」，这里就是那个数 */
  markedCells() {
    return this.loopCells().length + this.cutCells().length;
  }

  /** 一条边（['H'|'V', idx]）的两端是哪两格（下标只经 rules.js 的 hRC/vRC 反读） */
  edgeCells(ref) {
    const [r, c] = ref[0] === 'H' ? hRC(this.n, ref[1]) : vRC(this.n, ref[1]);
    const a = this.cellOf(r, c);
    return [a, ref[0] === 'H' ? this.cellOf(r, c + 1) : this.cellOf(r + 1, c)];
  }

  /** ['H'|'V', idx] → rules.js edgeId 的那套扁平边号（存档/门禁读的是同一个数） */
  edgeIdOf(ref) {
    return edgeId(this.st, ref[0], ref[1]);
  }

  /** 题面那点压在哪条边上：'v' 点 → 横边 (r,c-1)-(r,c)；'h' 点 → 竖边 (r-1,c)-(r,c)；'c' → null */
  dotEdgeRef(dot) {
    if (dot.t === 'v') return ['H', hIndex(this.n, dot.r, dot.c - 1)];
    if (dot.t === 'h') return ['V', vIndex(this.n, dot.r - 1, dot.c)];
    return null;
  }

  /** 这一格上有没有一个格心点（键盘播报用） */
  dotOnCell(cell) {
    const [r, c] = this.rc(cell);
    for (const d of this.face.dots) if (d.t === 'c' && d.r === r && d.c === c) return d;
    return null;
  }

  // 唯一的判胜入口：引擎的 verify，一个字都没改写在这里。
  // 玩家没落笔的地方就是「还没落笔」，不是「已排除」——dotStatus 正是靠这个区分 pending 与 bad，
  // 所以这里绝不先把 UNKNOWN 补成 CUT 再交给引擎（那等于 UI 替玩家认领了没画的东西）。
  status() {
    return verify(this.board, this.st);
  }

  /** 已经成环（判胜通过）时返回那条环，否则 null：环长只在赢了之后说，不在过程中漏答案 */
  solutionLoop() {
    const reasons = this.status();
    return reasons.length ? null : loopOf(this.board, this.st);
  }

  // 存档：只存原始 seed + 尺寸 + 一格/一边一个字符（见 marksLength 的顺序注释）。
  // 生成器是确定性的，盘面从来不需要经过存储搬运，整份进度只有几百字节。
  encode() {
    let s = '';
    const st = this.st;
    for (let i = 0; i < st.H.length; i++) s += MARK_CHAR[st.H[i]] || '0';
    for (let i = 0; i < st.V.length; i++) s += MARK_CHAR[st.V[i]] || '0';
    for (let i = 0; i < st.cell.length; i++) s += MARK_CHAR[st.cell[i]] || '0';
    return s;
  }

  // 读档。第二个参数是**存档里记着的步数**：以前这里无条件把 moves 归零，于是「刷新一次页面，
  // 步数就变 0」——那是句谎话：撤销栈被清空是真的，玩家走过的步数不是。
  // 字符只认 '1'→环边、'2'→排除叉，其余一律读成没落笔：串短了、夹了乱码、甚至根本不是字符串，
  // 都只会被读成空盘，不会 throw 出加载路径。少认一个字符 = 老存档读崩，所以宁可读成没落笔。
  decode(s, moves = 0) {
    const str = typeof s === 'string' ? s : '';
    const st = this.st;
    const h = st.H.length, v = st.V.length;
    for (let i = 0; i < h; i++) st.H[i] = CHAR_MARK[str.charCodeAt(i)] ?? UNKNOWN;
    for (let i = 0; i < v; i++) st.V[i] = CHAR_MARK[str.charCodeAt(h + i)] ?? UNKNOWN;
    const cells = [];
    for (let k = 0; k < st.cell.length; k++) cells.push(CHAR_MARK[str.charCodeAt(h + v + k)] ?? UNKNOWN);
    // 影子格与提示钉过的格分家：读回来的那一格若与「由边推出来的那一格」不同，说明存档里它
    // 是被铅笔说过的一格（或者存档自己被人生改过），照原样保留并记成 pinned；相同就交给影子。
    this.pinnedCells.clear();
    for (let k = 0; k < st.cell.length; k++) st.cell[k] = UNKNOWN;
    for (let k = 0; k < st.cell.length; k++) {
      this.syncCell(k);
      if (cells[k] !== st.cell[k]) {
        st.cell[k] = cells[k];
        this.pinnedCells.add(k);
      } else this.pinnedCells.delete(k);
    }
    this.undoStack = [];
    this._group = null;
    this.moves = Number.isFinite(moves) && moves > 0 ? Math.floor(moves) : 0;
  }

  // 键盘/无障碍读数：这一格现在什么样，全部来自引擎的 cellDirs 与三态常量。
  // 排除叉也得念出来——玩家能用键盘画它，只听「环边 0 条：无」是不够的。
  cellReport(cell) {
    const [r, c] = this.rc(cell);
    const dirs = this.dirsOf(cell).map((d) => NAME_BY_DIR[d]);
    const cuts = [];
    for (const d of DIRS) {
      const ref = this.refOf(cell, d);
      if (ref !== null && this.st[ref[0]][ref[1]] === CUT) cuts.push(NAME_BY_DIR[d]);
    }
    const dot = this.dotOnCell(cell);
    const state = this.st.cell[cell];
    const onLoop = state === LOOP ? '在环上' : state === CUT ? '已排除' : '未定';
    return `第 ${r + 1} 行第 ${c + 1} 列${dot ? `（${DOT_KIND_TEXT[dot.t]}）` : ''}，${onLoop}，环边 ${dirs.length} 条：${dirs.join('、') || '无'}${
      cuts.length ? `，已排除 ${cuts.length} 条：${cuts.join('、')}` : ''
    }`;
  }

  /** 某个方向上有没有边（门禁与键盘用；出盘为 false） */
  hasEdge(cell, dir) {
    return this.refOf(cell, dir) !== null;
  }
}

export { UNKNOWN, LOOP, CUT, DR, DC, DIR_NAMES, DOT_KIND_TEXT, hIndex, vIndex, cellIndex, edgeRef };
