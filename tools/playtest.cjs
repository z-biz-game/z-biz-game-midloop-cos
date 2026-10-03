// 真浏览器门禁的 node 侧：headless Chrome + 裸 CDP（Node 22 的全局 WebSocket/fetch，零依赖）。
//
// env: CDP_PORT（devtools 端口，默认 9381）、BASE_URL（页面 origin，默认 http://127.0.0.1:5281/）、
//      WITNESS（nav 之前由 witness 命令抄下来的证人 json）、
//      GATE_SELFTEST=1（每一份报告都种一条注定错的期望——scenarios.js 一份，node 侧的
//      leg / nav / reload 由这里的 result() 一份，同一条规矩）
//
//   node tools/playtest.cjs open <url>              开一页，打印 boot 日志
//   node tools/playtest.cjs eval '<expr>' [nonav]   求值（await promise）并打印
//   node tools/playtest.cjs scenario <name>         注入 tools/scenarios.js，跑 __ng.<name>()
//   node tools/playtest.cjs witness                 在派发任何导航**之前**抄证人
//   node tools/playtest.cjs nav <url> same|fresh    导航 + 断言到底换没换文档
//   node tools/playtest.cjs reload                  真重载 + 断言旧文档真的死了
//   node tools/playtest.cjs leg mouse|touch|keys    真事件（Input.dispatch*）驱动的输入腿
//   node tools/playtest.cjs shot <file.png> / logs
//
// 附着到哪一页由 BASE_URL 的 origin 决定，绝不写死端口号：一条 eval 悄悄落在 about:blank 上，
// 读起来像是"部署坏了"，实际上测的根本不是本页。
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9381);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5281/';
const ORIGIN = new URL(BASE).origin;
const SELFTEST = process.env.GATE_SELFTEST === '1';
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];
const rows = [];
const ck = (test, cond, detail) => rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
const result = (extra) => {
  // 阴性自证要覆盖 node 侧的腿：真事件（leg mouse/touch/keys）与 nav/reload 的报告不经过
  // scenarios.js 的 report()，不在这里也种一条的话，这几条腿就永远是"没能红过的绿"。
  if (SELFTEST) rows.push({ test: 'GATE_SELFTEST 种下的错期望（1 应当等于 2）', pass: 1 === 2, detail: 'planted red' });
  return { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
};
const out = (extra) => {
  const r = result(extra);
  if (logs.length) console.error(logs.slice(-40).join('\n'));
  // 日志在前、机器可读的行在最后：verify.sh 的解析器取最后一行 RESULT，
  // 于是日志里冒出一个 '{' 也劫持不了报告。
  console.log('RESULT ' + JSON.stringify(r));
};
const evidence = (o) => console.log('EVIDENCE ' + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' '));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* 还没绑上 */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* 已经没了 */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  // 文档身份由门禁自己种，页面代码一个字都不改：每个文档一个随机号。
  // 片段导航（只差 #hash）不换文档所以它必须不变，真重载一定变。
  const { identifier: markId } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__gateDoc='d'+Math.random().toString(36).slice(2,10);`,
  }, sessionId);
  const unmark = async () => {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: markId }, sessionId).catch(() => {});
  };

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify((${expression}))`));

  const ready = async () => {
    for (let i = 0; i < 160; i++) {
      const s = await evaluate('document.readyState').catch(() => 'loading');
      if (s === 'complete') return;
      await sleep(100);
    }
  };
  // 页面自己说它开完机了（boot 把 midloop.state 从 'booting' 翻成 'ready'）：出题是同步的
  // 几百毫秒，不等这一位就会把「还没盘」读成「页面坏了」。
  const appReady = async () => {
    for (let i = 0; i < 200; i++) {
      const s = await evaluate('window.midloop?window.midloop.state:null').catch(() => null);
      if (s === 'ready') return true;
      await sleep(50);
    }
    return false;
  };
  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await ready();
    await appReady();
    await sleep(150);
  };
  // 只差一个 hash 的 URL 是 same-document navigation：Page.navigate 过去并不会换文档。
  // 所以"这一腿必须落在新文档里"的走 Page.reload，URL 真的不同才用 navigate。
  const gotoFresh = async (url = BASE) => {
    const cur = String(await evaluate('location.href').catch(() => ''));
    const cut = (u) => u.split('#')[0];
    if (cur && cut(cur) === cut(url)) {
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await ready();
      await appReady();
      await sleep(150);
    } else {
      await navigate(url);
    }
  };
  // 输入腿要的是一块「我说了算」的盘。续局存档会让这一腿在别人的局面上起跑：同一份 profile 里
  // 连跑两次键盘腿，第二次的开局步数读回来是 8（上一腿留下的），于是每一行期望值都跟着漂，
  // 红的到底是页面还是账本就分不清了。所以：先摘掉续局、把这一文档的落盘口封住
  //（pagehide 会把它自己那一局写回去），再真导航一次 —— 新文档没有 pendingResume，开的是空盘 0 步。
  const freshBoard = async () => {
    const seal = () => evaluate(`(()=>{const s=window.midloop.store;s.clearResume();
      s.save=function(){return this.data;};s.saveResume=function(){return this.data;};return 1;})()`);
    await gotoFresh(BASE);
    if (!(await appReady())) throw new Error('页面在 ' + BASE + ' 上始终没把 midloop.state 翻到 ready');
    // 旧文档：摘掉它续着的局，并让它自己别在 pagehide 时把那局再写回去。
    await seal();
    await gotoFresh(BASE);
    if (!(await appReady())) throw new Error('摘掉存档之后第二次开机没开完（midloop.state 不是 ready）');
    // 新文档也封口：这一腿落的笔不留给下一条腿，否则同一条命令第二次跑就换了起跑的盘。
    await seal();
  };
  const docInfo = () =>
    evaluate(`(()=>{const m=window.midloop;return {url:location.href,to:performance.timeOrigin,
      doc:window.__gateDoc||'(harness 没种上文档身份)',state:m?m.state:'(no window.midloop)',
      boot:!!(m&&m.state==='ready'),seed:m&&m.game?m.game.seed:'',sizeKey:m&&m.game?m.game.sizeKey:''};})()`)
      .catch((e) => ({ url: 'unknown', to: 0, doc: 'ERR:' + e.message, boot: false, state: 'ERR' }));

  // ---------- 页内几何：先量 hit box，再谈"点得到" ----------

  const PREP = `(()=>{
    const m=window.midloop,v=m.view,g=m.game,en=m.engine;
    if(!g) throw new Error('页面上还没有盘（window.midloop.game 是空的）');
    const rect=v.canvas.getBoundingClientRect();
    const at=(x,y)=>{const e=document.elementFromPoint(x,y);return e?(e.id||e.tagName):'null';};
    const n=g.n;
    const o={rect:{l:rect.left,t:rect.top,w:rect.width,h:rect.height},iw:innerWidth,dpr:devicePixelRatio,
      seed:g.seed,sizeKey:g.sizeKey,n:n,dots:g.puzzle.dots.length,marksLength:en.marksLength(n),
      btns:[],cells:[],edges:[],sweepTotal:n*n,sweepHits:0,sweepMiss:0};
    for(let k=0;k<n*n;k++){const pp=v.centerOf(k);const x=rect.left+pp.x,y=rect.top+pp.y;
      if(at(x,y)==='board')o.sweepHits++;else o.sweepMiss++;}
    for(const k of [0,1,2,3,n,n*n-1]){const pp=v.centerOf(k);const x=rect.left+pp.x,y=rect.top+pp.y;
      o.cells.push({k:k,r:(k/n)|0,c:k%n,x:x,y:y,hit:at(x,y)});}
    // 每一条要被指针压的边：先由 (a,方向) 算出 ref，再问页面 hitEdge 同一个点得到的是哪条 ref。
    // 两者必须是同一条边——否则"我点到了那条边"这句话只是 node 侧的一厢情愿。
    const specs=[{name:'e01',a:0,b:1},{name:'e0n',a:0,b:n},{name:'e23',a:2,b:3},{name:'e1n1',a:1,b:n+1}];
    for(const s of specs){
      const d=v.dirFromTo(s.a,s.b);
      const refA=en.edgeRef(n,(s.a/n)|0,s.a%n,d);
      const pp=v.midpointOf(s.a,s.b);
      const x=rect.left+pp.x,y=rect.top+pp.y;
      const h=v.hitEdge(x,y);
      const refB=h?en.edgeRef(n,(h.cell/n)|0,h.cell%n,h.d):null;
      const same=!!(refA&&refB&&refA[0]===refB[0]&&refA[1]===refB[1]);
      o.edges.push({name:s.name,a:s.a,b:s.b,d:d,arr:refA?refA[0]:'-',idx:refA?refA[1]:-1,
        id:refA?en.edgeId(g.st,refA[0],refA[1]):-1,sameRef:same,x:x,y:y,hit:at(x,y)});
    }
    for(const id of ['btn-hint','btn-check','btn-undo','btn-clear','btn-new','btn-mode-loop','btn-mode-cut','btn-mode-erase']){
      const e=document.getElementById(id);
      if(!e){o.btns.push({id:id,x:-1,y:-1,hit:'MISSING',w:0,h:0});continue;}
      // 控件先滚到视口中央再量：窄屏（390x844）下靠下的按钮本来就在折叠线以下，
      // "中心落在自己上"这句话在 scroll 0 的位置上讲是苛求，玩家会滚。滚上去之后还点不到，
      // 才是真的坏了。量完一律滚回顶部，盘面的坐标不受影响。
      e.scrollIntoView({block:'center',inline:'center'});
      const b=e.getBoundingClientRect();const x=b.left+b.width/2,y=b.top+b.height/2;
      const t=document.elementFromPoint(x,y);
      o.btns.push({id:id,x:x,y:y,hit:t?(t.id||t.tagName):'null',w:Math.round(b.width),h:Math.round(b.height),
        inSelf:!!t&&(t.id===id||e.contains(t))});}
    window.scrollTo(0,0);
    const sp=document.getElementById('size-picker');
    o.sizeBtns=sp?[].slice.call(sp.querySelectorAll('button')).map(function(b){
      const r=b.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2;
      const e=document.elementFromPoint(x,y);
      // 命中"自己或自己的子孙"就算点得到：档位按钮里包着 <span>（副标题），
      // elementFromPoint 拿到的是那枚 span，而 click 照样冒泡到 button。
      return {key:b.dataset.size,disabled:b.disabled,pressed:b.getAttribute('aria-pressed'),
        reachable:(!!e&&b.contains(e))||(!!e&&e.id===b.id),hit:e?(e.id||e.tagName):'null',
        w:Math.round(r.width),h:Math.round(r.height)};
    }):[];
    return o;})()`;

  // 手机视口下的整屏普查（只在 touch 腿里跑）：可见控件 = 有盒、没被 display/visibility/opacity
  // 藏起来、也没被 pointer-events:none 弃权。逐个量 44px 下限，再滚进视野中央验命中盒。
  const PHONE_AUDIT = `(()=>{
    const de=document.documentElement;
    const name=(e)=>e.id?('#'+e.id):((e.className&&typeof e.className==='string'
      ? e.className.trim().split(/\\s+/)[0]+':' : '')+e.tagName.toLowerCase());
    const vis=(e)=>{const r=e.getBoundingClientRect();const cs=getComputedStyle(e);
      return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'
        &&parseFloat(cs.opacity)>0&&cs.pointerEvents!=='none';};
    const all=[].slice.call(document.querySelectorAll(
      'button,select,input,textarea,a[href],[role=button]')).filter(vis);
    // 44px 是外壳控件（按钮、开关、输入框）的下限。盘上的格子跟着视口活：一张 9x9 在 320px
    // 上只有 36px，硬套下限等于逼着盘面横向出屏——那才是手机上真正的"点不到"。
    // 所以盘内不参与 44px 判定，但要报数：读得出盘内有几格、最小边多少，才看得出排除有没有把
    // 外壳也一起吞掉（吞掉的话 chrome 数当场变零，那条断言就红）。
    const inBoard=(e)=>!!(e.closest&&e.closest('#board, .board, [data-board]'));
    const chrome=all.filter((e)=>!inBoard(e));
    const cells=all.filter(inBoard);
    const tooSmall=[],unclickable=[];
    for(const e of chrome){
      const r=e.getBoundingClientRect();
      if(r.width<44||r.height<44) tooSmall.push({id:name(e),w:Math.round(r.width),h:Math.round(r.height)});
      e.scrollIntoView({block:'center',inline:'center'});
      const b=e.getBoundingClientRect();
      if(b.right>de.clientWidth+1||b.left<-1){unclickable.push({id:name(e),hit:'OFFSCREEN'});continue;}
      const t=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
      if(!t||!(t===e||e.contains(t)||t.contains(e))) unclickable.push({id:name(e),hit:t?(t.id||t.tagName):'null'});
    }
    window.scrollTo(0,0);
    const cellMin=cells.length?Math.round(Math.min.apply(null,cells.map((e)=>{const r=e.getBoundingClientRect();
      return Math.min(r.width,r.height);}))):null;
    return {scrollW:de.scrollWidth,clientW:de.clientWidth,ctl:chrome.length,boardCells:cells.length,
      cellMin:cellMin,tooSmall:tooSmall,unclickable:unclickable};})()`;

  // 盘的当前事实：笔迹串 + 引擎数出来的那几个形状量 + 门面报的笔/光标/锚点。
  const STATE = `(()=>{const m=window.midloop,g=m.game,en=m.engine;
    const s=g.encode();let nz=0;for(let i=0;i<s.length;i++)if(s[i]!=='0')nz++;
    return {marks:s,nz:nz,moves:g.moves,undo:g.undoStack.length,unknown:en.unknownCount(g.st),segs:g.loopEdges().length,
      cuts:g.cutEdges().length,ends:g.endpoints().length,bad:g.badCells().length,
      onloop:g.loopCells().length,mode:m.mode,cursor:m.cursor,anchor:m.anchor,won:m.won,
      seed:g.seed,sizeKey:g.sizeKey,fp:g.puzzle.fingerprint,n:g.n,
      doc:window.__gateDoc||'',to:performance.timeOrigin};})()`;

  const DOMTXT = `(()=>{const t=function(s){const e=document.querySelector(s);return e?(e.textContent||'').trim():''};
    const shown=function(s){const e=document.querySelector(s);if(!e)return false;
      return getComputedStyle(e).display!=='none'&&e.getClientRects().length>0;};
    return {seed:t('#stat-seed'),time:t('#stat-time'),dots:t('#stat-dots'),onloop:t('#stat-onloop'),
      segs:t('#stat-segs'),cuts:t('#stat-cuts'),ends:t('#stat-ends'),bad:t('#stat-bad'),
      moves:t('#stat-moves'),verify:t('#stat-verify'),verifyLine:t('#verify-line'),state:t('#state-line'),
      sr:t('#sr-cell'),veil:shown('#win-veil'),vlist:shown('#verify-list'),
      vli:document.querySelectorAll('#verify-list li').length,
      active:document.activeElement?(document.activeElement.id||document.activeElement.tagName):'null',
      pressed:[].slice.call(document.querySelectorAll('#btn-mode-loop,#btn-mode-cut,#btn-mode-erase'))
        .map(function(b){return b.id+'='+b.getAttribute('aria-pressed');}).join(','),
      sizePressed:[].slice.call(document.querySelectorAll('#size-picker button'))
        .map(function(b){return b.dataset.size+':'+b.getAttribute('aria-pressed')+':'+b.disabled;}).join(','),
      newLabel:(document.getElementById('btn-new')||{}).textContent||'',
      newDisabled:!!(document.getElementById('btn-new')||{}).disabled};})()`;

  const VALS = (spec) =>
    `(()=>{const g=window.midloop.game,S=${JSON.stringify(spec)},o={};for(const k in S){o[k]=g.st[S[k][0]][S[k][1]];}return o;})()`;

  // ---------- 真事件：每条腿只发自己那一种通道 ----------
  // mouse 腿发鼠标、touch 腿发触屏，两条腿跑同一份步骤脚本。于是一条断言在两种事件下各跑一次，
  // 而且不会出现"鼠标腿其实也替触屏按了一遍"的假证据。

  const mouseTap = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(80);
  };
  const mouseRight = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }, sessionId);
    await sleep(80);
  };
  const mouseDrag = async (pts) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[0].x, y: pts[0].y }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts[0].x, y: pts[0].y, button: 'left', clickCount: 1 }, sessionId);
    for (let i = 1; i < pts.length; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[i].x, y: pts[i].y }, sessionId);
      await sleep(30);
    }
    const last = pts[pts.length - 1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(90);
  };
  const touchTap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(90);
  };
  const touchDrag = async (pts) => {
    const tp = (q) => [{ x: q.x, y: q.y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) }, sessionId);
    await sleep(40);
    for (let i = 1; i < pts.length; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(pts[i]) }, sessionId);
      await sleep(40);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(90);
  };
  const tap = async (x, y) => (arg === 'touch' ? touchTap(x, y) : mouseTap(x, y));
  const drag = async (pts) => (arg === 'touch' ? touchDrag(pts) : mouseDrag(pts));

  // 派发之前当场重新量一次坐标：腿里会为了点一个靠下的按钮而滚动，滚完画布的 client 坐标
  // 就不是 PREP 那一刻的值了。拿旧坐标去点，红的是我的账本而不是页面。
  const cellXY = async (k) => json(`(()=>{window.scrollTo(0,0);const v=window.midloop.view,rc=v.canvas.getBoundingClientRect();
    const p=v.centerOf(${k});return {x:rc.left+p.x,y:rc.top+p.y};})()`);
  const edgeXY = async (a, b) => json(`(()=>{window.scrollTo(0,0);const v=window.midloop.view,rc=v.canvas.getBoundingClientRect();
    const p=v.midpointOf(${a},${b});return {x:rc.left+p.x,y:rc.top+p.y};})()`);
  const btnXY = async (id) => json(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
    e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();
    const x=b.left+b.width/2,y=b.top+b.height/2;const t=document.elementFromPoint(x,y);
    return {x:x,y:y,hit:t?(t.id||t.tagName):'null',inSelf:!!t&&(t.id===${JSON.stringify(id)}||e.contains(t))};})()`);
  const press = async (id) => {
    const q = await btnXY(id);
    ck(`press ${id}：滚到视口里之后中心确实点得到自己`, q.inSelf, `${q.hit} @ ${Math.round(q.x)},${Math.round(q.y)}`);
    await tap(q.x, q.y);
    return q;
  };
  const swipe = async (ks) => {
    const pts = [];
    for (const k of ks) pts.push(await cellXY(k));
    await drag(pts);
  };

  const KEYMAP = {
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39], Enter: ['Enter', 13], Backspace: ['Backspace', 8],
    e: ['KeyE', 69], h: ['KeyH', 72], c: ['KeyC', 67], z: ['KeyZ', 90], q: ['KeyQ', 81],
  };
  const key = async (k) => {
    const [code, wvk] = KEYMAP[k];
    const text = k.length === 1 ? k : undefined;
    // 绝不给 nativeVirtualKeyCode：macOS 上 Chrome 把它当平台原生键码，于是这只键被 raw
    // keyboard 路径反复补发（隔壁仓实测：带它的 520ms 里到达 3664 次 keydown，只带
    // windowsVirtualKeyCode 的是 1 次）。让 Chrome 自己从 wvk 推原生键码，一次派发 = 一次按键。
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: wvk }, sessionId);
    if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, key: k, code, windowsVirtualKeyCode: wvk }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: wvk }, sessionId);
    await sleep(70);
  };

  // ---------- commands ----------

  if (cmd === 'open') {
    await navigate(arg || BASE);
    const d = await docInfo();
    evidence({ url: d.url, timeOrigin: d.to, doc: d.doc, state: d.state, seed: d.seed, sizeKey: d.sizeKey, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
    await unmark();
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const v = await evaluate(arg);
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
    await unmark();
  } else if (cmd === 'witness') {
    const d = await docInfo();
    // 派发导航之先，证人已经在 node 手里了：续局那条腿要证明的是"新文档"，不是"我按了一次刷新"。
    // 证人同时把"导航前盘面长什么样"抄一份——续局腿要比的是这一份，不是它自己重算的期望。
    const sent = await evaluate(`(()=>{const s=${STATE};window.__gateSentinel='sn'+Math.floor(Math.random()*1e6);
      return window.__gateSentinel+'|'+s.seed+'|'+s.marks.length;})()`);
    const snap = await json(STATE);
    const stored = await json(`(()=>{const r=window.midloop.store.pendingResume();
      return r?{seed:r.seed,sizeKey:r.sizeKey,marks:r.marks,moves:r.moves,fingerprint:r.fingerprint}:null;})()`);
    await appReady();
    evidence({ url: d.url, timeOrigin: d.to, doc: d.doc, sentinel: sent, seed: snap.seed, marks: snap.marks.length, moves: snap.moves, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    console.log(JSON.stringify({ timeOrigin: d.to, doc: d.doc, url: d.url, sentinel: sent, ...snap, stored }));
    await unmark();
  } else if (cmd === 'nav' || cmd === 'reload') {
    const before = await docInfo();
    const expect = cmd === 'reload' ? 'fresh' : rest;
    const url = cmd === 'reload' ? before.url.split('#')[0] : arg;
    if (cmd === 'reload') await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
    else await cdp.send('Page.navigate', { url: url || BASE }, sessionId);
    await sleep(expect === 'fresh' ? 500 : 350);
    await ready();
    if (expect === 'fresh') await appReady();
    const after = await docInfo();
    evidence({ leg: cmd, expect, urlBefore: before.url, urlAfter: after.url, timeOriginBefore: before.to, timeOriginAfter: after.to, docBefore: before.doc, docAfter: after.doc, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    eq(`${cmd} 之后页面还在同一个 URL 形态`, new URL(after.url).pathname, new URL(url || before.url).pathname);
    ck(`${cmd} 之后应用又起来了（midloop.state 是 ready）`, after.boot, after.state);
    if (expect === 'same') {
      eq('片段导航不算重载：timeOrigin 必须没变', after.to, before.to);
      eq('片段导航不算重载：文档身份必须没变', after.doc, before.doc);
    } else {
      ck('真重载：timeOrigin 必须换了（新文档）', after.to !== before.to, `${before.to} -> ${after.to}`);
      ck('真重载：文档身份必须换了', after.doc !== before.doc, `${before.doc} -> ${after.doc}`);
    }
    out({ before, after, expect });
    await unmark();
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await gotoFresh(BASE);
    await evaluate(`window.__witness=${process.env.WITNESS || 'null'};window.__selftest=${SELFTEST};'ok'`);
    // headless 把页面报成 hidden，而渲染循环被允许在 hidden 时跳帧——所以不把这个 spoof 打上，
    // 一条等动画的场景就会对着一个"假装在后台"的浏览器超时。
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const d = await docInfo();
    evidence({ scenario: arg, url: d.url, timeOrigin: d.to, doc: d.doc, state: d.state, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    const res = await evaluate(`(async()=>{
      if (!window.__ng) throw new Error('scenarios.js never installed');
      if (!window.midloop || window.midloop.state !== 'ready') throw new Error('页面还没开完机（midloop.state=' + (window.midloop ? window.midloop.state : 'no window.midloop') + '）');
      // 报告必须是字符串：把对象交给 returnByValue 只会打印出 "[object Object]"，
      // 于是这一腿看起来跑了、verify.sh 却一行断言都解析不到。
      return JSON.stringify(await window.__ng[${JSON.stringify(arg)}]());
    })()`);
    // 场景看到的是哪一张盘，只能在跑完之后点名：开机那一刻页面可能还续着上一腿留下的存档
    //（这份 profile 是共用的），而场景里每一次 freshPuzzle 都显式 newGame(seed)。
    // 在跑之前读 seed 打出来的就是「gate|save」这种隔壁腿的名字，证据行自己会说谎。
    const dRan = await docInfo();
    evidence({ scenario: arg + ' 上跑的那一张盘', seed: dRan.seed, sizeKey: dRan.sizeKey, state: dRan.state });
    // 每一次注入都在文档上留一份，用完就撤：否则同一个文档里会有第 N 份 scenarios.js 在跑。
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => {});
    await unmark();
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + res);
  } else if (cmd === 'leg') {
    if (arg === 'keys') await keysLeg();
    else await pointerLeg();
  } else if (cmd === 'shot') {
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
    await unmark();
  } else if (cmd === 'logs') {
    if (rest === 'nav') await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
    await unmark();
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);

  // ---------- 指针腿：鼠标 / 触屏同一份步骤，各自只发自己那一种事件 ----------

  async function pointerLeg() {
    await freshBoard();
    if (arg === 'touch') {
      // 覆写必须写在腿自己的调用里，并且腿要能读回证人：另起进程设 Emulation 等于把桌面断言
      // 重跑一遍。所以这里读回 innerWidth/dpr，并把它命名成"覆写在位"，不命名成"这是手机"。
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, sessionId);
      await sleep(400);
    }
    const p = await json(PREP);
    const edgeSpec = {};
    for (const e of p.edges) edgeSpec[e.name] = [e.arr, e.idx];
    // 只报"非零字符有几个"的红说不清是多出来的一条边还是一格影子，所以把落点按布局点名：
    // 笔迹串是先 H、再 V、最后 cell 三段，段长按 marksLength = 2n(n-1) + n² 反推。
    const halfEdge = (p.marksLength - p.n * p.n) / 2;
    const nzPos = (s) => s.split('').map((ch, i) => {
      if (ch === '0') return '';
      const seg = i < halfEdge ? 'H' + i : i < 2 * halfEdge ? 'V' + (i - halfEdge) : 'cell' + (i - 2 * halfEdge);
      return seg + '=' + ch;
    }).filter(Boolean).join(' ');
    const d0 = await docInfo();
    evidence({ leg: arg, url: d0.url, timeOrigin: d0.to, doc: d0.doc, innerWidth: p.iw, dpr: p.dpr, seed: p.seed, sizeKey: p.sizeKey, n: p.n, marksLength: p.marksLength });

    const s0 = await json(STATE);
    eq('hit box：棋盘每一格中心都落在 canvas 上', p.sweepMiss, 0);
    ck(`格中心总数就是 n²（${p.n}²）`, p.sweepHits + p.sweepMiss === p.sweepTotal && p.sweepTotal === p.n * p.n,
      `${p.sweepHits}+${p.sweepMiss}/${p.sweepTotal}`);
    eq('hit box：工具按钮（各自滚进视口后）中心都落在自己或自己的子孙上', p.btns.filter((b) => !b.inSelf).map((b) => b.hit + '@' + b.id).join(','), '');
    ck('按钮都够点（>=34px 高）', p.btns.every((b) => b.h >= 34), JSON.stringify(p.btns.map((b) => b.h)));
    eq('hit box：四个要压的边中点都落在 canvas 上', p.edges.filter((e) => e.hit !== 'board').map((e) => e.name + '=' + e.hit).join(','), '');
    eq('hit box：页面 hitEdge 在同一像素上认出的就是那条边（ref 逐字段相同）', p.edges.filter((e) => !e.sameRef).map((e) => e.name).join(','), '');
    eq('hit box：尺寸菜单里没被禁用的档都点得到（中心命中自己或自己的子孙）', p.sizeBtns.filter((b) => !b.disabled && !b.reachable).map((b) => b.key + '=' + b.hit).join(','), '');
    ck('尺寸菜单的每一档都有可点的面积（>=24px 高）', p.sizeBtns.filter((b) => !b.disabled).every((b) => b.h >= 24), JSON.stringify(p.sizeBtns.map((b) => [b.key, b.h])));
    ck('开局盘面是空的（一格笔迹都没落）', [s0.nz, s0.unknown === p.marksLength, s0.moves], [0, true, 0]);
    if (arg === 'touch') {
      eq('移动覆写在位：innerWidth 读回 390', p.iw, 390);
      eq('移动覆写在位：devicePixelRatio 读回 3', p.dpr, 3);
      ck('窄屏下棋盘仍在视口里', p.rect.l >= 0 && p.rect.w <= p.iw + 1, JSON.stringify({ rect: p.rect, iw: p.iw }));
      // 这一腿代表"玩家真拿手机打开"，所以它审整屏，而不只是我点名要量的那几枚按钮：
      // 44px 是 Apple HIG 的触摸下限（de90401 那次就是被 6 枚点不中的控件逼出来的），
      // 横向溢出与遮挡在手机上都是"看不见/点不到"，不是"挤一点"。竖向出屏不算缺陷——玩家会滚。
      const ph = await json(PHONE_AUDIT);
      ck('手机视口：控件总数不是零（这条腿真的走到了可见控件）', ph.ctl > 0,
        JSON.stringify({ chrome: ph.ctl, boardCells: ph.boardCells, cellMin: ph.cellMin }));
      ck('手机视口：页面不横向溢出（scrollWidth <= clientWidth）', ph.scrollW <= ph.clientW,
        JSON.stringify({ scrollW: ph.scrollW, clientW: ph.clientW }));
      eq('手机视口：可见控件都到 44px 触摸下限',
        ph.tooSmall.map((c) => c.id + ' ' + c.w + 'x' + c.h).join(','), '');
      eq('手机视口：可见控件中心点得到自己（没被遮挡、没横向出屏）',
        ph.unclickable.map((c) => c.id + '=' + c.hit).join(','), '');
    }

    // ① 拖相邻两格 = 一段环边，一次手势 = 一步
    await swipe([0, 1]);
    const s1 = await json(STATE);
    const v1 = await json(VALS(edgeSpec));
    eq('① 拖过 0→1 之后那条边是 LOOP（画环笔）', v1.e01, 1);
    eq('① 一整笔只记一步', s1.moves, s0.moves + 1);
    eq('① 步数在 DOM 里读得到', (await json(DOMTXT)).moves, String(s1.moves));
    ck('① 环上格跟着影子走（两端都在环上）', s1.onloop >= 2, s1.onloop);
    eq('① 已画环段 = 1', s1.segs, 1);
    // 笔迹串是「每条边一个字符 + 每格一个字符」（先 H、再 V、再 cell）：一条环边会带着它的
    // 两个格子一起变成 1，所以非零字符是 3 个而不是 1 个。按位置点出来，比只数一个总数诚实。
    const cellOff = p.marksLength - p.n * p.n;
    ck('① 笔迹串上落的就是这一条边和它的两个影子格',
      [s1.marks[0], s1.marks[cellOff + 0], s1.marks[cellOff + 1], s1.nz].join(',') === '1,1,1,3',
      `串上非零的是 ${nzPos(s1.marks)}`);

    // ② 甩太快：不相邻的两格之间不许多出一条斜边
    const m2 = s1.marks;
    await swipe([0, 2]);
    const s2 = await json(STATE);
    eq('② 不相邻的一甩不写边（笔迹逐字未变）', s2.marks, m2);
    eq('② 不相邻的一甩也不虚记一步', s2.moves, s1.moves);

    // ③ 右键：就动指针压着的那一条边（触屏没有右键，那条路走的是排除叉那支笔）
    if (arg === 'mouse') {
      const q = await edgeXY(0, p.n);
      await mouseRight(q.x, q.y);
      const s3 = await json(STATE);
      const v3 = await json(VALS(edgeSpec));
      eq('③ 右键把 0↔n 那条边画成排除叉', v3.e0n, 2);
      eq('③ 右键自己就是一组：记一步', s3.moves, s2.moves + 1);
      eq('③ 已排除 = 1', s3.cuts, 1);
    } else {
      await press('btn-mode-cut');
      const s3 = await json(STATE);
      eq('③ 触屏腿：切到排除叉那支笔', s3.mode, 'cut');
      await press('btn-mode-loop');
      const v3b = await json(VALS(edgeSpec));
      eq('③ 触屏腿：没有右键可用时那条边仍是未定', v3b.e0n, 0);
    }

    // ④ 三支笔：按钮切换要当着玩家亮起来，切完落的就是那一种笔迹
    await press('btn-mode-cut');
    const dom4 = await json(DOMTXT);
    const s4 = await json(STATE);
    eq('④ 排除叉笔亮着（aria-pressed 三态恰好一个 true）', dom4.pressed, 'btn-mode-loop=false,btn-mode-cut=true,btn-mode-erase=false');
    eq('④ 门面读到的也是这一支', s4.mode, 'cut');
    await swipe([2, 3]);
    const v4 = await json(VALS(edgeSpec));
    const s4b = await json(STATE);
    eq('④ 排除叉那支笔拖过的边写成 CUT', v4.e23, 2);
    eq('④ 一次拖拽 = 一组 = 一步', s4b.moves, s4.moves + 1);

    // ⑤ 擦掉笔：擦的是"这一格引出的所有边"，所以每一处落笔都得各擦一次才算擦干净
    await press('btn-mode-erase');
    await swipe([0]);
    const v5 = await json(VALS(edgeSpec));
    const s5 = await json(STATE);
    eq('⑤ 擦掉笔把 0 号格引出的两条边都收回未定', [v5.e01, v5.e0n].join(','), '0,0');
    eq('⑤ 擦掉一格也算一步', s5.moves, s4b.moves + 1);
    eq('⑤ 收干净之后环段归零', s5.segs, 0);
    ck('⑤ 但 ④ 那一叉还在（擦格不替整盘负责）', [v5.e23, s5.cuts].join(','), '2,1');
    await swipe([2]);
    const v5b = await json(VALS(edgeSpec));
    const s5b = await json(STATE);
    eq('⑤ 再擦 2 号格，那条叉也回未定', v5b.e23, 0);
    eq('⑤ 第二擦同样记一步', s5b.moves, s5.moves + 1);
    ck('⑤ 两处都擦完才真的回到满格未定（unknownCount = marksLength）',
      [s5b.unknown, s5b.nz].join(',') === `${p.marksLength},0`,
      `got ${s5b.unknown},${s5b.nz} / 没被擦回的槽位：${nzPos(s5b.marks)}`);

    // ⑥ 全清：先画两笔再一把抹掉
    await press('btn-mode-loop');
    await swipe([0, 1]);
    await swipe([2, 3]);
    const before6 = await json(STATE);
    await press('btn-clear');
    const s6 = await json(STATE);
    eq('⑥ 全清之后笔迹串一个字都不剩', s6.marks, '0'.repeat(s6.marks.length));
    eq('⑥ 全清把自己也算成一步', s6.moves, before6.moves + 1);
    eq('⑥ 环段/排除/非零笔迹一起清零', [s6.segs, s6.cuts, s6.nz].join(','), '0,0,0');

    // ⑦ 提示：空盘上必须真落下引擎的那一条，并把规则名与理由说给玩家听
    const before7 = await json(STATE);
    await press('btn-hint');
    const dom7 = await json(DOMTXT);
    const s7 = await json(STATE);
    const ruleTexts = await json(`(()=>Object.keys(window.midloop.engine.RULE_TEXT).map(function(k){return window.midloop.engine.RULE_TEXT[k];}))()`);
    ck('⑦ 提示当着玩家写了「规则 —— 理由」', /——/.test(dom7.state) && dom7.state.length > 12, dom7.state);
    ck('⑦ 那句话开头的就是引擎 RULE_TEXT 里的一条', ruleTexts.some((t) => dom7.state.startsWith(t + ' ——')), dom7.state.slice(0, 48));
    eq('⑦ 提示落了一笔（步数 +1）', s7.moves, before7.moves + 1);
    ck('⑦ 未定处因此少了一格', s7.unknown < before7.unknown, `${before7.unknown} -> ${s7.unknown}`);

    // ⑧ 检查：没成的时候要摊开理由，不许盖胜利卡
    await press('btn-check');
    const dom8 = await json(DOMTXT);
    const s8 = await json(STATE);
    const nVerify = Number(String(dom8.verify).replace(/\D/g, ''));
    eq('⑧ 检查没有落笔', s8.moves, s7.moves);
    ck('⑧ 「引擎说」那一格印出了条数（不是"通过"）', /^\d+$/.test(String(nVerify)) && nVerify >= 1, dom8.verify);
    eq('⑧ 按过检查之后理由逐条摊全：列表条数 = 引擎条数', dom8.vli, nVerify);
    eq('⑧ 理由列表此时必须可见', dom8.vlist, 'true');
    ck('⑧ verify-line 引的就是引擎那一句调用', dom8.verifyLine.indexOf(`verify(board, st) → ${nVerify} 条`) >= 0, dom8.verifyLine.slice(0, 60));
    eq('⑧ 没赢就不许盖胜利卡', dom8.veil, 'false');

    // ⑨ 换一局：seed 必须是 mintSeed 的那一颗，不能是按日期算的
    await press('btn-new');
    for (let i = 0; i < 120; i++) {
      const d = await json(DOMTXT);
      if (!d.newDisabled && d.newLabel.indexOf('生成中') < 0) break;
      await sleep(100);
    }
    const s9 = await json(STATE);
    const dom9 = await json(DOMTXT);
    ck('⑨ 换一局换了盘（seed 变了）', s9.seed !== s0.seed, `${s0.seed} -> ${s9.seed}`);
    ck('⑨ seed 不是日期/时间戳（mintSeed 的形状：m<游标>-<12 位 hex>）', /^m[0-9a-z]+-[0-9a-f]{12}$/.test(s9.seed), s9.seed);
    eq('⑨ 新局从空盘开始', s9.marks, '0'.repeat(s9.marks.length));
    ck('⑨ 页面把这一颗 seed 印在界面上', dom9.seed.indexOf(s9.seed) >= 0, dom9.seed);
    ck('⑨ 一整条腿跑下来页面没有崩出 error/exception', logs.filter((l) => /EXCEPTION/.test(l)).length === 0, logs.filter((l) => /EXCEPTION/.test(l)).join(' | '));

    if (arg === 'touch') {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId).catch(() => {});
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
    }
    out({ leg: arg, cells: p.cells.length, buttons: p.btns.length, edges: p.edges.length, n: p.n });
  }

  // ---------- 键盘腿：真 keydown 打进焦点里，逐键各判一次到达与效果 ----------

  async function keysLeg() {
    await freshBoard();
    const p = await json(PREP);
    const edgeSpec = {};
    for (const e of p.edges) edgeSpec[e.name] = [e.arr, e.idx];
    const n = p.n;
    const fullUnknown = p.marksLength;
    const d0 = await docInfo();
    evidence({ leg: 'keys', url: d0.url, timeOrigin: d0.to, doc: d0.doc, innerWidth: p.iw, dpr: p.dpr, seed: p.seed, sizeKey: p.sizeKey, n: p.n });
    eq('键盘腿的盘与 hit box 同一批格', p.sweepMiss, 0);
    // 焦点钉子：先真点一次盘面（页面在 pointerdown 里 canvas.focus()），把键盘事件的目标定在 canvas 上。
    // 坐标必须派发前当场重量：PREP 之后腿里为点靠下的按钮滚过页，拿旧坐标点空了，红的是我的账本不是页面。
    const nail = await cellXY(0);
    await tap(nail.x, nail.y);
    const dom0 = await json(DOMTXT);
    eq('焦点钉在棋盘上（先真点了一次）', dom0.active, 'board');
    // 这一步的账必须先钉死：后面每一行的步数期望都从"点完这一下是 0 步"起算。
    const st0 = await json(STATE);
    eq('先点的那一次不算一步，只把光标落在 0 号格', `${st0.cursor},${st0.anchor},${st0.moves}`, '0,-1,0');
    // 到达计数由门禁自己挂在 window 的捕获阶段，页面代码一个字不改：
    // 捕获先于页面处理器，所以"到达了几次"与"页面处理没处理"是两笔分得开的账。
    await evaluate(`(()=>{window.__keyHits={seen:0,by:{}};
      window.addEventListener('keydown',function(e){window.__keyHits.seen++;
        window.__keyHits.by[e.key]=(window.__keyHits.by[e.key]||0)+1;},true);return 1;})()`);
    const installed = await json(`(()=>({has:!!window.__keyHits,doc:window.__gateDoc||''}))()`);
    ck('到达计数器真的挂在这个文档上', installed.has === true, JSON.stringify(installed));
    eq('先点的那一次不算 keydown', String(await evaluate('window.__keyHits.seen')), '0');

    // 每只键写成「派发 → 期望的盘面读数」。读数把光标/锚点/步数/环段/排除数一起摆上来：
    // 只看步数分不清"画上了"与"什么也没发生"，只数非零又说不清是哪一条边——所以边上还要另读一次边值。
    // 键盘连线的读法就是页面自己那句 aria-label：方向键挪光标（不抹锚点）→ 回车把锚点落在当前格 →
    // 挪到相邻格再回车，那一条才画上；原地再回车什么都不做。
    const seq = [
      { k: 'ArrowRight', read: (s) => `${s.cursor},${s.anchor},${s.moves}`, want: '1,-1,0' },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves},${s.undo}`, want: '1,1,0,0' },
      { k: 'ArrowDown', read: (s) => `${s.cursor},${s.anchor}`, want: `${1 + n},1` },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves},${s.segs}`, want: `${1 + n},${1 + n},1,1`, edge: ['e1n1', 1] },
      { k: 'ArrowUp', read: (s) => `${s.cursor},${s.anchor}`, want: `1,${1 + n}` },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves},${s.segs}`, want: '1,1,1,1' },
      { k: 'ArrowLeft', read: (s) => `${s.cursor},${s.anchor}`, want: '0,1' },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves},${s.segs}`, want: '0,0,2,2', edge: ['e01', 1] },
      { k: 'e', read: (s) => s.mode, want: 'cut' },
      { k: 'ArrowUp', read: (s) => `${s.cursor},${s.anchor}`, want: '0,0' },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves}`, want: '0,0,2' },
      { k: 'ArrowDown', read: (s) => `${s.cursor},${s.anchor}`, want: `${n},0` },
      { k: 'Enter', read: (s) => `${s.cursor},${s.anchor},${s.moves},${s.cuts}`, want: `${n},${n},3,1`, edge: ['e0n', 2] },
      { k: 'z', read: (s) => `${s.moves},${s.cuts}`, want: '4,0' },
      { k: 'z', read: (s) => `${s.moves},${s.segs}`, want: '5,1' },
      { k: 'z', read: (s) => `${s.moves},${s.segs},${s.unknown},${s.nz},${s.undo}`, want: `6,0,${fullUnknown},0,0` },
      { k: 'Backspace', read: (s) => `${s.moves},${s.unknown},${s.undo}`, want: `6,${fullUnknown},0` },
      { k: 'e', read: (s) => s.mode, want: 'erase' },
      // 这一行顺手把界面上那句话读回来：提示写的那一句会被后面的「检查」盖掉，
      // 所以它必须在这一步当场作证，不能等整条腿跑完再翻旧账。
      { k: 'h', read: (s) => String(s.moves), want: '7', dom: (d) => d.state },
      { k: 'c', read: (s) => String(s.moves), want: '7' },
      { k: 'q', read: (s) => `${s.moves},${s.mode}`, want: '7,erase' },
    ];
    // 规则名从引擎的 RULE_TEXT 里取（不是在腿里抄一份中文）：提示那句话必须以此开头。
    const ruleTexts = await json(`(()=>Object.keys(window.midloop.engine.RULE_TEXT).map(function(k){return window.midloop.engine.RULE_TEXT[k];}))()`);
    const per = [];
    for (let i = 0; i < seq.length; i++) {
      const q = seq[i];
      const a = await json('window.__keyHits');
      await key(q.k);
      const s = await json(STATE);
      const b = await json('window.__keyHits');
      // 计数取的是差值：by[key] 是这只键的累计次数，直接读的话第二次按 Enter 会报 2，
      // 看着像"这只键到了两次"，其实是我把台账当成了单次读数。
      per.push({
        i, k: q.k, seen: b.seen - a.seen, by: (b.by[q.k] || 0) - (a.by[q.k] || 0),
        got: q.read(s), want: q.want, edge: q.edge, edgeGot: q.edge ? (await json(VALS(edgeSpec)))[q.edge[0]] : null,
        domGot: q.dom ? q.dom(await json(DOMTXT)) : null,
      });
    }
    for (const q of per) {
      eq(`#${q.i + 1} 按键 ${q.k} 到达游戏一次（keydown 计数）`, `${q.seen} seen/${q.by} total`, '1 seen/1 total');
      eq(`#${q.i + 1} 按键 ${q.k} 之后的盘面读数`, q.got, q.want);
      if (q.edge) eq(`#${q.i + 1} 按键 ${q.k} 之后 ${q.edge[0]} 那条边的值`, q.edgeGot, q.edge[1]);
      if (q.domGot !== null) {
        ck(`#${q.i + 1} 按键 ${q.k} 把引擎那句话当着玩家说了一遍（RULE_TEXT 的那一句 —— 理由）`,
          ruleTexts.some((t) => q.domGot.startsWith(t + ' ——')) && q.domGot.length > 12, q.domGot.slice(0, 48));
      }
    }
    eq(`派发了 ${seq.length} 只键：到达游戏的 keydown 总数`, per.reduce((a, q) => a + q.seen, 0), seq.length);
    const dom = await json(DOMTXT);
    const st = await json(STATE);
    ck('键盘 h 落的确实是一笔（未定处比空盘少）', st.moves === 7 && st.unknown < fullUnknown, `${fullUnknown} -> ${st.unknown}`);
    ck('DOM 统计与状态读的是同一本账', [dom.segs, dom.moves].join(',') === [st.segs, st.moves].join(','), JSON.stringify({ dom: [dom.segs, dom.moves], st: [st.segs, st.moves] }));
    ck('c 与「检查」按钮同一条路：理由摊开了（条数印在「引擎说」里）', /^\d/.test(dom.verify) && Number(dom.verify.replace(/\D/g, '')) >= 1 && dom.vli >= 1, JSON.stringify({ verify: dom.verify, vli: dom.vli }));
    eq('键盘不碰指针：焦点仍在棋盘上', dom.active, 'board');
    // sr-only 那一格是读屏玩家唯一的位置感：光标一动就得跟着说出这一格的行列。
    // 拿状态的 cursor 去对 DOM 文本是两个来源，不是页面自己跟自己对账。
    await key('ArrowRight');
    const domSR = (await json(DOMTXT)).sr;
    const stSR = await json(STATE);
    ck('sr-only 说出光标所在的行列（读屏玩家拿得到）',
      domSR.includes(`第 ${Math.floor(stSR.cursor / n) + 1} 行第 ${stSR.cursor % n + 1} 列`), `${domSR} / cursor=${stSR.cursor}`);
    out({ leg: 'keys', dispatched: seq.length, n: p.n, seed: st.seed });
  }
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (rows.length) console.error('RESULT ' + JSON.stringify(result({ crashed: true })));
  else console.error('RESULT ' + JSON.stringify({ rows: [{ test: `${cmd} ${arg || ''} 整条腿跑挂了`, pass: false, detail: String(err.message || err) }], fail: 1, crashed: true }));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
