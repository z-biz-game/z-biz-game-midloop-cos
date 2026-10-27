# ミッドループ Mid-loop · 点是那段直线的正中 · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

盘上有些点，有的在格子正中、有的压在两格之间的那条格线上。答案是一条不自交的闭环：它必须经过每一个点，

- 仓名：`z-biz-game-midloop-cos`　组别：E · 生成艺术与交互视觉
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node server.cjs
```

README 的快速开始：

```sh
npm run dev      # node server.cjs 5281
npm test         # node tools/engine-test.mjs（纯 node，判据 1/2 的正面证据 + 三组反空转对照）
npm run balance  # node tools/balance.mjs（红线 B1/B2/B3/B3b/B4/B5/B6，默认 48 张 × 3 个候选 × 6 档）
npm run doctest  # node tools/doctest.mjs（本文与 DESIGN 里每一个现值都等于代码的现在值）
npm run verify   # bash tools/verify.sh（先跑三道逻辑闸 engine-test / doctest / 台账，再上真 Chrome + 裸 CDP，两种 URL 形态）
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |
| 文档腿 | `node tools/doctest.mjs` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 44 |
| 应用代码 | 4,177 行（JS 3,628 / CSS 413 / HTML 136） |
| 测试/工具文件 | 11 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 0 |
| 位图资产（不含 shots） | 6 个 / 290 KB |

## 目录

```
.github .gitignore DESIGN.md LICENSE README.md css icons index.html js manifest.webmanifest package.json server.cjs sw.js tools
```

## 已知边界

README 没有单列“未实现/限制”小节；以 README 正文与仓内闸为准。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-midloop-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
