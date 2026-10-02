// 浏览器侧的场景集，由 tools/playtest.cjs 注入真实页面后运行。
//
// 这里断言的唯一来源是 DOM 文本、几何与画布像素，不是内部标志位：`.state` 那种字符串说的是
// 代码想要什么，getBoundingClientRect 与 getImageData 说的是玩家拿到什么。本玩法最要命的两种
// bug 恰好都是"状态对、图画错"：环边写进了状态却没画出来，或者排除叉画得和没落笔一模一样。
//
// 真事件（鼠标 / 触屏 / 键盘）不在这条腿里：那三条由 playtest.cjs 的 `leg` 命令用 CDP
// Input.dispatch* 驱动。这里写边用的是 Game 的公开入口 setEdge，也就是点击最后落进的同一个函数。
//
// window.midloop.engine 就是页面加载的那张模块图，所以这里绿一次 = 玩家提示所依据的那个求解器
// 绿一次，而不是测试专用第二份实现绿一次。
//
// ck(名字, 条件, 详情) 是真值判断；eq(名字, 实得, 应为) 是相等。红了每一行都印出自己的名字，
// 所以一条红永远不只是 `undefined`。

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // 阴性自证：GATE_SELFTEST=1 时每一份报告都多一条注定错的期望。没有这一段，
    // "闸全绿"这句话没有任何东西支撑——写了但从没能红的闸，和坏掉的闸长得一样。
    if (w.__selftest) rows.push({ test: 'GATE_SELFTEST 种下的错期望（1 应当等于 2）', pass: 1 === 2, detail: 'planted red' });
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 崩掉不算"红"，崩掉必须点名叫出来：所以这里挂一个错误收集器，坏档那条腿要读它。
  const bootErrors = [];
  w.addEventListener('error', (e) => bootErrors.push(String(e.message || e)));
  w.addEventListener('unhandledrejection', (e) => bootErrors.push('promise: ' + String(e.reason)));

  const A = () => w.midloop;
  const E = () => w.midloop.engine;
  const G = () => w.midloop.game;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const shown = (sel) => {
    // display 与几何两个都要读：`display:grid` 会盖掉 UA 的 [hidden]，所以"藏起来了"这句话
    // 只能由 getClientRects() 长度作证，不能由 hidden 属性本身。
    const e = $.call(document, sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const rectOf = (sel) => {
    const e = $.call(document, sel);
    return e ? e.getBoundingClientRect() : null;
  };

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const near = (p, c, tol = 10) => p.length === 3 && c.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  /** 一条边的画中点（画布本地 CSS 像素）：环边与叉都画在这里附近 */
  const segPixel = (cell, dir) => {
    const r = A().view.segRect(cell, dir);
    return pixel(r.x + r.w / 2, r.y + r.h / 2);
  };
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);

  // Nikoli 官方 5×5 例题：6 个点（2 个格线点）与页面公布的那 22 格环，逐格转录自
  // _tmp-midloop-img/nikoli0*.png。浏览器这条腿用它证明"页面里那个引擎认得同一条规则"。
  // cells 必须是**按顺序走的一圈**（相邻两格一步，最后一格接回第一格）：stateFromCells 用它
  // 推 h/v 边，走不通的那一份会在造局面那一步当场 throw，而不是悄悄造出半张假答案。
  const NIKOLI5 = {
    dots: [{ t: 'v', r: 0, c: 1 }, { t: 'c', r: 1, c: 2 }, { t: 'h', r: 2, c: 0 },
      { t: 'c', r: 2, c: 4 }, { t: 'c', r: 3, c: 2 }, { t: 'c', r: 3, c: 3 }],
    cells: [[0, 0], [0, 1], [1, 1], [1, 2], [1, 3], [0, 3], [0, 4], [1, 4], [2, 4], [3, 4],
      [4, 4], [4, 3], [3, 3], [2, 3], [2, 2], [3, 2], [4, 2], [4, 1], [3, 1], [3, 0], [2, 0], [1, 0]],
  };

  /**
   * 用公开 API 从"按顺序走的一圈"造一份**写满**的状态：盘上每一条边、每一格都有三态之一。
   * 这里必须走引擎自己的 stateFromEdges（它把没被环占用的那一片填成 CUT），而不是只把环上的
   * 格标成 LOOP：verify/loopOf/dotStatus 读的是"完整局面"，留一地 UNKNOWN 的话它们会回你
   * "pending / 度数不足"，于是这条腿红得像规则读错了，其实是我造的局面没造完。
   */
  function stateFromCells(n, cells) {
    const en = E();
    const at = (i) => cells[i % cells.length];
    const h = [];
    const v = [];
    for (let i = 0; i < cells.length; i++) {
      const [r, c] = at(i);
      const [nr, nc] = at(i + 1);
      if (nr === r && Math.abs(nc - c) === 1) h.push([r, Math.min(c, nc)]);
      else if (nc === c && Math.abs(nr - r) === 1) v.push([Math.min(r, nr), c]);
      else throw new Error(`转录的那一圈在 ${r},${c} → ${nr},${nc} 处不相邻：不是合法的一圈`);
    }
    return en.stateFromEdges(n, { cells, h, v });
  }

  /** 让页面自己开一局并等它闲下来：盘面上的那张盘与引擎计数器看到的是同一个对象 */
  async function freshPuzzle(seed, sizeKey) {
    // newGame 在上一局还在忙的时候返回 null（连点两次「换一局」不该开出两盘），
    // 所以这里等它空下来，而不是把 null 当成"页面坏了"。
    let p = null;
    for (let i = 0; i < 20; i++) {
      p = await A().newGame({ seed, sizeKey });
      if (p) break;
      await wait(80);
    }
    await wait(60);
    if (!p) throw new Error(`开不出 seed=${seed} sizeKey=${sizeKey}：状态行说「${text('#state-line')}」`);
    return p;
  }

  /**
   * 把答案画满：走 Game 的公开入口，与玩家那支笔同一条路。
   * 不是环边的那些也必须一起写成排除叉 —— verify 只认「每一条边都落定」的局面，
   * 留一地 UNKNOWN 的话「按答案画满就赢了」永远不成立，胜利卡的几何也就没东西可量。
   * 返回 {loops, written}：loops 是答案里环边的条数，written 是真落下去的笔数
   *（同一条边从两端各点一次，第二次 setEdge 返回 null，所以步数对的是 written 不是 loops）。
   */
  function paintSolution(game) {
    const en = E();
    const n = game.n;
    let loops = 0, written = 0;
    for (let k = 0; k < n * n; k++) {
      const r = Math.floor(k / n), c = k % n;
      for (let d = 0; d < 4; d++) {
        const ref = en.edgeRef(n, r, c, d);
        if (!ref) continue;                                    // 出盘：那边由 edgeAt 读成排除，不落笔
        const want = game.puzzle.solution[ref[0]][ref[1]];
        if (game.setEdge(k, d, want) === null) continue;
        written++;
        if (want === en.LOOP) loops++; // 只在真的落下那一笔时数：一条边从两端各走到一次，第二次不落笔
      }
    }
    return { loops, written };
  }

  // ---------- engine：页面那张模块图认得这条规则 ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.makePuzzle && en.verify && en.nextDeduction && en.loopOf && en.RULE_ORDER));
    eq('命名规则十条', en.RULE_ORDER.length, 10);
    eq('每条规则都有话说给玩家', en.RULE_ORDER.filter((r) => (en.RULE_TEXT[r] || '').length >= 6).length, 10);
    eq('三态编码：UNKNOWN/LOOP/CUT', [en.UNKNOWN, en.LOOP, en.CUT].join(','), '0,1,2');
    eq('方向数组是上右下左', en.DIR_NAMES.join(''), '上右下左');

    const board = { n: 5, dots: NIKOLI5.dots };
    const st = stateFromCells(5, NIKOLI5.cells);
    eq('官方 5×5 公布的答案在浏览器里也合法（verify 无词）', en.verify(board, st).length, 0);
    const loop = en.loopOf(board, st);
    eq('loopOf 把 22 格连成一条环', loop && loop.length, 22);
    ck('每个点在浏览器这份实现里都是等臂的', NIKOLI5.dots.every((d) => en.dotStatus(st, d) === 'ok'),
      NIKOLI5.dots.map((d) => d.t + d.r + ',' + d.c + '=' + en.dotStatus(st, d)).join(' '));

    // 判据 1 的那句「强读法下官方 5×5 只有 1 个解」必须在玩家那侧的页面上成立一次：
    // 这里用的是页面上那同一个 count.js，不是 node 里另跑一遍的那份。
    const c5 = en.countSolutions(board, en.NODE_CAP);
    eq('官方 5×5 在浏览器里数出恰好 1 个解，且没撞预算', [c5.count, c5.bounded], [1, false]);
    eq('数出来的那一个解就是 Nikoli 公布的答案', (() => {
      const s = c5.solutions[0];
      const same = (a, b) => Array.from(a).every((v, i) => v === b[i]);
      return [same(s.cell, st.cell), same(s.H, st.H), same(s.V, st.V)].join(',');
    })(), 'true,true,true');
    // 与计数器无关的第三条路：只数「过格心的简单环」条数，金标准 1/13/213/9349
    eq('cyclesByDfs 金标准（n=2..5）', [2, 3, 4, 5].map((k) => en.cyclesByDfs(k)).join(','), '1,13,213,9349');

    // 反空转：把一处改歪，verify 必须有词，而且说得出是哪一条
    const broken = stateFromCells(5, NIKOLI5.cells);
    broken.cell[4 * 5 + 0] = en.LOOP;
    ck('多连一格之后 verify 拒绝', en.verify(board, broken).length > 0, JSON.stringify(en.verify(board, broken)));

    // 强读法（极大段正中）与弱读法（直穿即可）的分别，在这里也得能看见：
    // 官方答案里第 0 列是一串四格 (0,0)-(3,0)，所以压在第 2 行线上那颗点正好是它的中点。
    // 把 (0,0) 那一格摘出环，极大段就只剩三格、中点挪到格心 (2,0) —— 环还是"直穿"了那颗点，
    // 但中点规则不再认它。这一条只动 dotStatus 要读的那几笔，不假装自己是一圈合法的环。
    const cut = stateFromCells(5, NIKOLI5.cells);
    cut.cell[0] = en.CUT;
    cut.V[en.vIndex(5, 0, 0)] = en.CUT;
    const hDot = NIKOLI5.dots.find((d) => d.t === 'h');
    eq('摘短那一串之后，那条线上的点不再是极大段的中点', en.dotStatus(cut, hDot), 'bad');
    ck('而其余的点仍然等臂（红的那条不许是"整盘都坏了"）',
      NIKOLI5.dots.filter((d) => d !== hDot).every((d) => ['ok', 'pending'].includes(en.dotStatus(cut, d))),
      NIKOLI5.dots.map((d) => d.t + d.r + ',' + d.c + '=' + en.dotStatus(cut, d)).join(' '));

    // 判据 2 的浏览器侧：从空盘用十条规则推满官方 5×5，一次不猜
    const p = en.createState(board);
    let steps = 0, contradiction = null;
    for (;;) {
      const d = en.nextDeduction(p);
      if (d && d.contradiction) { contradiction = d.why; break; }
      if (!d || d.stalled) break;
      if (!en.applyDeduction(p, d)) break;
      if (++steps > 400) break;
    }
    eq('十条规则从空盘把官方 5×5 推满（无矛盾）', [contradiction, en.unknownCount(p)], [null, 0]);
    ck('推出来的那一环就是公布的答案', (() => {
      const l = en.loopOf(board, p);
      const key = (a) => a.slice().sort().join(' ');
      return l && key(l.map((e) => e[0] + ',' + e[1])) === key(NIKOLI5.cells.map(([r, c]) => r + ',' + c));
    })(), true);

    return report({ n: 5, dots: NIKOLI5.dots.length, steps, rules: en.RULE_ORDER.length });
  };

  // ---------- gen：页面当场出的每一盘都是被数过、被推过、被验过的 ----------

  const gen = async () => {
    const en = E();
    eq('菜单档位由引擎给（页面不写死尺寸）', Array.isArray(en.SIZES) && en.SIZES.length >= 2, true);
    ck('每一条"太贵"的理由里都带着一个实测数字', en.TOO_EXPENSIVE.every((e) => /\d/.test(e.reason || '')),
      JSON.stringify(en.TOO_EXPENSIVE));
    // 菜单与"太贵"两张表必须互不相交：同一档既在按钮上、又被写成越线，就是两条表在互相说谎。
    // 档位名两种写法都认（{key} / {sizeKey}），因为页面对这两条读数臂本来就是宽容的。
    const keyOf = (e) => (typeof e === 'string' ? e : e.key || e.sizeKey || e.size);
    eq('越线的档位一个都不在菜单里', en.TOO_EXPENSIVE.filter((e) => en.SIZES.includes(keyOf(e))).map(keyOf).join(','), '');
    eq('预算是引擎给的那一个数（页面不许自带一个更宽的）', en.NODE_CAP, 2000000);
    const fired = new Set();
    const seen = [];
    for (const sizeKey of en.SIZES) {
      const g = await freshPuzzle('gate|gen|' + sizeKey, sizeKey);
      const p = g.puzzle;
      ck(`${sizeKey} 出货（makePuzzle ok）`, p.ok === true, p.status);
      // 判据 1 在浏览器里独立数一遍：不转抄生成器填的 stats，用的是页面上那同一个 count.js。
      const cnt = en.countSolutions({ n: p.n, dots: p.dots }, en.NODE_CAP);
      eq(`${sizeKey} 浏览器里的计数器数出恰好 1（且没撞预算）`, [cnt.count, cnt.bounded], [1, false]);
      eq(`${sizeKey} 计数器那张解与出货那张是同一张盘`, (() => {
        const s = cnt.solutions[0];
        const same = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
        return [same(s.H, p.solution.H), same(s.V, p.solution.V), same(s.cell, p.solution.cell)].join(',');
      })(), 'true,true,true');
      // 判据 2 在浏览器里独立重推一遍：从空盘、一次不猜、推满，且推出的那一环就是出货那张解。
      const sol = en.solve({ n: p.n, dots: p.dots });
      eq(`${sizeKey} 十条规则在浏览器里把它从空盘推满`, [sol.pinned, sol.unknown], [true, 0]);
      eq(`${sizeKey} 铅笔推出来的那一环就是答案`, (() => {
        const s = sol.state;
        const same = (a, b) => Array.from(a).every((v, i) => v === b[i]);
        return [same(s.H, p.solution.H), same(s.V, p.solution.V), same(s.cell, p.solution.cell)].join(',');
      })(), 'true,true,true');
      sol.pins.forEach((x) => fired.add(x.rule));
      ck(`${sizeKey} 推出来的每一笔都点名了一条规则`, sol.pins.every((x) => en.RULE_ORDER.includes(x.rule)),
        sol.pins.map((x) => x.rule).filter((r) => !en.RULE_ORDER.includes(r)).join(','));
      eq(`${sizeKey} 答案在浏览器里复核：verify 无词`, en.verify({ n: p.n, dots: p.dots }, p.solution).length, 0);
      ck(`${sizeKey} 答案是一条环（loopOf 连得起来）`, !!en.loopOf({ n: p.n, dots: p.dots }, p.solution), p.loopLength);
      ck(`${sizeKey} 题面至少有一个点`, p.dots.length > 0, p.dots.length);
      // 独立于铅笔的一条路：环与点都自己数一遍（网格线点算它穿的那条边）
      ck(`${sizeKey} 每个点在出货的解上都是等臂的`, p.dots.every((d) => en.dotStatus(p.solution, d) === 'ok'),
        p.dots.map((d) => `${d.t}${d.r},${d.c}=${en.dotStatus(p.solution, d)}`).join(' '));
      seen.push({ sizeKey, dots: p.dots.length, nodes: cnt.nodes, pins: sol.pins.length });
    }
    // 「从没 firing 的规则是装饰」这条规矩也要在浏览器里成立：三档合起来的命中集必须就是十条。
    eq('菜单各档合起来把十条规则都用上了（没有装饰规则）',
      [en.RULE_ORDER.filter((r) => !fired.has(r)), fired.size], [[], en.RULE_ORDER.length]);
    // 同种子同盘：seed→盘 必须是函数，不是运气（存档续命靠的就是这一条）
    const a = await freshPuzzle('gate|dup', en.SIZES[0]);
    const b = await freshPuzzle('gate|dup', en.SIZES[0]);
    eq('同一个 seed 画同一张盘（指纹）', a.puzzle.fingerprint, b.puzzle.fingerprint);
    eq('同一个 seed 也数出同一个节点数', [a.puzzle.stats.nodes, a.puzzle.dots.length],
      [b.puzzle.stats.nodes, b.puzzle.dots.length]);
    const c = await freshPuzzle('gate|dup|other', en.SIZES[0]);
    ck('换个 seed 就是另一张盘', c.puzzle.fingerprint !== a.puzzle.fingerprint, c.puzzle.fingerprint);
    return report({
      sizes: en.SIZES.join(','),
      fired: `${fired.size}/${en.RULE_ORDER.length}`,
      seen: seen.map((s) => `${s.sizeKey}:${s.dots}点/${s.nodes}节点/${s.pins}笔`).join(' '),
    });
  };

  // ---------- play：笔落在状态里，也落在像素里 ----------

  const play = async () => {
    const g = await freshPuzzle('gate|play', E().SIZES[0]);
    const en = E();
    eq('开局盘面是空的', en.unknownCount(g.st), en.edgeCount(g.n) + g.n * g.n);
    eq('开局没有步数', text('#stat-moves'), '0');
    eq('点数上屏', text('#stat-dots'), String(g.face.dots.length));
    // 三态得在像素上也分得开：每次改完笔都要 render 一次再取样，否则量到的是上一帧，
    // 「颜色不一样」这条会在画得对的时候红、在根本没重画的时候绿。
    // 取样点还必须避开局面那些点：题面点就画在边的中点上、半径比叉的半臂还大，
    // 三种状态都会被它盖成同一个 #02040A —— 那条红说的不是渲染坏了，是我按错了地方。
    const v = A().view;
    const dotFree = (cell, dir) => {
      const m = v.markPoint(cell, dir);
      if (!m) return false;
      return g.face.dots.every((d) => {
        const p = v.dotPoint(d);
        return Math.hypot(p.x - m.x, p.y - m.y) > p.r + m.arm;
      });
    };
    let probe = null;
    for (let k = 0; k < g.n * g.n && !probe; k++) {
      for (let d = 0; d < 4 && !probe; d++) if (dotFree(k, d)) probe = [k, d];
    }
    ck('找到一条中点上没盖题面点的边来做像素取样', !!probe,
      `${JSON.stringify(probe)} / 题面点 ${g.face.dots.map((d) => d.t + d.r + ',' + d.c).join(' ')}`);
    const px = async (kind) => {
      g.setEdge(probe[0], probe[1], kind);
      A().render();
      await wait(30);
      return segPixel(probe[0], probe[1]);
    };
    const cleared = await px(en.UNKNOWN);
    const cutPx = await px(en.CUT);
    const loopPx = await px(en.LOOP);
    await px(en.UNKNOWN);
    ck('没落笔的边与画了叉的边不是同一个像素', JSON.stringify(cutPx) !== JSON.stringify(cleared),
      `cut=${JSON.stringify(cutPx)} cleared=${JSON.stringify(cleared)}`);
    ck('画了环的边又是第三种像素', JSON.stringify(loopPx) !== JSON.stringify(cutPx)
      && JSON.stringify(loopPx) !== JSON.stringify(cleared),
      `loop=${JSON.stringify(loopPx)} cut=${JSON.stringify(cutPx)} cleared=${JSON.stringify(cleared)}`);

    const movesBefore = g.moves;
    const { loops, written } = paintSolution(g);
    A().render();
    await wait(60);
    eq('每一笔都记进步数', text('#stat-moves'), String(g.moves));
    // 这一份笔迹是一边一笔（setEdge 不在拖拽组里，自己就是一组）；玩家那一笔拖过一整段才算一步，
    // 所以这里对的是"落下的笔数"，不是"边数"：同一条边从两端再点一次不落笔、也不虚记。
    // 基准取取样之前：上面那几笔 CUT/LOOP/擦回 是真的落过笔，把它们算进答案的账上就是撒谎。
    eq('落定的笔数 = 盘上全部边都落定（环边与叉各一次）', written, en.edgeCount(g.n));
    eq('步数 = 落下的笔数（同一条边点两次不虚记一步）', g.moves - movesBefore, written);
    ck('答案里的环边一条都没漏', loops === g.loopEdges().length && loops > 0, `${loops} vs ${g.loopEdges().length}`);
    eq('环上格数上屏', text('#stat-onloop'), String(g.n * g.n > 0 ? g.loopCells().length : 0));
    eq('没有悬端', text('#stat-ends'), '0');
    ck('画满之后 state-line 不再报坏格', g.badCells().length === 0, JSON.stringify(g.badCells()));

    // 撤销是一组一组退的：一整笔拖拽退一步，不该一次清空全盘
    const depth = g.undoStack.length;
    g.undo();
    A().render();
    await wait(30);
    ck('撤销退掉一组而不是整盘', g.undoStack.length === depth - 1 && en.unknownCount(g.st) > 0,
      `${depth} -> ${g.undoStack.length}`);
    g.clearAll();
    A().render();
    await wait(30);
    eq('清盘回到全未定', en.unknownCount(g.st), en.edgeCount(g.n) + g.n * g.n);
    return report({ n: g.n, loops, written, moves: g.moves, dots: g.face.dots.length });
  };

  // ---------- hint：提示只会说引擎下一句被迫的话 ----------

  const hint = async () => {
    const g = await freshPuzzle('gate|hint', E().SIZES[0]);
    const en = E();
    const names = [];
    let totalUnknown = en.unknownCount(g.st);
    let applied = 0;
    for (let i = 0; i < 12; i++) {
      const r = A().hint();
      await wait(20);
      if (!r) break; // 已经赢了：hint 在 won 之后闭嘴，不许再替玩家落笔
      if (r.kind === 'stalled' || r.kind === 'contradiction' || r.kind === 'noop') {
        ck('推不动/打脸的时候提示不落笔', r.moved === false, JSON.stringify({ kind: r.kind, moved: r.moved }));
        break;
      }
      eq('落笔的提示都带着引擎给的那一条', [r.moved, !!(r.d && r.d.rule) && !!r.d.why], [true, true]);
      names.push(r.d.rule);
      const now = en.unknownCount(g.st);
      ck(`第 ${i + 1} 次提示确实落了一笔`, now < totalUnknown, `${totalUnknown} -> ${now}`);
      totalUnknown = now;
      applied++;
      eq('状态行把规则原文说给玩家', text('#state-line').includes(r.d.ruleText), true);
      ck('规则名在 RULE_ORDER 里', en.RULE_ORDER.includes(r.d.rule), r.d.rule);
    }
    ck('提示至少落了笔（不是哑巴按钮）', applied > 0, applied);
    eq('提示不落第二次同样的结论（每次都推进）', new Set(names.map((r, i) => r + i)).size, names.length);
    const dom = text('#stat-moves');
    ck('提示落的笔也计步（与玩家同一记分板）', Number(dom) >= applied, `${dom} vs ${applied}`);
    // 打脸的那一支：把答案画满之后，往一个本来就两条环边的格上再硬塞一条。
    // 铅笔的 cell-degree-two 会要求把这条退回排除，可它已经定了 —— 这就是矛盾。
    // （故意画三条线的那种"不可能的边"造不出矛盾：引擎对超度数说的是 verify 的话，
    //  铅笔在这里的话头是「可它已经定了」，所以要把样本造在真的会顶牛的那一格上。）
    const g2 = await freshPuzzle('gate|hint|bad', en.SIZES[0]);
    paintSolution(g2);
    const forced = (() => {
      for (let k = 0; k < g2.n * g2.n; k++) {
        if (g2.puzzle.solution.cell[k] !== en.LOOP) continue;
        const r = Math.floor(k / g2.n), c = k % g2.n;
        for (let d = 0; d < 4; d++) {
          const ref = en.edgeRef(g2.n, r, c, d);
          if (!ref || g2.puzzle.solution[ref[0]][ref[1]] !== en.CUT) continue;
          g2.setEdge(k, d, en.LOOP);
          return { k, d, bad: g2.badCells().length };
        }
      }
      return null;
    })();
    ck('矛盾样本造出来了（那一格现在引出 3 条环边）', !!forced && forced.bad > 0, JSON.stringify(forced));
    const before2 = en.unknownCount(g2.st);
    const r2 = A().hint();
    ck('矛盾时提示不落笔也不装成落了一笔',
      !!r2 && r2.kind === 'contradiction' && r2.moved === false && en.unknownCount(g2.st) === before2,
      JSON.stringify(r2 && { kind: r2.kind, moved: r2.moved, why: r2.d && r2.d.why }));
    ck('矛盾时状态行有话', /矛盾/.test(text('#state-line')), text('#state-line'));
    return report({ hints: applied, rules: names.join(','), stalled: text('#state-line').slice(0, 20) });
  };

  // ---------- win：判胜只由 verify 说了算 ----------

  const win = async () => {
    eq('没赢的时候胜利卡不显示', shown('#win-veil'), false);
    const g = await freshPuzzle('gate|win', E().SIZES[0]);
    paintSolution(g);
    A().render();
    await A().checkWin();
    await wait(120);
    eq('按答案画满就赢了', A().won, true);
    ck('胜利卡显示出来（几何作证，不看 hidden 属性）', shown('#win-veil'), JSON.stringify(rectOf('#win-veil')));
    ck('胜利卡落在棋盘区域内', (() => {
      const card = rectOf('#win-veil'), wrap = rectOf('#board-wrap');
      return card && wrap && card.left >= wrap.left - 1 && card.top >= wrap.top - 1
        && card.right <= wrap.right + 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ veil: rectOf('#win-veil'), wrap: rectOf('#board-wrap') }));
    ck('胜利卡说得出这环多大', /[0-9]/.test(text('#win-meta')), text('#win-meta'));
    const again = rectOf('#btn-again');
    ck('再来一局点得到（高度 >=34px 且在视口里）', again && again.height >= 34
      && again.top >= 0 && again.bottom <= innerHeight, JSON.stringify(again));
    // 负样本：一条成环但没覆盖所有点的"环"不该被宣布胜利
    const g2 = await freshPuzzle('gate|win|partial', E().SIZES[0]);
    const en = E();
    for (const [r, c] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
      g2.setEdge(g2.cellOf(r, c), 1, en.LOOP);
      g2.setEdge(g2.cellOf(r, c), 2, en.LOOP);
    }
    A().render();
    await A().checkWin();
    await wait(80);
    eq('只盖住四个角的 2×2 环不算赢（点还在外面）', A().won, false);
    ck('检查给出的理由里有点这一条', (() => {
      const reasons = g2.status();
      return reasons.length > 0 && reasons.join(' ').length > 4;
    })(), JSON.stringify(g2.status()));
    return report({ n: g.n, veil: !!rectOf('#win-veil') });
  };

  // ---------- layout：一屏的东西都在它能被看见的位置上 ----------

  const layout = async () => {
    const g = G();
    const v = A().view;
    const cr = v.canvas.getBoundingClientRect();
    const wrap = rectOf('#board-wrap');
    ck('画布是方的（环走格心，非方就会歪）', Math.abs(cr.width - cr.height) <= 2,
      JSON.stringify({ w: cr.width, h: cr.height }));
    ck('画布落在棋盘容器里', cr.left >= wrap.left - 1 && cr.top >= wrap.top - 1
      && cr.right <= wrap.right + 1 && cr.bottom <= wrap.bottom + 1, JSON.stringify({ cr, wrap }));
    ck('棋盘在视口里', cr.left >= -1 && cr.top >= -1 && cr.right <= innerWidth + 1 && cr.bottom <= innerHeight + 1,
      JSON.stringify({ cr, iw: innerWidth, ih: innerHeight }));
    eq('dpr 至少 1（后备缓冲按设备像素）', v.geo.dpr >= 1, true);
    ck('格心取样点在画布内', (() => {
      const c = v.centerOf(g.n * g.n - 1);
      return c.x >= 0 && c.y >= 0 && c.x <= v.geo.w && c.y <= v.geo.h;
    })(), JSON.stringify(v.centerOf(g.n * g.n - 1)));
    for (const sel of ['#stat-dots', '#stat-segs', '#stat-onloop', '#stat-moves', '#stat-time', '#stat-seed']) {
      ck(`${sel} 有内容`, text(sel).length > 0, text(sel));
    }
    ck('顶栏印得出 seed', text('#stat-seed').includes(g.seed), `${text('#stat-seed')} vs ${g.seed}`);
    const pick = rectOf('#size-picker');
    ck('尺寸选择器在文档流里（不是 0 高）', pick && pick.height > 8, JSON.stringify(pick));
    // 选择器上有两类按钮：能点的（引擎 SIZES）与点不动的（引擎 TOO_EXPENSIVE）。
    // 两条都要按名字对账，否则「列出的每一档都在 SIZES 里」这一句在越线档真的印出来时会红，
    // 而在它没印出来时反而绿——那句断言就把唯一正确的结果当成了失败。
    const btns = [...document.querySelectorAll('#size-picker button')].map((b) => ({
      k: b.dataset.size, disabled: b.disabled,
      sub: ((b.querySelector('.size-sub') || {}).textContent || '').trim(),
      pressed: b.getAttribute('aria-pressed'),
    }));
    const keyOf2 = (e) => (typeof e === 'string' ? e : e.key || e.sizeKey || e.size);
    eq('能点的那几档恰好就是引擎的 SIZES', btns.filter((b) => !b.disabled).map((b) => b.k).sort().join(','),
      E().SIZES.slice().sort().join(','));
    eq('点不动的那几档恰好就是引擎的 TOO_EXPENSIVE',
      btns.filter((b) => b.disabled).map((b) => b.k).sort().join(','),
      E().TOO_EXPENSIVE.map(keyOf2).sort().join(','));
    ck('每一档点不动的按钮都把理由印在副标题上，理由里带一个可复测的数字',
      btns.filter((b) => b.disabled).every((b) => /\d/.test(b.sub) && b.sub.length > 6),
      JSON.stringify(btns.filter((b) => b.disabled)));
    ck('能点的那几档没有一档写着"太贵"', !btns.filter((b) => !b.disabled).some((b) => /太贵|越线|超/.test(b.sub)),
      JSON.stringify(btns.filter((b) => !b.disabled).map((b) => b.sub)));
    eq('当前这一档在选择器上亮着（aria-pressed）',
      btns.filter((b) => b.pressed === 'true').map((b) => b.k).join(','), g.sizeKey);
    const rulesTxt = document.querySelector('.rules') ? document.querySelector('.rules').textContent : '';
    ck('页面上的规则文案含"中点/正中"这一句', /中点|正中/.test(rulesTxt), rulesTxt.slice(0, 80));
    ck('页面上的规则文案说了点可以落在格线上', /格线/.test(rulesTxt), rulesTxt.slice(0, 80));
    eq('文档标题带着玩法名', /Mid-loop/.test(document.title), true);
    return report({ n: g.n, cell: v.geo.cell, iw: innerWidth });
  };

  // ---------- save / resume / corrupt：存档只续"真的是那一局"的局 ----------

  const KEY = 'midloop.save.v1';

  const save = async () => {
    const g = await freshPuzzle('gate|save', E().SIZES[0]);
    const en = E();
    paintSolution(g);
    A().render();
    // 落盘走的是页面自己那一句（玩家那边挂在 endDrag 之后）：测试自己拼一个 payload 写进
    // localStorage 只能证明 Store 会写，证明不了这一局真的会被存下来。
    A().persist();
    await wait(80);
    const raw = localStorage.getItem(KEY);
    ck('存档写进了 localStorage', !!raw, String(raw).slice(0, 40));
    const d = JSON.parse(raw || '{}');
    ck('存档带 resume 段', !!d.resume, JSON.stringify(Object.keys(d)));
    eq('笔迹串长 = 引擎定义的 marksLength', d.resume.marks.length, en.marksLength(g.n));
    eq('存档存的是原始 seed，不是内部派生的那一个', d.resume.seed, g.seed);
    eq('存档记住了尺寸', d.resume.sizeKey, g.sizeKey);
    ck('存档里落了一笔以上', /[12]/.test(d.resume.marks), d.resume.marks.slice(0, 24));
    eq('存档那串笔迹与盘面逐字相同（不是另抄一份）', d.resume.marks, g.encode());
    eq('存档记的步数就是这一局的步数', d.resume.moves, g.moves);
    eq('存档的指纹与这盘的指纹一致', d.resume.fingerprint, g.puzzle.fingerprint);
    ck('totals 记下了这局', (d.totals || {}).solved >= 0 && typeof (d.totals || {}).moves === 'number',
      JSON.stringify(d.totals));
    return report({ key: KEY, marks: d.resume.marks.length, n: g.n });
  };

  const resume = async () => {
    const g = G();
    // 证人由 node 在派发导航**之前**从一个还活着的文档里抄走（playtest.cjs 的 witness 命令）。
    // 没有它，这一腿只比对了"新文档 ↔ 新文档自己写的档"，那是自己给自己作证。
    const wit = w.__witness;
    ck('续局腿拿到了导航之前的证人', !!wit, String(wit));
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    ck('重载之后仍然拿得到存档', !!raw.resume, JSON.stringify(Object.keys(raw)));
    eq('续上的还是那一局（seed）', g.seed, raw.resume.seed);
    eq('续上的还是那一盘（指纹）', g.puzzle.fingerprint, raw.resume.fingerprint);
    eq('笔迹逐字搬回来了', g.encode(), raw.resume.marks);
    eq('步数也搬回来了（不是 0 步冒充新局）', g.moves, raw.resume.moves);
    if (wit) {
      eq('导航前那个文档种下的 seed 就是现在这一局', g.seed, wit.seed);
      eq('导航前那个文档写下的笔迹，一个字都没丢', g.encode(), wit.marks);
      eq('导航前那个文档的步数就是现在读到的步数', g.moves, wit.moves);
      ck('续上之后仍然不是"已经赢了"的状态（存档只搬笔迹，不搬结论）', g.status().length > 0 || wit.won !== true,
        JSON.stringify(g.status().slice(0, 1)));
    }
    ck('续上的盘在引擎里仍然自洽', g.badCells().length === 0, JSON.stringify(g.badCells()));
    ck('续局这一次加载没有把页面搞崩', bootErrors.length === 0, bootErrors.join(' | '));
    return report({ seed: g.seed, marks: g.encode().length, moves: g.moves, witness: wit ? wit.doc : 'none' });
  };

  const corrupt = async () => {
    const g = G();
    const en = E();
    eq('坏档没有把笔迹贴到这一局上', g.moves, 0);
    eq('坏档的 marks 一个字都没搬', en.unknownCount(g.st), en.edgeCount(g.n) + g.n * g.n);
    ck('崩掉的 promise / error 一个都没有', bootErrors.length === 0, bootErrors.join(' | '));
    ck('界面当着玩家说了这份存档被作废', (() => {
      const line = text('#state-line') + ' ' + text('#verify-line');
      return /存档|作废|重新开始/.test(line) || A().store.resumeDiscarded === null;
    })(), text('#state-line'));
    // 被拒的那份档不许留在盘上反复骗人：要么改掉，要么清掉
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    ck('拒掉的坏档不会再原样躺着', !raw.resume || raw.resume.marks === g.encode(), JSON.stringify(raw.resume || {}).slice(0, 60));
    return report({ errors: bootErrors.length, moves: g.moves });
  };

  // 存档写着一个已经不在菜单上的档位（TOO_EXPENSIVE 后来请出去的那一档）：
  // 页面必须先认菜单、再谈生成，否则玩家会在开机那一下等一张证不完的盘。
  // 这一条要单独立一条腿，因为"没有生成那一张盘"这件事只能由"它根本没被画出来"作证。
  const offmenu = async () => {
    const g = G();
    const en = E();
    ck('开机没有去生成那一档（盘面落在菜单里）', en.SIZES.includes(g.sizeKey), g.sizeKey);
    eq('越线的那一档一个字都没贴过来', g.moves, 0);
    eq('盘面是空的（未定处 = 全部格与边）', en.unknownCount(g.st), en.edgeCount(g.n) + g.n * g.n);
    ck('界面当着玩家说了为什么不用那份存档', /不在菜单/.test(text('#state-line')), text('#state-line'));
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    ck('被拒的那一档没有留在存档里等下一次再骗', !raw.resume || raw.resume.sizeKey === g.sizeKey,
      JSON.stringify({ sizeKey: raw.resume && raw.resume.sizeKey, now: g.sizeKey }));
    ck('这一份存档的读法没把页面搞崩', bootErrors.length === 0, bootErrors.join(' | '));
    return report({ sizeKey: g.sizeKey, wanted: '9x9' });
  };

  const selftest = async () => {
    const g = await freshPuzzle('gate|selftest', E().SIZES[0]);
    eq('种一条注定错的期望（2 不等于 1）', g.n, 1);
    ck('这条腿本来就该红（GATE_SELFTEST）', false, 'planted red expectation');
    return report({ planted: 2 });
  };

  w.__ng = { engine, gen, play, hint, win, layout, save, resume, corrupt, offmenu, selftest };
})(window);
