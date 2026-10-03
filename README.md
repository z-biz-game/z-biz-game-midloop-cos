# ミッドループ Mid-loop · 点是那段直线的正中

盘上有些点，有的在格子正中、有的压在两格之间的那条格线上。答案是一条不自交的闭环：它必须经过每一个点，
而且**每个点都得是"穿过它的那条直线段"的正中**——点两侧那段直线一样长。每盘唯一解，判胜只由引擎的
`verify` 说了算，界面不许自己宣布胜利。

- **在线试玩**：<https://z-biz-game.github.io/z-biz-game-midloop-cos/>（`main` 推送即由 `pages.yml` 部署；
  本地那份是 `npm run dev` 起的 5281，两种 URL 形态都被 `tools/verify.sh` 跑过）

## 规则（玩家视角）

两条原文照抄，不做改写：

> Draw lines through cells to make a single loop. The loop may go through the centers of cells
> horizontally or vertically. The loop never crosses itself, branches off, or goes through the same cell
> twice. The loop must go through all the black circles, with the black circle as the midpoint of the
> (straight) line segment passing through the circle.
> —— Nikoli，Mid-loop 规则页（英文）

> 線はすべての黒丸を通ります。黒丸は、その黒丸を通る直線部分の中点（ちょうど真ん中）になるようにします。
> —— Nikoli，ミッドループ规则页（日文）

第二家出版方补上了第一家没写的两件事：

> A rectangular or square grid contains dots; **a dot can be situated in the center of a cell or on a
> border between neighbouring cells**. The aim is to draw a single continuous non-intersecting loop that
> properly passes through all dots. Dots must be traveled straight through.
> **Segments of a straight line going out of a dot must be equal.**
> —— Cross+A，规则总页的 Mid-Loop 条目

于是完整的规则是四条：

1. **一条环**：线走格心，横竖皆可，不自交、不分叉、不重复经过同一格，全体合成**一个**闭环。
2. **环过所有的点**：点不是障碍，是环必须经过的位置。
3. **点可以在格线上**：那种点压在两格之间，环必须正好穿过那两个格之间的那条边。
4. **中点**：穿过一个点的那条**直线段**（沿该轴一直到拐弯为止的极大一段）以这个点为中心，两侧等长。
   格线上的点，把"它脚下那条边"算作两侧各 1 格。

### 第 4 条里"直线段"到底是哪一段——本仓的裁定

日文只说「その黒丸を通る直線部分」，没说这一段能不能随便截。这一句差别足以改变答案的数量，所以拿
Nikoli 自己的 5×5 例题当审判庭：枚举盘上所有简单环，

| 读法 | 5×5 例题上有几个环 |
|---|---|
| 弱：只要直穿，两侧各至少 1 格（可以只截一小段对称的） | **26** |
| 强：穿过它的**极大**直线段以它为中心 | **1**，且就是页面公布的第 4 张图 |

一张官方例题不可能有 26 个答案 ⇒ 出货实现取**强读法**。这条裁定同时写在
`js/engine/rules.js` 的头注释与本仓门禁 `tools/engine-test.mjs` 的 A 段（两个数都是断言，不是散文）。

## 怎么玩

- **三支笔**：画环 / 排除叉 / 擦掉（`画环`→`LOOP`、`排除叉`→"这条边一定不是"、`擦掉`→回到没落笔）。
  按钮是 `#btn-mode-loop` / `#btn-mode-cut` / `#btn-mode-erase`，按 `E` 三支轮着切。三态都要能画，
  因为推理靠的正是"这条边一定不是"。
- **指针（鼠标与触屏同一条路）**：从一格拖到相邻格，笔经过的**每一条边**都写成当前那支笔（铺笔），
  一整笔拖拽算**一组**撤销。甩太快跨过不相邻的两格只会挪锚点，不会凭空长出一条斜边。
  右键只动指针压着的那**一条**边：叉 ↔ 没落笔（是环边就先变叉），一次点击一组撤销一步。
  **题面的点不可点**——它是题面，不是笔迹，界面上没有任何一条路能把笔落在点上。
- **键盘**：方向键在格上移光标；`Enter`/`空格` 第一次设锚、第二次在锚与光标之间落笔（叉那支笔在键盘上
  是**翻**：同一条边按一次成叉，光标挪回来再按一次擦回没落笔）；`Backspace`/`Delete` 擦当前格；
  `Z` 撤销；`H` 提示；`C` 检查；`N` 换一局；`Esc` 收起胜利卡并取消锚。
  键盘那支笔与鼠标那支笔落进的是同一个 `Game` 入口，所以"按键盘画出来的环"和"拖出来的环"不是两套代码。
- **提示**：向引擎要**下一条被迫的结论**。它落一笔，并把凭的那条规则的那句中文原文说给你看
  （十条命名规则在 `js/engine/pencil.js` 的 `RULE_ORDER` / `RULE_TEXT`，顺序就是这里抄的顺序）：
  一共 10 条：`dot-on-loop` `edge-cells-on` `cell-off-clears` `no-dead-end` `cell-degree-two`
  `dot-straight` `arm-symmetry` `one-dot-per-run` `no-dotless-pocket` `no-early-cycle`。
  推不动了它直说推不动，
  并且报还剩几处没落笔——不会假装落了一笔。
- **检查**：`verify` 的每一条理由逐条上屏（`#verify-line` / `#verify-list`），说的是"违反了哪一条规则"，
  而不是"还剩几格"。**判胜也只由 `verify` 说了算**：界面不许自己宣布胜利。
- **换一局 / seed**：顶栏一直显示这盘的原始 seed；同一个 seed 永远画同一张盘（node 与 Chrome 也一样，
  rng 只用整数运算）。刷新页面会续上这一局，前提是存档里的指纹与重画出来的对得上；对不上就当众作废、
  把这局重新开始，并且说原因。
- **尺寸**：菜单只列**量出来能在预算内证完**的档；被请出菜单的那一档在选择页带着它自己的实测读数出现，
  不是一条静悄悄的死选项。

## 难点在哪（不是"难"，是"和邻居不一样"）

- **中点约束的是极大段**，所以一个点不是局部信息：你得沿那条轴一直看到拐弯为止，才知道中点该在哪。
  只画两格"看起来对称"是不够的——这正是上面那 26 个环的故事。
- **两个点不能共用一条直线段**（每条极大段只有唯一合法点位置：奇数格在中间那格，偶数在中间那条格线）。
  于是"这两个点之间已经连成一条直线"本身就是矛盾，这条推理是族里少见的跨点推理。
- **臂长的上界会延迟咬人**：一侧的臂定死了长度 L，另一侧只能在**已经长到 L** 的那条边上落叉；
  再往外，同一条线还可能被环的另一段用到。

## 撞车判断：它站在环线族的哪里

同族已经出货的邻居与它们的线索语义：Masyu（线索是**格的属性**：黑珠那格必拐、白珠那格必直）、
Slitherlink（环走**格线**、线索在格内数边）、Yajilin（箭头 + 黑格 + 环）、Arukone（格内数字 =
穿过该格的**直线段长度**）。Arukone 是族里离本玩法最近的一条，但它约束的是段长，不是段的中点，
而且它的线索不会落在格线上。

本玩法的两处在同族已出货的仓里都没有先例：**线索可以落在环自身某条边的中点上**，以及
**点两侧线段等长**这条约束本身。走格心的单环是族里的公共底座，被换掉的是线索语义——不是"同一条环换个说法"。

那句"没有先例"是 2026-09-30 立项时对手上这批同族仓做的一次人工 grep（`vborder`/`hborder` 这种边中点线索的语义
只有本仓实现），它不是一条会为你变红的断言——每个仓各在 CI 里独立 checkout，谁也 grep 不到谁。所以它记在
下面的"不承诺"里，不作为承诺卖出去。

## 两条出货判据（这个仓凭什么存在）

一个新品类只有同时满足两条才有资格建仓：**每一盘唯一**，而且**唯一是可推的**。两条各由一条独立实现回答，
它们互不 import（`js/engine/rules.js`+`count.js` 一套几何，`js/engine/pencil.js` 自己再写一套边几何与中点判据），
只在同一张盘上会师——共享 helper 的话"会师"就是同义反复。

| 判据 | 说的话 | 谁在复测 | 本轮读数（日志名） |
|---|---|---|---|
| 1 唯一性 | 不含任何推理规则的**逐格穷举计数器**，在 `NODE_CAP = 2000000` 节点内数出**恰好 1** 个解 | `B3`（每张出货盘从线索集合重数）＋ `engine-test` A/C/D 段 | 菜单内 4 档 × 每档 48 张：`数不出 1` 0 张（9/10 两档只量成本、不出货，所以没有 B3 行）；无点盘 n=2..5 与独立简单环枚举同值 `1 / 13 / 213 / 9349`（`_tmp-midloop-balance-final48.log`、`_tmp-midloop-engine-test-final.log`） |
| 2 可推性 | 铅笔十条命名规则从**空盘**起、一次不猜、推到全盘定死，每一笔都点名一条规则 | `B2`（推不满＝红）＋ `engine-test` E 段 ＋ 浏览器里用页面上那份引擎再推一遍（`gen` 场景） | 同样 4 档 × 48 张：`推不满` 0 张；官方 5×5 从空盘推满（`tools/verify.sh` 的 core/engine 报告打印 steps 与 rules） |

两条判据的代价分配是量出来的，不是省的：**按"forced 程度"挖线索、推满之后只数一遍**，比按解数挖便宜三个数量级
（按解数挖把"证唯一"的代价付在每一次重试里，见 `DESIGN.md` 第 5 节）。所以尺寸天花板是**铅笔的**，不是计数器的。

## 尺寸菜单是被量出来的（线一个不挪）

预算是节点数而不是毫秒：毫秒由机器速度决定，而 seed→盘 不能由机器决定。菜单只列 `5x5 6x6 7x7 8x8`
（引擎的 `SIZES`，页面不写死尺寸；`package.json` 里也没有第二张档位表）。

菜单内的四档，在"每档 48 颗种子 × 每颗至多 3 个候选"的抽样里**越预算候选都是 0 个**——这句话由 `B5`
每次复测，不是抄来的。它们的 med/p95/max 节点与 med 点数是观测值，住在
`_tmp-midloop-balance-final48.log`（5x5 med 29 节点 / med 6 点，6x6 77 / 8，7x7 94 / 9，8x8 247 / 12）。

被请出菜单的两档没有静悄悄消失：它们带着**自己的实测读数**住在 `TOO_EXPENSIVE` 里，而那句话由字段拼出来，
`B5` 逐数对账（句子与字段不是同一批数＝红；本次并不越线却还挂在菜单外＝说谎）。选择页把这句话印在按钮副标题上。

| 档位 | 种子数 | 每颗候选上限 | 越预算候选 | 该档出货盘最大节点 |
|---|---|---|---|---|
| 9x9 | 48 | 3 | 1 | 1,020,156 |
| 10x10 | 48 | 3 | 3 | 645,560 |

## 快速开始

```bash
npm run dev      # node server.cjs 5281
npm test         # node tools/engine-test.mjs（纯 node，判据 1/2 的正面证据 + 三组反空转对照）
npm run balance  # node tools/balance.mjs（红线 B1/B2/B3/B3b/B4/B5/B6，默认 48 张 × 3 个候选 × 6 档）
npm run doctest  # node tools/doctest.mjs（本文与 DESIGN 里每一个现值都等于代码的现在值）
npm run verify   # bash tools/verify.sh（真 Chrome + 裸 CDP，两种 URL 形态）
```

端口：本地 5281 · 前缀形态 5282 · CDP 9381（`tools/verify.sh` 起**两个** server：第二个的根目录是一个
只放着 `z-biz-game-midloop-cos` 软链的临时目录，所以 `/z-biz-game-midloop-cos/` 这个前缀是真挂在 URL 上的，
不是同一个 server 顺手兜底兜出来的——写死绝对路径在线会 404 的写法在这里一样会红）。零运行时依赖，CI 里没有 `npm install`。

## 门禁清单

| 门禁 | 命令 | 它替谁说话 | 本轮读数（日志名） |
|---|---|---|---|
| 语法 | `npm run check` | 每个源文件都能被 node 解析，`verify.sh` 是 `bash -n` | OK check（`_tmp-midloop-check.log`） |
| 引擎保证 | `node tools/engine-test.mjs` | 判据 1/2 的正面证据 + 三组反空转对照（0 解 / 8 解 / 金标准环数）+ 两套编码的约定对齐 | 32 checks, 0 failed（`_tmp-midloop-engine-test-final.log`） |
| 红线 | `node tools/balance.mjs` | 出盘率、零猜测推满、计数器复数恰好 1、两排序逐张同解、线索最小（balance 自己重数一遍再和生成器自报的对账）、菜单与 `TOO_EXPENSIVE` 不说谎、无装饰性规则 | 40 条全绿（`_tmp-midloop-balance-final48.log`） |
| 文档 | `node tools/doctest.mjs` | 本文与 DESIGN 印出去的每一个现值 | 见下面"哪条命令在 CI 里" |
| 真浏览器闸 | `bash tools/verify.sh` | DOM 文本/几何、画布像素、真输入事件、存档与续局、两种 URL 形态 | 全绿（`_tmp-midloop-verify-shapes.log`） |
| 阴性自证 | `GATE_SELFTEST=1 bash tools/verify.sh` | 闸必须能被证明**会红** | rc＝1，32/32 份报告各自点名吃下种下的错（`_tmp-midloop-verify-selftest.log`） |

### 浏览器闸的形状（这几个数由 `tools/verify.sh` 现值推出来，`doctest.mjs` 逐数对账）

闸的形状：腿 7 条 · 形态 2 种 · 每形态 16 份报告 · 合计 32 份

- 7 条腿是 `core play win mouse touch keys save`（`LEGS` 的默认值；未知腿名会**当场红**，不会"匹配不到就算跑完"）。
- 2 种形态是根 `/` 与 Pages 的 `/z-biz-game-midloop-cos/` 前缀，各由一个 server 服务（5281 / 5282）。
- 16 份报告 = 脚本里 10 次 `run_scenario` + 6 次 `run_cmd`：`engine gen play hint win layout mouse touch keys save frag-nav resume reload corrupt reload2 offmenu`。
- 两种形态跑下来的**逐份条数逐条相同**（一次全绿跑的读数住在 `_tmp-midloop-verify-shapes.log`，本文不抄它——抄了就要靠下一次复跑来推翻）。

### 哪条命令真的在 CI 里跑

| 命令 | job | 步骤名 |
|---|---|---|
| `node tools/engine-test.mjs` | check | `Engine tests` |
| `node tools/doctest.mjs` | check | `Docs are asserted surface` |
| `node tools/balance.mjs` | check | `Size menu and hardness are still measured` |
| `bash tools/verify.sh` | browser | `Browser gate, both local URL shapes` |
| `GATE_SELFTEST=1 bash tools/verify.sh` | browser | `Gate proves it can fail` |
| `node tools/sabotage.mjs` | browser | `Ledger doses every documented claim` |

两个 job 的名字是 `syntax + engine guarantees`（node 20）与 `real browser gate (both URL shapes)`（node 22）。
台架用的是 Node 22 才有的全局 `WebSocket`/`fetch`，在 20 上第一次 attach 就死在 `WebSocket is not defined`，
一条断言都跑不到。CI 里没有 `npm install`——这仓零运行时依赖，为了"证明什么都没装"去拉一个打包器，
换来的只是下一次网络抖动的红。

## 破坏试验台账（"会红"这句话本身也得被证一次）

上面每一行绿只说明这一次没抓到东西，不说明它抓得到。所以另有一本台账专门下刀：把文档里的现值改坏一个数字、
把计数器的预算砍没、把页面上记步的那一句改翻倍，然后看闸是不是真的红、红的那一行是不是点得出自己的名字
（红了却不说是哪条断言红的，算第二宗罪）。台账是仓里的 `tools/sabotage.mjs`，重跑就是 `npm run sabotage`。它此前住在工作区根目录的 `_tmp-midloop-dose.mjs`，
那句话有两处不对：一是仓外的文件不进版本控制、CI 看不见、npm 调不到，于是"13 把刀逐条点名"只活在某一台机器的
终端记录里；二是它在**真树**上原地改文件、靠备份逐字节恢复——一次 SIGKILL 就能把改坏的 README 留在几个人共用的
工作树里。搬进仓里的同时换成副本作业：刀下在 `_sabotage-copy/`（`.gitignore` 里），真仓一个字节不动。
它读的是自己这一次的 rc，不转抄上一次的漂亮话。**它现在进 CI**，而且是 browser job 的
`Ledger doses every documented claim` 那一步——副本就是"第二棵树"，而 14 把里 K12 那条腿要真浏览器才能数得出
翻倍的步数，放 check job 它会因为"这里没有 Chrome"而红得不讲道理。旧那台架整轮的读数住在
`_tmp-midloop-dose-ledger.log`（13 把 / 全部点名 / `LEDGER_RC=0`），那是历史，不是这一次的成绩。
这一次的成绩是 `_tmp-midloop-inrepo-r2.log`：**14 把 / 全部点名 / 与预期不符 0 / `SAB_RC=0`**，本机 3 分 47 秒
（START/END 两行也在那份日志里，秒数是这两个时间戳相减）。跑它用的是自己的端口（`HTTP_PORT=5391`
`HTTP_PORT2=5393` `CDP_PORT=9491`）——5281/5282/9381 当时被另一个会话的进程占着，不去杀别人的进程，
端口由跑台账的命令当场挑（这一遍和 CI 那一遍都不是在 5281 上跑的）。
`-r1` 不是一个成绩，是一具尸体：`cpSync` 在跑 filter 之前就判定"目标在源的子树里"，而副本必须落在仓内
那一个位置，于是台架在对照组第一行都没跑出来的地方抛了 `ERR_FS_CP_EINVAL`（`_tmp-midloop-cpsync-crash.log`）。
换成自己走树之后才有 `-r2`；跑完 `_sabotage-copy` 已被删掉，`ls` 读回 "No such file or directory"——
留着最后一把刀改过的树，下一个读仓的人就会把副本当成真源。

台账 0 是前置对照：下刀之前 `doctest` 与 `engine-test` 两条都得 rc=0。树本来就是红的就别下刀，
红树配红刀什么都证不了。

| 刀口 | 改坏什么 | 该红的闸 | 红的那一行点名 |
|---|---|---|---|
| K1 | 档位表里 9x9 那一行的「越预算候选」从 1 抄成 0 | `tools/doctest.mjs` | `D1 9x9 那一行的四个数等于引擎字段` |
| K2 | 规则名表里把一个规则名改名 | `tools/doctest.mjs` | `D2 README 列的规则名逐条等于 pencil.js 的 RULE_ORDER` |
| K3 | 文档把腿数写成 8 | `tools/doctest.mjs` | `D3 文档写的腿数等于 LEGS 的默认值` |
| K4 | 前缀形态的端口写错一位 | `tools/doctest.mjs` | `D4b 前缀形态端口等于文档` |
| K5 | 文档里的节点预算少写一个 0 | `tools/doctest.mjs` | `D5 文档写的节点预算等于 count.js 的 NODE_CAP` |
| K6 | 覆盖表里删掉一行 CI 真在跑的门禁 | `tools/doctest.mjs` | `D6b ci.yml 里跑的每个 tools 门禁都被覆盖表列了` |
| K7 | 默认抽样底从 48 抄成 24 | `tools/doctest.mjs` | `D7 文档写的默认抽样底等于 balance 的默认` |
| K8 | 把剂量覆盖面夸大成只有两条 | `tools/doctest.mjs` | `D10c 文档写的剂量覆盖面等于 --dose 里的剂量项` |
| K9 | 文档里插一条越界的行号引用 | `tools/doctest.mjs` | `D9 文档里的 1 条 path:NN 引用都落在真实文件的行数内` |
| K10 | 文档点名一条不存在的红线 | `tools/doctest.mjs` | `D10 文档点名的每条红线在 balance.mjs 里都还在` |
| K11 | 计数器的预算砍到 30 个节点 | `tools/engine-test.mjs` | `计数器在官方 5x5 上恰好数出 1` |
| K12 | 页面上同一条边点两次记成两步 | `bash tools/verify.sh`（只跑 play 那条腿） | `步数 = 落下的笔数（同一条边点两次不虚记一步）` |
| K13 | 这一行不是刀，是反向的：把名单里的六条红线各自单独打破一次 | `node tools/balance.mjs --dose`（底压到 6 张只为省机器） | 六条全部报「打中」，一条落空就是闸坏了 |
| K14 | 把台账在 CI 里那一步换成 `echo "ledger not wired"`（台架还在、没人跑它） | `tools/doctest.mjs` | `D6e 破坏台账接进了 browser job、package.json 与 README` |

K13 正是查出 B4 曾经恒真的那一次。出题器 `dig()` 从满线索起逐条摘、摘得动就摘，所以**出货盘按构造就是一条都
摘不动**，而 B4 当时数的是生成器自报的那个数——自己和自己比，永远绿，剂量当场报
`ERROR 剂量 B4 没打中`。现在 B4 在 balance 里独立重数一遍再和生成器对账，剂量的阳性对照改用**外部**那张盘
（官方 Nikoli 5×5 的 6 条线索里有一条摘掉仍能推满），「一条都摘不动」于是第一次有了能红的路径。

台账没覆盖的部分照旧写在下面的「不承诺」里：K8 钉的是"文档说的等于脚本里有的"，不是"每条红线都有台架"，
名单里本来就没有出盘率那一条。

## 承诺表

每条承诺都指着一个会为它变红的东西；指不到的都写在下面的"不承诺"里。

| 承诺 | 谁在守 |
|---|---|
| 出货的每一盘**唯一** | `B3` 从线索集合重数；`engine-test` A/C/D；浏览器 `gen` 场景用页面上那同一个 `count.js` 独立数一遍（不转抄生成器填的 stats） |
| 唯一解**零猜测可推满**，且每笔点名一条规则 | `B2`；`engine-test` E；`gen` 场景的 `solve()`（`pinned` 且 `unknown=0`，推出的那一环就是出货那张解） |
| 十条规则没有装饰 | `B6 无装饰性规则`（跨样本开火统计）＋ `gen` 场景把菜单各档命中的规则并起来必须等于十条 |
| 判胜只由引擎的 `verify` 说了算 | `win` 场景：画满才掀开胜利卡；界面上没有第二条宣布胜利的路 |
| 同一个 seed 永远同一张盘 | `engine-test` G ＋ `gen` 场景的指纹比对 ＋ node/Chrome 跨引擎（rng 只用整数运算） |
| 菜单只列预算内证得完的档，越线的档印出自己的读数 | `B5` 双向（漏点名＝红、这次不越线却还挂着＝说谎＝红、理由里没数字＝红）＋ `offmenu` 场景（存档里那一档已出菜单时当众作废） |
| 刷新续上这一局，指纹对不上就作废并说原因 | `save` / `resume` / `corrupt` 三条场景腿（证人由 node 在派发导航之前取走） |
| 指针、触屏、键盘落进同一个 `Game` 入口 | `mouse` / `touch` / `keys` 三条真事件腿（CDP `Input.dispatch*`），每条先断言 hit box 再断言点得到 |
| 读屏玩家拿得到光标行列与规则原文 | `keys` 腿的 `sr-only` 断言与 `#state-line` 同一条账 |
| 页面在 Pages 子路径下也起得来 | 形态 B 由第二个 server 的软链根服务，前缀真挂在 URL 上 |
| 这个闸会红 | `GATE_SELFTEST=1`：32 份报告每份都要点名吃下自己那条种下的错，且 rc≠0 |

## 不承诺

- **出题耗时**。8×8 一张盘可能要几十秒（观测值见 `_tmp-midloop-ladder-5-10-8.log`），玩家等的是这台机器的墙钟。
  要兜底得先把出题挪进 worker——现在没有，所以这里不写"秒开"。
- **唯一 ⇒ 可推**。反过来成立（推满＋数过），正过来不：铅笔十条不完备，某个唯一解的盘可能推到一半就哑。
  出货盘能被推满是构造＋复测的结果，不是定理。
- **真手机与真触摸板**。`touch` 腿发的是 CDP 触屏事件、跑在 900×900 桌面窗口里；本仓没有做设备仿真，
  所以不承诺"手机上就是这个手感"。
- **难度分级**。菜单那一根轴是**尺寸**，成本按节点数请出过一档；没有"初级/中级/大师"这种承诺。
- **跨机器搬存档**。存档带指纹，换机器/换 seed 就是作废并重新开始（这是上一条承诺，不是续命承诺）。
- **9×9 与 10×10**。它们被实测请出菜单，`TOO_EXPENSIVE` 带着读数挂在引擎里；玩家拿到的盘仍然张张数得完，
  但这一档的成本分布不允许把它当一个承诺卖出去。
- **B1 的单独可打破性**。`--dose` 剂量了 B2/B3/B3b/B4/B5/B6 六条；出盘率（B1）只有正跑的红线，
  没有"把它单独打破一次"的台架（要造一张出不了盘的档，得先造一个出不了盘的生成器分支）。
  B3b 只被剂量了「可比张数」这条腿；「两边解数不同」那半句还没有剂量项——两边同为 1 的对照若坏在
  看不见解集的地方，这一半只能靠 `B3b` 自己红。
- **撞车判断**。上面那段"没有先例"和"Arukone 管段长、本玩法管中点"的区别，都是立项时的一次人工比对：
  本仓的闸不 grep 兄弟仓（CI 里各仓独立 checkout，谁也看不见谁），所以这两句是可争议的，不是可复测的。
  它们的作用是说清凭什么建仓，不是承诺。

