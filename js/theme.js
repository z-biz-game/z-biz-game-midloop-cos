// 颜色、间距、动效的唯一来源。样式表通过 applyThemeVars() 读这些值，canvas 读的是同一批对象，
// 所以改一个令牌不可能只改到一边。
//
// Field / Dot / Loop / Mark 这四组是会被真实像素量的几何色：取样脚本逐颗线索取盘心/格线中点、
// 逐条环边取中点像素，两边都比的是这里写的值（容差 12）。
// 所以每一组都必须和「盘底 / 网格线 / 环线」拉开至少 25 的逐通道距离，否则一次改色就能让
// 一个断言在错误的东西上变绿。
//
// Mid-loop 比 Masyu 多一条约束：**边框点就画在格线的中点上**，也就是环线与排除叉同一个位置。
// 所以格线不能像上一仓那样压成比盘底更暗的一丝（#0E1424）—— 那样「一个黑点压在暗格线上」
// 和「那里只有一条格线」在像素上几乎同值。这里把格线抬亮一档，实测逐通道间距（|Δr Δg Δb|）：
//   dot #02040A  field #1C2740 → 26/35/54      dot #02040A  gridLine #45577A → 67/83/112
//   gridLine    field          → 41/48/58      gridLine    accent #FFC85C   → 186/113/30
//   gridLine    cutMark #8298C4→ 61/65/74      gridLine    capDot #7BB8FF   → 54/97/133
//   dot         accent         → 253/196/82     dot         cutMark         → 128/148/186
// 每一对都 ≥25（node 现算，不是估的）。
export const Palette = {
  bgTop: '#070A14',
  bgBottom: '#121A2C',
  surface: '#0F1526',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#6B7FA8',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // 盘面底色（网格里面那一层）。它离线索点 #02040A 与环线 #FFC85C 都 ≥25 通道，
  // 所以「这一格什么都没画」「这一格在环上」「这里有一颗点」是三块不同的像素。
  field: '#1C2740',
  // 格线：Mid-loop 的边框点就住在格线上，所以它是「亮的一丝」，把黑点衬托出来（见文件头实测）。
  gridLine: '#45577A',

  // 琥珀 = 玩家的手：画出来的环段、环上格的底、键盘光标都是它。
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',
  // 环上格（st.cell === LOOP）的底：就是 accentSoft 落在 field 上，比盘底暖一档。
  loopCell: 'rgba(255,200,92,0.16)',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  errorSoft: 'rgba(255,92,122,0.16)',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 线索点：题面给的、只读的、永远画在最上面那颗实心黑点（格心或格线中点）。
  // 它没有「黑珠/白珠」之分 —— Mid-loop 的点只说一件事：那段最长直线的正中。
  dot: '#02040A',
  // 点的描边：让它在环线（暖色）与排除叉（冷灰）之上仍然读得出是一颗球。
  dotRing: '#F2F5FB',
  // 已经判失败的点（引擎 dotStatus = 'bad'）外面那一圈：形状证据，色是附加证据。
  badRing: '#FF5C7A',
  // 环的端点（度数 1）：还没连上的那一头，用冷白点一下，免得被当成已经闭合。
  capDot: '#7BB8FF',
  // 排除叉（引擎三态里的 CUT）：这条边**不在环上**。它是玩家的第二支笔，所以既不能读成
  // 「什么都没画」（那是 UNKNOWN 的盘底/格线），也不能读成环（那是 accent）。
  cutMark: '#8298C4',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 8, cell: 4 };

export const Font = {
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

export const Motion = {
  tap: 150,
  base: 220,
  line: 260,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 环线的粗细是**几何**令牌：取样脚本按它在段中点取样，所以 view 的 lineWidth 和 segRect 的厚度
// 都从这一个数出来（改粗改细都不会让取样点跑出环线之外）。
export const Board = {
  cellMin: 34,
  cellMax: 76,
  pad: 16,
  loopWidth: 0.2,
  // 线索半径：按出题的画法给 0.13 格，边框点要能压在环线/叉线之上还读得出是一颗球。
  dotR: 0.13,
  ringWidth: 0.05,
  badRingWidth: 0.085,
  // 排除叉也是几何令牌（同上：draw 和取样必须读同一批数）。arm 是半臂长、width 是线宽，
  // 都按 cell 的分数算。
  //
  // 边框点与排除叉画在**同一个像素位置**（那条边的中点），所以两者的相对尺寸是硬要求：
  //   叉的半臂 0.17 > 点半径 0.13 ⇒ 点落在叉心上时四条臂都还露在外面，两个形状同时可读；
  //   环线（0.2 粗，即半宽 0.10）从点底下穿过，点的直径 0.26 > 线宽 ⇒ 线两侧都看得见黑。
  // 未落笔就只是那颗点自己（既没有线也没有叉）。
  cutArm: 0.17,
  cutWidth: 0.075,
  // 已排除格（st.cell === CUT）心上的小叉：半臂 0.09，明显小于格心点半径 0.13，
  // 所以「这格被排除了」与「这格上有一颗点」叠在一起时，点赢（那是题面，本来就该压在最上）。
  cutCellArm: 0.09,
  cutCellWidth: 0.05,
  // 环上格底的圆角（按 cell 的分数）
  fillRadius: 0.16,
};

export function applyThemeVars() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

let motionReduced = false;
export function setReduceMotion(v) {
  motionReduced = !!v;
}
export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
