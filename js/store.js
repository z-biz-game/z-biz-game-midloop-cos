// 存档。所有东西挂在同一个键下，所以「清空存档」是一行。
//
// 进行中的对局存的是 (原始 seed, 尺寸, 玩家画下的笔迹, 步数/耗时)，不是题面或答案的副本——
// 生成器只吃 seed，所以同一个 seed 在任何一台机器上都画同一张盘，恢复一局只有几百字节。
// 存原始 seed 而不是 generate.js 内部派生过的那一个：内部值一变，旧存档就重建不出同一张盘。
//
// marks 是「每条边一个字符、再每格一个字符」的三态串（'0' 没落笔 / '1' 环边 / '2' 排除叉）。
// **顺序与长度的唯一定义在 js/ui/game.js 的 marksLength/encode/decode**（先 H、再 V、再 cell），
// 这里只搬运不解释：存储层不参与几何，所以它不可能比 UI 更早把顺序写错。
// 读档的三步（在 js/main.js 里走）：拿 seed+sizeKey 重画一次 makePuzzle → 比 fingerprint →
// 不一致就当场作废并留下 resumeDiscarded 给界面说原因。所以「存档贴错盘」这件事有两次独立拦阻
// （指纹对账 + 串长对账），任何一次不过都只是丢掉笔迹，不会把上一局的画贴到这一局上。
//
// 本模块可以被 Node 直接 import：没有存储就当没有存档，一个字都不 throw。
// 先用 window 认环境：Node 22 起会挂一个「要 --localstorage-file 才可用」的 localStorage 占位
// 访问器，一读就往 stderr 吐一条 ExperimentalWarning（不崩，但每次 import 刷一行噪音，
// 而门禁读的是 stderr 的洁净度）。所以 Node 这条路根本不去碰那个名字。

const KEY = 'midloop.save.v1';

function hasStorage() {
  if (typeof globalThis.window === 'undefined') return false;
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null
      && typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function';
  } catch {
    return false;
  }
}

const defaults = () => ({
  settings: { sound: false, reduceMotion: false },
  resume: null,
  totals: { solved: 0, moves: 0, ms: 0 },
});

function load() {
  try {
    if (!hasStorage()) return defaults();
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults();
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  } catch {
    return defaults();
  }
}

/** resume 那份 payload 的形状门：只要有一个字段不对，就当没有存档（绝不 throw 出加载路径） */
function shapedResume(r) {
  return !!r
    && typeof r === 'object'
    && typeof r.marks === 'string'
    && typeof r.seed === 'string' && r.seed.length > 0
    && typeof r.sizeKey === 'string'
    && Number.isInteger(r.n) && r.n >= 2 && r.n <= 64
    && (r.moves === undefined || Number.isFinite(r.moves))
    && (r.elapsedMs === undefined || Number.isFinite(r.elapsedMs));
}

export const Store = {
  data: load(),
  // 指纹对账失败时 resume() 把原因写在这里（内存里，不进 localStorage），认账时就清掉。
  resumeDiscarded: null,

  save() {
    try {
      if (!hasStorage()) return;
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式 / 配额超了 —— 游戏照样能玩，只是记不住事 */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  saveResume(game, elapsedMs) {
    this.data.resume = {
      seed: game.seed,
      sizeKey: game.sizeKey,
      marks: game.encode(),
      moves: game.moves,
      elapsedMs,
      n: game.n,
      fingerprint: game.puzzle.fingerprint,
      at: Date.now(),
    };
    this.save();
  },

  // 「同一个 seed 重建出同一张盘」这句话只在**同一版生成器**里成立：生成器一改，同一个 seed
  // 就是另一张盘，把旧笔迹贴上去等于让玩家在一盘自己从没玩过的题面上续命。
  // 所以 saveResume 写下的 fingerprint 在这里读回来对账：
  //   传了 freshFingerprint 且与存档里那条不一致（或存档里压根没有指纹）⇒ 这份存档就地作废、
  //   返回 null，并把作废的原因留在 resumeDiscarded 里给 UI 说给玩家听——绝不让它留着反复骗人。
  //   不传参数就是「只看形状、不对账」（排障与门禁读档用），出货路径必须传。
  resume(freshFingerprint = null) {
    const r = this.data.resume;
    if (!shapedResume(r)) return null;
    if (freshFingerprint === null) return r;
    if (typeof r.fingerprint !== 'string' || r.fingerprint !== freshFingerprint) {
      this.resumeDiscarded = {
        why: typeof r.fingerprint !== 'string' ? '存档里没有指纹' : '指纹不一致',
        seed: r.seed,
        sizeKey: r.sizeKey,
        saved: r.fingerprint || null,
        fresh: freshFingerprint,
        moves: r.moves,
      };
      this.data.resume = null;
      this.save();
      return null;
    }
    this.resumeDiscarded = null; // 认账了：上一次的作废原因不许再挂着
    return r;
  },

  // 只校验形状、不做指纹对账的读档：boot 用它决定「这一局要不要拿存档里的 seed 重画」。
  pendingResume() {
    return this.resume();
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  recordSolve(elapsedMs, moves) {
    const t = this.data.totals;
    t.solved++;
    t.moves += moves;
    t.ms += elapsedMs;
    this.save();
  },

  totals() {
    return this.data.totals;
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
