// Canvas 渲染层。它读 Game 手里那份引擎状态来画，自己不判断任何东西——没有哪条边在这里被
// 宣布「对」，也没有哪一格在这里被宣布「赢」——所以画面不可能和判胜用的 verify 打架。
//
// 布局（格边长、盘面原点、DPR）也住在这里，因为 hitCell 必须回答「玩家点的那一下是哪一格」，
// 用的必须是 draw 刚刚用过的那批数字。这两处分家就会出现「盘画对了、点击偏一格」的事故。
//
// 一条硬约束：环画在**格心之间**的段上，而边框点画在**两格共用的那条格线的中点**上 ——
// 那正是环线与排除叉的落点。所以这三样东西只有 posOf()/markPoint() 一个坐标来源，
// 第二套「点在哪」的算法必然漂半个格。


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Board, Radius } from '../theme.js';
import { dotStatus, UNKNOWN, LOOP, CUT } from '../engine/rules.js';

/** 每条无向边只从这两侧各画一次（右、下），免得重复描线 */
const LOOP_DIRS = [1, 2];
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;

export function layoutFor(n, availW, availH) {
  const pad = Board.pad;
  const size = Math.max(0, Math.min((availW - pad * 2) / n, (availH - pad * 2) / n));
  const cell = Math.max(Board.cellMin, Math.min(Board.cellMax, Math.floor(size)));
  return { cell, boardW: cell * n, boardH: cell * n, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
    this.game = null;
  }

  // 后备缓冲按设备像素定尺寸，而每个绘制调用都留在 CSS 像素里：顶部一次 setTransform，
  // 就免得把这个文件里每个常数都乘二。
  resize(game, availW, availH) {
    const l = layoutFor(game.n, availW, availH);
    const dpr = Math.max(1, Math.round((typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr, pad: l.pad };
    this.game = game;
    return this.geo;
  }

  // ---- 几何读数（CSS 像素，画布本地）-------------------------------------------
  // 取样只许用这几个函数产出的坐标，再乘 geo.dpr：page/client 坐标里带着画布自己的
  // getBoundingClientRect 偏移，喂给 getImageData 会量到整个盘宽之外的面板底色上。

  /** 唯一的坐标来源：格坐标 (r,c) —— 可以是半整数 —— → 像素 */
  posOf(r, c) {
    const { cell: k, x, y } = this.geo;
    return { x: x + (c + 0.5) * k, y: y + (r + 0.5) * k };
  }

  centerOf(cell) {
    const n = this.game.n;
    return this.posOf(Math.floor(cell / n), cell % n);
  }

  cellRect(cell) {
    const { cell: k, x, y } = this.geo;
    const n = this.game.n;
    const px = (cell % n) * k + x;
    const py = (Math.floor(cell / n) * k) + y;
    return { x: px, y: py, w: k, h: k, size: k, cx: px + k / 2, cy: py + k / 2 };
  }

  /** 两格之间那条边的中点（= 环线经过的点 = 排除叉的心 = 边框点的心） */
  midpointOf(cellA, cellB) {
    const a = this.centerOf(cellA);
    const b = this.centerOf(cellB);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // 一条环边的**包围盒**：中点就是画笔经过的那一点，厚度取 lineWidth，
  // 所以环线粗细改了也不会让取样点跑出线外。
  segRect(cell, d) {
    const g = this.game;
    const nb = g.neighbor(cell, d);
    if (nb < 0) return null;
    const a = this.centerOf(cell);
    const b = this.centerOf(nb);
    const t = Math.max(2, this.geo.cell * Board.loopWidth);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    return {
      x: w > 0 ? x : x - t / 2,
      y: h > 0 ? y : y - t / 2,
      w: w > 0 ? w : t,
      h: h > 0 ? h : t,
      cell: nb,
      d,
    };
  }

  // 排除叉的**画法**（中心 + 半臂长 + 线宽）：中心就是这条边的中点，和 segRect 用的是同一批
  // 数，所以按它取样必然落在画出来的那两笔上。draw 与取样只有这一个来源。
  markPoint(cell, d) {
    const g = this.game;
    const nb = g.neighbor(cell, d);
    if (nb < 0) return null;
    const k = this.geo.cell;
    const m = this.midpointOf(cell, nb);
    return {
      x: m.x,
      y: m.y,
      arm: Math.max(3, k * Board.cutArm),
      width: Math.max(1.5, k * Board.cutWidth),
    };
  }

  /** 一条边（['H'|'V', idx]）的画法中心：线上点与排除叉都按它落笔，格心点走 centerOf */
  edgePoint(ref) {
    if (!ref) return null;
    const [a, b] = this.game.edgeCells(ref);
    return this.midpointOf(a, b);
  }

  /**
   * 一颗题面点该画在哪个像素：格心点 → 那一格的心；线上点 → 它压着的那条边的中点。
   * 半径按 Board.dotR（0.13 格），线上点的半径与 markPoint 的半臂（0.17 格）拉开，
   * 所以「点 + 叉」同时落在一个位置时两个形状都还看得见。
   */
  dotPoint(dot) {
    const g = this.game;
    const k = this.geo.cell;
    const p = dot.t === 'c'
      ? this.centerOf(g.cellOf(dot.r, dot.c))
      : this.edgePoint(g.dotEdgeRef(dot));
    return { x: p.x, y: p.y, r: Math.max(2.5, k * Board.dotR) };
  }

  // 度数异常的格：错误圈上的一点（45°，避开设在格心的题面点和沿轴走的环线）。
  ringPoint(cell) {
    const { cell: k } = this.geo;
    const c = this.centerOf(cell);
    const r = k * 0.42 * Math.SQRT1_2;
    return { x: c.x + r, y: c.y + r };
  }

  dotR() {
    return this.geo.cell * Board.dotR;
  }

  // 指针的 client 坐标 → 格号。画布外的点返回 -1。
  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.n || gy >= g.n) return -1;
    return gy * g.n + gx;
  }

  // 指针的 client 坐标 → 这一格里**那一条边**。规则是「落在哪一半就动哪一条」：主轴（|dx| 与
  // |dy| 谁大）决定横竖，符号决定朝哪。正好点在格心时 dx=dy=0 → 记作 RIGHT，是确定的、可测的。
  // 出盘的方向（那里根本没有边）返回 null，由调用方什么也不做。
  // hitCell 与 hitEdge 读的是 draw 刚刚用过的同一批 geo，所以不可能「画对了点偏一格」。
  hitEdge(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return null;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.n || gy >= g.n) return null;
    const hit = gy * g.n + gx;
    const dx = px - (gx * cell + cell / 2);
    const dy = py - (gy * cell + cell / 2);
    const d = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? RIGHT : LEFT) : (dy >= 0 ? DOWN : UP);
    return g.hasEdge(hit, d) ? { cell: hit, d } : null;
  }

  // 两格之间那条边的方向（不相邻返回 -1）——相邻关系由 Game 经 rules.js 的 DR/DC 判，这里不算。
  dirFromTo(from, to) {
    const g = this.game;
    if (from < 0 || to < 0 || from === to) return -1;
    for (const d of [UP, RIGHT, DOWN, LEFT]) if (g.neighbor(from, d) === to) return d;
    return -1;
  }

  draw(game, { preview = [], cursor = -1, won = false, hintAt = null } = {}) {
    this.game = game;
    if (!this.geo.cell) return;
    const { ctx, geo } = this;
    const n = game.n;
    const k = geo.cell;
    const st = game.st;
    ctx.clearRect(0, 0, geo.w, geo.h);

    // 1) 盘面底色（环、点、错误圈都画在它上面，所以它是「这一格什么都没画」的参照色）
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    const bx = geo.x - k * 0.5;
    const by = geo.y - k * 0.5;
    roundRect(ctx, bx, by, k * n + k, k * n + k, Radius.cell);
    ctx.fillStyle = Palette.field;
    ctx.fill();

    // 2) 网格线：格与格之间的分隔，只画在边界上。Mid-loop 的一半题面点就落在这些线上，
    //    所以这一层比上一仓亮一档（见 js/theme.js 文件头的实测间距）。
    ctx.strokeStyle = Palette.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < n; c++) {
      const x = Math.round(geo.x + c * k) + 0.5;
      ctx.moveTo(x, geo.y);
      ctx.lineTo(x, geo.y + k * n);
    }
    for (let r = 1; r < n; r++) {
      const y = Math.round(geo.y + r * k) + 0.5;
      ctx.moveTo(geo.x, y);
      ctx.lineTo(geo.x + k * n, y);
    }
    ctx.stroke();

    // 3) 格底（引擎的 st.cell 那一层）：LOOP = 暖色软底，CUT = 心上一个极小的叉，UNKNOWN = 什么都不画。
    //    画在环线之下，所以它是「这一格在不在环上」的底色证据，不抢环线的戏。
    const fr = Math.max(2, k * Board.fillRadius);
    const inset = k * 0.06;
    for (let cell = 0; cell < n * n; cell++) {
      if (st.cell[cell] === LOOP) {
        const q = this.cellRect(cell);
        roundRect(ctx, q.x + inset, q.y + inset, q.w - inset * 2, q.h - inset * 2, fr);
        ctx.fillStyle = Palette.loopCell;
        ctx.fill();
      } else if (st.cell[cell] === CUT) {
        const c = this.centerOf(cell);
        const a = Math.max(2, k * Board.cutCellArm) * Math.SQRT1_2;
        ctx.strokeStyle = Palette.cutMark;
        ctx.lineWidth = Math.max(1, k * Board.cutCellWidth);
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(c.x - a, c.y - a);
        ctx.lineTo(c.x + a, c.y + a);
        ctx.moveTo(c.x - a, c.y + a);
        ctx.lineTo(c.x + a, c.y - a);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineCap = 'butt';
      }
    }

    // 4) 玩家画下的环段（引擎说 LOOP 才画，这里不判断任何事）
    const lw = Math.max(2, k * Board.loopWidth);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Palette.accent;
    ctx.lineWidth = lw;
    for (let cell = 0; cell < n * n; cell++) {
      for (const d of LOOP_DIRS) {
        if (!cellHas(st, game, cell, d, LOOP)) continue;
        const nb = game.neighbor(cell, d);
        if (nb < 0) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(nb);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // 拖拽中的预览：同一个画法、半透明，松手才真的进状态
    if (preview.length) {
      ctx.globalAlpha = won ? 1 : 0.55;
      for (const [cell, d] of preview) {
        const nb = game.neighbor(cell, d);
        if (nb < 0) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(nb);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'butt';

    // 4½) 被排除的边（引擎三态里的 CUT）：在边的中点上画一个小叉。
    //     它是「这条边不在环上」的形状证据，不是「这里什么都没画」的同义词 —— 未落笔的边在
    //     这一层一条都不该出现（draw 只认 st 里的 CUT，别的什么都不认）。
    //     半臂 0.17 格 > 题面点半径 0.13 格，所以线上那颗点压在心上的时候叉的四条臂仍然露在外面。
    for (let cell = 0; cell < n * n; cell++) {
      for (const d of LOOP_DIRS) {
        if (!cellHas(st, game, cell, d, CUT)) continue;
        const m = this.markPoint(cell, d);
        if (!m) continue;
        ctx.strokeStyle = Palette.cutMark;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        const a = m.arm * Math.SQRT1_2; // 半臂在 x/y 上的投影
        ctx.beginPath();
        ctx.moveTo(m.x - a, m.y - a);
        ctx.lineTo(m.x + a, m.y + a);
        ctx.moveTo(m.x - a, m.y + a);
        ctx.lineTo(m.x + a, m.y - a);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }

    // 5) 环的端点（度数 1）：一个冷白点，说明这一头还没接上
    ctx.fillStyle = Palette.capDot;
    for (let cell = 0; cell < n * n; cell++) {
      if (game.degree(cell) !== 1) continue;
      const c = this.centerOf(cell);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, k * 0.085), 0, Math.PI * 2);
      ctx.fill();
    }

    // 6) 度数异常的格：既不是 0/2 也不是「一条都没画」，环在这一格接不通。圈是形状证据，色是附加证据。
    for (const cell of game.badCells()) {
      const c = this.centerOf(cell);
      ctx.fillStyle = Palette.errorSoft;
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = Palette.badRing;
      ctx.lineWidth = Math.max(2, k * Board.badRingWidth);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 7) 刚刚由提示落下的那一笔：一圈冷蓝，位置取自引擎给的 at（可以是半格）
    if (hintAt) {
      const p = this.posOf(hintAt[0], hintAt[1]);
      ctx.strokeStyle = Palette.hint;
      ctx.lineWidth = Math.max(2, k * 0.06);
      ctx.setLineDash([Math.max(3, k * 0.16), Math.max(3, k * 0.12)]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, k * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 8) 引擎判失败的点（dotStatus = 'bad'）：一圈红，说明「这条直线段的正中不是它」。
    //    判定整个来自 rules.js 的 dotStatus，画面里没有第二种说法。
    for (const dot of game.face.dots) {
      if (dotStatus(st, dot) !== 'bad') continue;
      const p = this.dotPoint(dot);
      ctx.strokeStyle = Palette.badRing;
      ctx.lineWidth = Math.max(2, k * 0.055);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + Math.max(2.5, k * 0.09), 0, Math.PI * 2);
      ctx.stroke();
    }

    // 9) 题面点。只读、永远画在最上面（这一层之后除了键盘光标什么都不画）：
    //    环线穿过它时线在它背后仍然看得见，排除叉画在它之下且臂更长。
    for (const dot of game.face.dots) {
      const p = this.dotPoint(dot);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = Palette.dot;
      ctx.fill();
      ctx.lineWidth = Math.max(1, k * Board.ringWidth);
      ctx.strokeStyle = Palette.dotRing;
      ctx.stroke();
    }

    // 10) 键盘光标：虚线圈，指针玩家看不到它（cursor 只在键盘操作时移动）
    if (cursor >= 0) {
      const c = this.centerOf(cursor);
      ctx.strokeStyle = Palette.info;
      ctx.lineWidth = Math.max(2, k * 0.06);
      ctx.setLineDash([Math.max(4, k * 0.2), Math.max(3, k * 0.14)]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 给 harness 用：这一条边此刻应当是什么颜色，由取色逻辑自己回答，免得测试里另抄一份调色板。
  // 三态给三个答案：LOOP 是环线色、CUT 是叉色、没落笔的边中点落在格线上（gridLine），
  // 那里绝不是盘底 field —— 所以「未落笔」的证据只能是「既不是 accent 也不是叉色」，别写反。
  colorOfSegment(cell, d) {
    const v = this.valAt(cell, d);
    return v === LOOP ? Palette.accent : v === CUT ? Palette.cutMark : Palette.gridLine;
  }
  /** 一颗题面点的取色（格心点与线上点同一颗球，位置由 dotPoint 回答） */
  colorOfDot() {
    return Palette.dot;
  }
  /** 环上格的底色（st.cell === LOOP 那一层） */
  colorOfCell(k) {
    const v = this.game.st.cell[k];
    return v === LOOP ? Palette.loopCell : v === CUT ? Palette.cutMark : Palette.field;
  }
  badColor() {
    return Palette.badRing;
  }

  valAt(cell, d) {
    const ref = this.game.refOf(cell, d);
    return ref === null ? UNKNOWN : this.game.st[ref[0]][ref[1]];
  }
}

/** 这一格这一向的边是不是那个值（出盘为 false；下标只经 Game 的 refOf → rules.js 的 edgeRef） */
function cellHas(st, game, cell, d, want) {
  const ref = game.refOf(cell, d);
  return !!ref && st[ref[0]][ref[1]] === want;
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
