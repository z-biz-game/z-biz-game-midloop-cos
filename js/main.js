// 接线：DOM、指针、键盘、时钟、存档，以及验收 harness 驱动的 window.midloop 那层门面。
//
// window.midloop.engine 挂的就是页面自己 import 的那张模块图（不是为测试另抄一份），所以
// 门禁在浏览器里绿一次，等于玩家那侧的出题器/推理机同时绿一次。
//
// 这里没有一条 Mid-loop 规则：落笔写进引擎的那两条边数组，赢不赢问 verify()，画什么由
// js/render/board.js 读同一批数字。「提示」也不在这里判断任何事——它只是问 nextDeduction 要一条
// 被迫的结论，把那条结论交给 Game.applyPin（写入走引擎的 applyDeduction），和玩家自己拖的一笔
// 是同一条路、同一本账（撤销栈、moves、存档）。
//
// 本文件必须能被 Node 直接 import：所有 DOM 动作都关在函数里，最后一行才在
// `typeof document !== 'undefined'` 后面开机。所以 `node -e "import('./js/main.js')"` 不 throw。

import { Palette, Space, applyThemeVars, setReduceMotion } from './theme.js';
import { Store } from './store.js';
import { makePuzzle, toView, SIZES, TOO_EXPENSIVE, parseSize } from './engine/generate.js';
import {
  createState, nextDeduction, applyDeduction, RULE_ORDER, RULE_TEXT, unknownCount, solve,
} from './engine/pencil.js';
// 判据 1 的那台计数器也挂在门面上：门禁要在浏览器里独立数一遍这盘有几个解，
// 而不是转抄生成器自己填的 stats（出货用的那张盘正是由它选出来的，见 generate.js）。
import { countSolutions, countSolutionsRowMajor, cyclesByDfs, NODE_CAP } from './engine/count.js';
import {
  verify, edgeRef, edgeId, edgeById, edgeCount, nEdgesH, hIndex, vIndex, cellIndex, loopOf, dotStatus,
  stateFromEdges,
  DR, DC, DIR_NAMES, DOT_KIND_TEXT, UNKNOWN, LOOP, CUT,
} from './engine/rules.js';
import { BoardView } from './render/board.js';
import { Game, marksLength, DIRS, NAME_BY_DIR } from './ui/game.js';

const VERSION = '0.1.0';
// 默认档从引擎的菜单里挑（挑不到就退到第一档）：HTML 里一个尺寸字面量都不写。
const DEFAULT_SIZE = SIZES.includes('6x6') ? '6x6' : SIZES[0];

const $ = (id) => document.getElementById(id);

let canvas, wrap, veil, stateLine, srCell, sizePicker, verifyLine, verifyList;
let view = null;
let game = null;
// 三支笔，对着引擎的三态：画环=LOOP、排除叉=CUT、擦掉=UNKNOWN。
// 「排除叉」是一支真的笔，不是「擦掉」的别名：它把一条边写成 CUT，画出来是一个小叉。
let mode = 'loop'; // 'loop' | 'cut' | 'erase'
const PEN = { loop: LOOP, cut: CUT, erase: UNKNOWN };
let drag = null;
let cursor = -1; // 键盘光标
let anchor = -1; // 键盘连线锚点
let won = false;
// 引擎刚刚说过的那句话（提示的一条结论、或「检查」摊开的理由），以及它挂在哪一步之后。
// 玩家再落一笔（或撤一步、换一局）它就过期——一句「点必须被直穿」还挂在状态行上，
// 而盘已经变了三回，那是假线索。过期条件是 game.moves 变了，不是这里现编一个计时器。
let note = null; // {text, cls, at, moves}
// 「检查」按下去之后要把引擎的中文理由全数摊开；玩家一动笔就收回成三行摘要
let reasonsAll = false;
const say = (text, cls = 'hint', at = null) => {
  note = { text, cls, at, moves: game ? game.moves : -1 };
};
let busy = false;

// ── 时钟 ────────────────────────────────────────────────────────────────
let startedAt = 0;
let baseElapsed = 0;
const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
function startClock() {
  if (!startedAt) startedAt = Date.now();
}

// ── 暂停 ────────────────────────────────────────────────────────────────
// 暂停是**真冻结时钟**，不是挂个标签：暂停那一瞬把还在跑的那一段折进 baseElapsed，
// 再把 startedAt 清零 —— clock() 于是恒等于 baseElapsed，一毫秒都不再涨。
// 恢复时重新盖上 startedAt，时钟从冻结处续走；因为 baseElapsed 已经是累计值，
// 恢复后第一帧的 dt 就是一个正常帧间隔，不会把暂停那几秒一次性吃掉（不跳步）。
let paused = false;
function setPaused(next) {
  next = !!next;
  if (paused === next) return paused;
  if (next) {
    baseElapsed = clock();   // 先结算到此刻，再停表
    startedAt = 0;
  } else {
    startedAt = Date.now();
  }
  paused = next;
  paintPause();
  return paused;
}
function paintPause() {
  const btn = $('btn-pause');
  if (!btn) return;
  btn.textContent = paused ? '继续' : '暂停';
  btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
}
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── seed ────────────────────────────────────────────────────────────────
// 「换一局」必须真的换一局。日期当默认 seed 是隔壁仓刚踩过的坑：那个按钮叫换一局，
// 结果一整天都在发同一张盘。所以随机只发生在**选 seed**这一步，生成器内部一点随机都不许有。
let seedCounter = 0;
function mintSeed() {
  const c = globalThis.crypto;
  let hex = '';
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(6));
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  } else {
    // 没有 WebCrypto（非安全上下文）也要能出题：随机只发生在选 seed 这一步，不碰生成器内部
    hex = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  }
  seedCounter++;
  return `m${seedCounter.toString(36)}-${hex}`;
}

/**
 * 出题。Mid-loop 的生成器是「有几率出不了盘」的（status: unpinnable / over-budget /
 * not-unique / illegal-solution），所以这里在同一颗 seed 后面加确定性的后缀再试几次：
 * 后缀只改 seed 串、不改生成器里的任何随机，所以最后**发出去的那个 seed** 依然能一字不差地
 * 重建同一张盘（存档存的就是它）。全部试完还是不行就照直说，并印出引擎给的 tried。
 */
function genPuzzle(seed, sizeKey, tries = 8) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const s = i === 0 ? String(seed) : `${seed}#${i}`;
    last = makePuzzle(s, sizeKey);
    if (last.ok) return last;
  }
  return last;
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function avail() {
  const w = Math.max(280, wrap.clientWidth || 520);
  const h = Math.max(280, Math.min(w, (typeof window !== 'undefined' ? window.innerHeight : 800) - 220));
  return { w, h };
}

function render() {
  if (!game) return;
  const preview = [];
  if (anchor >= 0 && cursor >= 0 && anchor !== cursor) {
    const d = view.dirFromTo(anchor, cursor);
    if (d >= 0) preview.push([anchor, d]);
  }
  view.draw(game, { preview, cursor, won, hintAt: note ? note.at : null });
  paintStats();
}

function paintStats() {
  const p = game.puzzle;
  const bad = game.badCells();
  const ends = game.endpoints();
  const segs = game.loopEdges();
  const cuts = game.cutEdges();
  $('stat-seed').textContent = `seed ${game.seed}`;
  $('stat-dots').textContent = String(p.dotCount);
  $('stat-segs').textContent = String(segs.length);
  $('stat-cuts').textContent = String(cuts.length);
  $('stat-ends').textContent = String(ends.length);
  $('stat-onloop').textContent = String(game.loopCells().length);
  const badEl = $('stat-bad');
  badEl.textContent = String(bad.length);
  badEl.classList.toggle('bad', bad.length > 0);
  $('stat-moves').textContent = String(game.moves);
  $('stat-time').textContent = fmt(clock());
  const reasons = game.status();
  const vEl = $('stat-verify');
  vEl.textContent = reasons.length === 0 ? '通过' : `${reasons.length} 处不对`;
  vEl.classList.toggle('good', reasons.length === 0);
  vEl.classList.toggle('bad', bad.length > 0);
  verifyLine.textContent = reasons.length === 0
    ? 'verify(board, st) → [] —— 判胜只认这一句。'
    : `verify(board, st) → ${reasons.length} 条：${reasons[0]}`;
  paintReasons(reasons);
  if (!won) {
    stateLine.className = 'state-line' + (bad.length ? ' bad' : '');
    stateLine.textContent = bad.length
      ? `${bad.length} 格引出了 3 条以上的环边 —— 那里不可能接成一条环。${reasons[0] || ''}`
      : segs.length === 0
        ? '拖拽相邻两格连一段环；右键落在哪条边上就把那条边画成排除叉。每颗点都要是它那段最长直线段的正中。'
        : `已画 ${segs.length} 段、排除 ${cuts.length} 条，${ends.length} 个没接上的端点。引擎说：${reasons[0] || '点都服帖了'}`;
  }
  // 引擎那句话盖在进度播报之上：它是「刚刚发生的那件事」，而进度行每一帧都能重算出来。
  if (note && !won && game.moves === note.moves) {
    stateLine.className = 'state-line ' + note.cls;
    stateLine.textContent = note.text;
  } else {
    note = null;
    reasonsAll = false;
  }
}

/** 引擎的中文理由逐条印出来，UI 不翻译不改写 */
function paintReasons(reasons) {
  const cap = reasonsAll ? reasons.length : 3;
  const shown = reasons.slice(0, cap);
  verifyList.textContent = '';
  for (const line of shown) {
    const li = document.createElement('li');
    li.textContent = line;
    verifyList.appendChild(li);
  }
  if (shown.length < reasons.length) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `……还有 ${reasons.length - shown.length} 条（按「检查」看全）`;
    verifyList.appendChild(li);
  }
  verifyList.hidden = reasons.length === 0;
}

// ── 判胜：唯一的入口是引擎的 verify，UI 不给自己记账 ─────────────────────
function checkWin() {
  if (won) return true;
  const reasons = game.status();
  if (reasons.length) return false;
  const order = loopOf(game.board, game.st) || [];
  won = true;
  veil.hidden = false;
  $('win-meta').textContent =
    `seed ${game.seed} · ${game.sizeKey} · 点 ${game.puzzle.dotCount} 颗 · 环长 ${order.length} 格 · ${game.moves} 步 · ${fmt(clock())}`;
  stateLine.className = 'state-line good';
  stateLine.textContent = `verify(board, st) 返回空数组：一条 ${order.length} 格的闭环，每一颗点都是它那段直线的正中。`;
  Store.recordSolve(clock(), game.moves);
  Store.clearResume();
  render();
  return true;
}

/** 「检查」按钮：赢了就盖胜幕，没赢就把引擎的中文理由全数摊开 */
function runCheck() {
  if (!game || won) return game ? game.status() : [];
  startClock();
  const reasons = game.status();
  if (reasons.length === 0) {
    checkWin();
    return reasons;
  }
  reasonsAll = true;
  say(`还没成：引擎给了 ${reasons.length} 条理由，第一条是「${reasons[0]}」。`, 'bad');
  render();
  return reasons;
}

// ── 提示：引擎的下一条被迫结论，落笔仍然只经 Game 的公开入口 ──────────────────
// nextDeduction 只有三种回话（见 js/engine/pencil.js），这里就只有三个分支：
// 被迫结论 / 盘自己打脸 / 推不动了。没有第四支「那提示替你猜一个」——猜就是读答案的另一面，
// 而答案（puzzle.solution、toView 里的 loop/h/v）在本文件一个字都没读过。
// 写入走 Game.applyPin（里面就是引擎的 applyDeduction），落成之后照样进撤销栈、照样记一步。
function hint() {
  if (!game || won) return null;
  startClock();
  const d = nextDeduction(game.st);
  if (d && d.contradiction) {
    // 打脸的时候铅笔不肯再往前推：该撤哪一笔是玩家自己的判断。这里不落笔，也不装成落了一笔。
    say(`这里已经矛盾了：${d.why}。提示这一步什么都不画 —— 先撤掉那笔再说。`, 'bad');
    render();
    return { kind: 'contradiction', d, moved: false };
  }
  if (!d || d.stalled) {
    say(`铅笔推不动了：${d && d.why ? d.why : `${RULE_ORDER.length} 条规则轮了一圈，没话可说`}。提示不会替你猜，也不会去读答案 —— 剩下的得你自己接。`);
    render();
    return { kind: 'stalled', d, moved: false };
  }
  const rec = game.applyPin(d);
  if (!rec) {
    // Game 拒收了引擎给的那一条（号在盘外，或那一处已经不是没落笔）。落不下去就照直说落不下去，
    // 不许退回「那按我们自己算的画」——那正是第二记分板的开头。
    say(`提示这次没落下去：引擎给的是 ${d.kind}[${d.idx}] = ${d.value}，Game 拒收（不在盘上或已经这样了）。再按一次。`, 'bad');
    render();
    return { kind: 'noop', d, moved: false };
  }
  // 落成的那一句话就是引擎给的那两句原文拼起来：规则名 + 为什么
  say(`${d.ruleText} —— ${d.why}`, 'hint', d.at);
  srCell.textContent = d.why;
  render();
  checkWin();
  persist();
  return { kind: d.value === CUT ? 'cut' : d.value === LOOP ? 'loop' : 'cell', d, rec, moved: true };
}

function hideVeil() {
  veil.hidden = true;
}

// ── 开局 ────────────────────────────────────────────────────────────────
async function generate(seed, sizeKey) {
  busy = true;
  $('btn-new').disabled = true;
  $('btn-new').textContent = '生成中…';
  stateLine.className = 'state-line';
  stateLine.textContent = '正在出题：铅笔要零猜测推得完、计数器要说唯一、每条直线段只留一个中点——三道门都过了才发给你。';
  // 生成器是同步的（6x6 实测一百多毫秒），让出一帧好让「生成中」真的看得见
  await new Promise((r) => setTimeout(r, 0));
  const p = genPuzzle(seed, sizeKey);
  busy = false;
  $('btn-new').disabled = false;
  $('btn-new').textContent = '换一局';
  return p;
}

async function newGame({ seed = mintSeed(), sizeKey = game ? game.sizeKey : DEFAULT_SIZE, marks = null, moves = 0, elapsedMs = 0, resumeFrom = null } = {}) {
  if (busy) return null; // 连点两次「换一局」不该让上一张盘的生成还在跑就开下一张
  const p = await generate(seed, sizeKey);
  if (!p.ok) {
    const t = p.tried ? Object.entries(p.tried).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    stateLine.className = 'state-line bad';
    stateLine.textContent = `这个 seed 出不了盘（${p.status}${t ? `：${t}` : ''}）：按「换一局」再试一次。`;
    return null;
  }
  game = new Game(p);
  // 续局的判据不是「有没有这份存档」，而是「存档里那张盘和现在重画出来的是不是同一张」：
  // 存档存的就是 seed，生成器一改版，同一个 seed→另一张题面，旧笔迹贴上去就是让玩家在
  // 自己没玩过的盘上续命。Store.resume(指纹) 对不上会返回 null 并作废存档。
  const resume = resumeFrom ? Store.resume(p.fingerprint) : null;
  const carry = resume ? { marks: resume.marks, moves: resume.moves, elapsedMs: resume.elapsedMs } : { marks, moves, elapsedMs };
  // 存档的字符串长度必须正好对上这张盘的「边数 + 格数」——对不上就不搬（尺寸换过、串被截断都算）。
  // 步数只在笔迹真的搬过来之后才跟着搬：盘是空的却说「这局走了 12 步」又是另一句谎话。
  let carried = false;
  if (typeof carry.marks === 'string' && carry.marks.length === marksLength(p.n)) {
    game.decode(carry.marks, carry.moves);
    carried = true;
  }
  // 新一局（含续局重建）不带上上一局引擎说的话：那句话讲的是上一张盘的最后一步，
  // 挂在这张盘上是假线索。
  note = null;
  reasonsAll = false;
  won = false;
  hideVeil();
  // 键盘光标只在真的用键盘之后才出现：一个刚用鼠标点开游戏的玩家不该先看见一圈虚线
  cursor = -1;
  anchor = -1;
  baseElapsed = (carried && carry.elapsedMs) || 0;
  startedAt = Date.now();
  // 换一局＝新的一局，新局一定在走：带着上一局的 paused=true 进来会让时钟和按钮各说各话
  if (paused) { paused = false; paintPause(); }
  syncSizeButtons();
  relayout();
  render();
  persist();
  // 作废的那份存档要当着玩家说清楚：这一局是新的，不是他那一局（原因是生成器改版重算了题面）。
  // 写在 persist() 之后，因为 persist 已经把这张新盘存下去了，玩家下一次刷新就是正常续局。
  if (resumeFrom && !resume && Store.resumeDiscarded) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = `这一局的存档被作废了（${Store.resumeDiscarded.why}：存档 ${Store.resumeDiscarded.saved || '无指纹'} ↔ 重画 ${p.fingerprint}）：旧笔迹没有搬过来，这一局重新开始。`;
  } else if (resumeFrom && resume && !carried) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = `存档的指纹对上了，但笔迹串长 ${resume.marks.length} 对不上这张盘的 ${marksLength(p.n)} 格与边：旧笔迹没有搬过来，这一局从空盘开始。`;
  }
  return game;
}

function relayout() {
  if (!game) return;
  const a = avail();
  view.resize(game, a.w, a.h);
}

function persist() {
  if (!game || won) return;
  Store.saveResume(game, clock());
}

function setMode(next) {
  // 判「这个笔名认不认」用 in，不用取值真假：擦掉那支笔的 kind 就是 UNKNOWN=0，
  // 写成 PEN[next] ? next : 'loop' 会把「擦掉」当成没认出来、悄悄退回画环。
  mode = next in PEN ? next : 'loop';
  $('btn-mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
  $('btn-mode-cut').setAttribute('aria-pressed', String(mode === 'cut'));
  $('btn-mode-erase').setAttribute('aria-pressed', String(mode === 'erase'));
  canvas.style.cursor = mode === 'erase' ? 'cell' : 'crosshair';
}

// ── 尺寸菜单：全部来自引擎，HTML 里一个尺寸都不写 ──────────────────────────
// TOO_EXPENSIVE 的每一档是一个带理由的读数（{key, reason}，见 tools/balance.mjs 对它的要求），
// 所以这里既画按钮也把它「为什么不在菜单里」原话印在副标题上：菜单是引擎的实测结果，
// 页面不许自己猜一个「这个太大」。
// 这两个是 buildSizePicker 的两条读数臂，单独导出是为了让「TOO_EXPENSIVE 现在是空的」这件事
// 不等于「这条分支没人验过」：门禁可以直接喂一个 {key, reason} 进来问它读到了什么。
export function sizeKeyOf(entry) {
  if (typeof entry === 'string') return entry;
  const k = entry && (entry.key || entry.sizeKey || entry.size);
  return typeof k === 'string' ? k : String(entry);
}
export function reasonOf(entry) {
  if (typeof entry === 'string') return '';
  const r = entry && (entry.reason || entry.why || entry.note);
  return typeof r === 'string' && r ? r : '引擎没给理由';
}

function buildSizePicker() {
  sizePicker.textContent = '';
  for (const key of SIZES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost size';
    btn.dataset.size = key;
    btn.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.className = 'size-key';
    label.textContent = key;
    const sub = document.createElement('small');
    sub.className = 'size-sub';
    sub.textContent = '出货';
    btn.append(label, sub);
    btn.addEventListener('click', () => {
      if (game && game.sizeKey === key) return;
      newGame({ sizeKey: key });
    });
    sizePicker.appendChild(btn);
  }
  for (const entry of TOO_EXPENSIVE) {
    const key = sizeKeyOf(entry);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost size';
    btn.dataset.size = key;
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    const label = document.createElement('span');
    label.className = 'size-key';
    label.textContent = key;
    const sub = document.createElement('small');
    sub.className = 'size-sub';
    sub.textContent = reasonOf(entry);
    btn.append(label, sub);
    sizePicker.appendChild(btn);
  }
}

function syncSizeButtons() {
  for (const btn of sizePicker.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(!btn.disabled && game && btn.dataset.size === game.sizeKey));
  }
}

// ── 指针 ────────────────────────────────────────────────────────────────
// 拖拽走的是「相邻格心」：每一段都问 view 要方向，view 再问 Game（Game 只问 rules.js 的 DR/DC）。
// 不相邻的两格（甩太快）只会挪锚点，不会凭空长出一条斜边。
// 左键是**铺笔**：经过的每一条边都写成当前那支笔（loop→LOOP、cut→CUT、erase→UNKNOWN），
// 一整笔拖拽是一组撤销。右键是**就动指针压着的那一条边**：叉 ↔ 没落笔（LOOP 先变叉），
// 一次点击一组撤销一步。题面的点不可点：它是题面，不是笔迹，这一层没有任何一条路能把笔落在点上。
function onPointerDown(ev) {
  if (!game) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  ev.preventDefault();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有真的 pointerId：下面的 move/up 仍然按 clientX/Y 走同一条路 */
  }
  startClock();
  if (ev.button === 2) {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.toggleCut(hit.cell, hit.d); // 不在手势里：setEdge 自己就是一组
    render();
    persist();
    return;
  }
  const kind = PEN[mode];
  game.beginGesture();
  drag = { cells: [cell], kind };
  cursor = cell;
  if (mode === 'erase') game.eraseAt(cell);
  else if (mode === 'cut') {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.setEdge(hit.cell, hit.d, CUT);
  }
  render();
}

function onPointerMove(ev) {
  if (!game || !drag) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  const last = drag.cells[drag.cells.length - 1];
  if (cell === last) return;
  const d = view.dirFromTo(last, cell);
  if (d < 0) return; // 不相邻：只挪笔，不连线
  drag.cells.push(cell);
  game.setEdge(last, d, drag.kind);
  cursor = cell;
  render();
}

async function endDrag() {
  if (!drag) return;
  drag = null;
  game.endGesture();
  render();
  await checkWin();
  persist();
}

// ── 键盘 ────────────────────────────────────────────────────────────────
async function onKey(ev) {
  if (!game) return;
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const k = ev.key;
  const n = game.n;
  const move = (dr, dc) => {
    if (cursor < 0) cursor = 0;
    const r = Math.min(n - 1, Math.max(0, Math.floor(cursor / n) + dr));
    const c = Math.min(n - 1, Math.max(0, (cursor % n) + dc));
    cursor = r * n + c;
    // 锚点跟着光标走：方向键只管挪光标，不抹键盘的连线锚点。抹掉它的话「回车从锚点动手」
    // 这句承诺就永远落不成一笔（回车只能把锚点设在当前格，下一次回车 anchor===cursor 又什么都不做），
    // render() 里那段 anchor→cursor 的预览也会成为死代码。清锚点是 Escape 的活，不是方向键的活。
    srCell.textContent = game.cellReport(cursor);
  };
  if (k === 'ArrowUp') move(-1, 0);
  else if (k === 'ArrowDown') move(1, 0);
  else if (k === 'ArrowLeft') move(0, -1);
  else if (k === 'ArrowRight') move(0, 1);
  else if (k === 'Enter' || k === ' ') {
    ev.preventDefault();
    startClock();
    if (cursor < 0) cursor = 0; // 纯键盘进场的玩家可能还没碰过方向键
    if (anchor < 0) {
      anchor = cursor;
      srCell.textContent = `锚在第 ${Math.floor(cursor / n) + 1} 行第 ${cursor % n + 1} 列`;
    } else if (anchor !== cursor) {
      const d = view.dirFromTo(anchor, cursor);
      game.beginGesture();
      if (d >= 0) {
        // 叉那支笔在键盘上是**翻**的：同一条边回车一次画叉、光标挪回来再回车一次擦回没落笔
        //（左键拖拽那支是铺笔，经过哪条写哪条，不翻转——一次拖拽翻一堆边会把人绕晕）。
        if (mode === 'cut') game.toggleCut(anchor, d);
        else game.setEdge(anchor, d, PEN[mode]);
      }
      game.endGesture();
      anchor = cursor;
      render();
      await checkWin();
      persist();
    }
  } else if (k === 'Escape') {
    anchor = -1;
    hideVeil();
  } else if (k === 'Backspace' || k === 'Delete') {
    ev.preventDefault();
    startClock();
    // eraseAt 不在拖拽组里时自己就把这一步压进撤销栈了，别再 undo 一次抵消掉
    game.eraseAt(cursor);
    render();
    persist();
  } else if (k === 'z' || k === 'Z') {
    game.undo();
    render();
    persist();
  } else if (k === 'h' || k === 'H') {
    hint(); // 与按钮同一条路：点击与键盘按的是同一个函数，落的是同一个 Game 入口
  } else if (k === 'e' || k === 'E') {
    // 三支笔轮着切：画环 → 排除叉 → 擦掉 → 画环
    const order = ['loop', 'cut', 'erase'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
    srCell.textContent = `画笔：${mode === 'loop' ? '画环' : mode === 'cut' ? '排除叉' : '擦掉'}`;
  } else if (k === 'c' || k === 'C') {
    runCheck(); // 与「检查」按钮同一条路
    return;
  } else if (k === 'n' || k === 'N') {
    await newGame({});
    return;
  } else if (k === 'p' || k === 'P') {
    // 空格在本仓已经被别的动作占了，所以暂停只挂 P，不抢空格
    setPaused(!paused);
    return;
  } else return;
  render();
}

// ── 按钮 ────────────────────────────────────────────────────────────────
function wireButtons() {
  $('btn-new').addEventListener('click', () => newGame({}));
  $('btn-again').addEventListener('click', () => newGame({}));
  $('btn-close-veil').addEventListener('click', () => hideVeil());
  $('btn-hint').addEventListener('click', () => hint());
  $('btn-check').addEventListener('click', () => runCheck());
  $('btn-undo').addEventListener('click', async () => {
    if (!game) return;
    game.undo();
    render();
    persist();
  });
  $('btn-clear').addEventListener('click', () => {
    if (!game) return;
    game.clearAll();
    won = false;
    note = null;
    reasonsAll = false;
    hideVeil();
    render();
    persist();
  });
  $('btn-mode-loop').addEventListener('click', () => setMode('loop'));
  $('btn-mode-cut').addEventListener('click', () => setMode('cut'));
  $('btn-mode-erase').addEventListener('click', () => setMode('erase'));
  $('btn-pause').addEventListener('click', () => setPaused(!paused));
$('btn-motion').addEventListener('click', (ev) => {
    const next = !(ev.currentTarget.getAttribute('aria-pressed') === 'true');
    ev.currentTarget.setAttribute('aria-pressed', String(next));
    ev.currentTarget.textContent = next ? '动效 减' : '动效 全';
    setReduceMotion(next);
    Store.setSetting('reduceMotion', next);
  });
  $('btn-reset').addEventListener('click', () => {
    Store.reset();
    newGame({});
  });
}

function start() {
  applyThemeVars();
  setReduceMotion(Store.setting('reduceMotion') === true);

  canvas = $('board');
  wrap = $('board-wrap');
  veil = $('win-veil');
  stateLine = $('state-line');
  srCell = $('sr-cell');
  sizePicker = $('size-picker');
  verifyLine = $('verify-line');
  verifyList = $('verify-list');
  view = new BoardView(canvas);

  setMode('loop');
  buildSizePicker();
  wireButtons();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    relayout();
    render();
  });
  window.addEventListener('pagehide', persist);
  // 时钟自己每半秒走一次：玩家盯着盘面想下一步的时候时间也得在动（ paintStats 只在落笔时跑）。
  setInterval(() => {
    const el = $('stat-time');
    if (el) el.textContent = fmt(clock());
  }, 500);

  // ── 门面 ────────────────────────────────────────────────────────────
  window.midloop = {
    version: VERSION,
    state: 'booting',
    engine: {
      makePuzzle, toView, parseSize, SIZES, TOO_EXPENSIVE, verify, createState,
      // applyDeduction 挂在这里是给门禁点名/自建局面用的。页面落结论只走 Game.applyPin ——
      // 它内部调的就是 applyDeduction，外加撤销栈与 moves 那一本账。绕过 Game 直接调它 = 自己
      // 走出撤销账本，那种笔迹撤不掉也不进存档，别把它当玩法用。
      nextDeduction, applyDeduction, RULE_ORDER, RULE_TEXT, unknownCount, solve,
      countSolutions, countSolutionsRowMajor, cyclesByDfs, NODE_CAP,
      edgeRef, edgeId, edgeById, edgeCount, nEdgesH, hIndex, vIndex, cellIndex, loopOf, dotStatus,
      // 门禁要用"一圈顺序格子"造一份写满的局面来复核官方例题；造不满的局面（剩下的还是
      // UNKNOWN）verify 会回一堆 pending，看着像规则读错了、其实是我没造完，所以这条路必须由
      // 引擎自己的 stateFromEdges 走，测试里不抄第二份填法。
      stateFromEdges,
      marksLength,
      DR, DC, DIR_NAMES, NAME_BY_DIR, DIRS, DOT_KIND_TEXT,
      UNKNOWN, LOOP, CUT,
    },
    view,
    get game() {
      return game;
    },
    get won() {
      return won;
    },
    get mode() {
      return mode;
    },
    // 键盘光标与锚点住在本文件的模块作用域里（它们是"这一支笔现在指着哪"，不是盘上的事实，
    // 所以不进 Game）。门禁的键盘腿要比的就是这两个数：没有它们，"按下 ArrowRight 之后
    // 光标挪了一格"这句话只能靠像素反推，而像素反推分不清"没收到键"与"收到了但画歪了"。
    get cursor() {
      return cursor;
    },
    get anchor() {
      return anchor;
    },
    setMode,
    hint,
    check: runCheck,
    newGame,
    genPuzzle,
    mintSeed,
    // 尺寸菜单的重建口子：TOO_EXPENSIVE 现在是空数组，那条分支没有活样本可量，
    // 所以这里让门禁能往引擎那张表里临时塞一档（数组本身是可变的，const 只锁绑定），
    // 重建一次看看 disabled 与副标题是不是真的印出了理由，然后再 pop 掉。
    buildSizePicker,
    syncSizeButtons,
    checkWin,
    render,
    relayout,
    // persist 挂在门面上是为了存档那条腿能走页面自己那一条落盘路（玩家侧是 endDrag 之后调它）。
    // 让门禁自己去 Store.saveResume 里代劳的话，它验的就只是 Store，不再是"这一局会被写下来"。
    persist,
    hideVeil,
    store: Store,
    palette: Palette,
    space: Space,
  // —— 暂停：给闸台读的那张脸 ——
  get paused() {
    return paused;
  },
  setPaused,
  /** 正在推进的那个数（毫秒）。暂停时它必须一毫秒不动 —— 这就是"真冻结"的判据。 */
  simClock: () => clock(),
  };

  (async function boot() {
    // 先只看「有没有一份形状正确的存档」，笔迹/步数不在这里搬：newGame 要用存档里的 seed 重画出盘，
    // 再拿那张盘的真实指纹向 Store.resume(指纹) 对一次账（对不上就作废存档、开新局并说给玩家听）。
    // 续局要把存下的步数一并交回去：只搬笔迹不搬步数，画面就会显示「0 步」，
    // 而盘上明明已经画了十几段——这两个数都由 newGame 从存档里自己取，不在这里转手。
    const pending = Store.pendingResume();
    let started = null;
    let offMenu = null;
    if (pending && !SIZES.includes(pending.sizeKey)) {
      // 存档里那一档已经不在菜单上了（TOO_EXPENSIVE 后来请出去了一档，或者这份档是从别人机器上抄来的）：
      // 拿它去生成等于让玩家在开机那一下等一张证不完的盘，而且那一档连"出货"的资格都没有了。
      // 所以这里当场把话说明并按默认档开新局，而不是悄悄把档丢了。
      offMenu = pending.sizeKey;
      Store.clearResume();
    } else if (pending) {
      started = await newGame({ seed: pending.seed, sizeKey: pending.sizeKey, resumeFrom: pending });
    }
    if (!started) await newGame({});
    if (offMenu) {
      // 写在 newGame 之后：newGame 会把引擎上一句话清掉（那句讲的是另一张盘），这条讲的是这一局为什么是新的。
      stateLine.className = 'state-line hint';
      stateLine.textContent = `存档里的那一档（${offMenu}）已经不在菜单上：它的成本没有越过引擎那条节点预算的线。这一局按 ${game.sizeKey} 新开。`;
    }
    window.midloop.state = 'ready';
  })();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') start();

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}
