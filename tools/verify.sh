#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, real input events, scripted scenarios.
#
#   ./tools/verify.sh                 # 两条 URL 形态各跑一遍（根 / 与 Pages 的 /z-biz-game-midloop-cos/）
#   SCENARIOS="play hint" ./tools/verify.sh
#   LEGS="core mouse" ./tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-midloop-cos/ ./tools/verify.sh   # 追加已部署站点这一形态
#   GATE_SELFTEST=1 ./tools/verify.sh   # 阴性自证：种一条注定错的期望，必须点名变红并且 rc 非 0
#
# 这个仓的规矩，改之前先读：
#  * 每一腿一个自己的 --user-data-dir（mktemp -d 在 _tmp-verify 里），写完档的腿自己清档；
#    共用 profile 会让"续局"那条腿读到自己上一腿留下的档，看起来像绿其实什么都没测。
#  * 指针断言走 CDP Input.dispatch*（真事件），并且断言点击之前先断言 hit box：
#    getBoundingClientRect() 的中心要与 document.elementFromPoint() 对得上。display:grid 会盖掉
#    UA 的 [hidden]，所以"这一块藏起来了"必须由几何作证，不能假设。
#  * 片段导航不算重载：续局腿的证人（timeOrigin + doc + 哨兵）由 node 在派发导航之前取走。
#  * 前缀形态由**第二个服务器**服务（根目录是一个只放着软链的临时目录），不是让一个服务器
#    替被测对象把 /z-biz-game-midloop-cos/ 这个前缀吃掉——server.cjs 刻意不做那个兜底。
#  * 不要加 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader：软件光栅会占满
#    每一个核，而且在没有 CDP 客户端 attached 时 Chrome 根本不会自己退。
#  * macOS 没有 timeout：看门狗用后台子 shell + trap（下面的 WD）。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${CDP_PORT:-9381}
# 5281/5282 是本仓自己的端口；别的 agent 同时在跑各自仓的 verify.sh，端口撞了就会拿到"另一个仓"的
# index.html，那种绿比红更糟。
HTTP=${HTTP_PORT:-5281}
HTTP2=${HTTP_PORT2:-5282}
SELF=${GATE_SELFTEST:-0}
TMPD="$HERE/_tmp-verify"
rm -rf "$TMPD"; mkdir -p "$TMPD"

# ---- 逻辑闸（纯 node，不开浏览器）：排在找 Chrome、起服务之前 ----
# CI 的 check job 跑 engine-test 与 doctest，台账在 browser job 里另有一步，而这一道本地
# one-shot 以前一步都不跑：改闸的人在家里看见的绿，和 CI 那套绿不是同一套。门要两边同一把。
# 钉的是每道闸自己的条数——rc=0 看不出闸变窄：删掉 20 条断言，剩下的照样绿，整道闸照样 exit 0。
# 这两颗钉由 tools/doctest.mjs 的 D11 反向核对（它读的就是下面这一行），改一处不改另一处就是红。
FAILED=0
LOGIC_EXPECTS="doctest:54 sabotage:16"
pin_of() { printf '%s\n' "$LOGIC_EXPECTS" | tr ' ' '\n' | grep "^$1:" | cut -d: -f2; }
LLOG="$TMPD/logic.log"

node "$HERE/tools/engine-test.mjs" >"$LLOG" 2>&1
ET_RC=$?
ET=$(sed -n 's/^\([0-9]*\) checks, \([0-9]*\) failed$/\1\/\2/p' "$LLOG" | tail -1)
if [ -z "$ET" ]; then
  echo "逻辑闸 engine-test：没打印「N checks, M failed」这一行（rc=$ET_RC），分不清跑完了还是没有" >&2
  tail -20 "$LLOG" >&2; FAILED=1
elif [ "$ET_RC" != 0 ] || [ "${ET#*/}" != 0 ]; then
  echo "逻辑闸 engine-test 红：$ET（rc=$ET_RC）" >&2; FAILED=1
else
  echo "逻辑闸 engine-test：${ET%/*} 条检查、0 失败 ✓"
fi

node "$HERE/tools/doctest.mjs" >"$LLOG" 2>&1
DS_RC=$?
DS=$(sed -n 's/^rows: \([0-9]*\) fail: \([0-9]*\)$/\1\/\2/p' "$LLOG" | tail -1)
grep -E '^  未过：' "$LLOG" | head -25
if [ "$DS" != "$(pin_of doctest)/0" ]; then
  echo "逻辑闸 doctest 体量 ${DS:-未打印 rows:} != 钉的 $(pin_of doctest)/0（rc=$DS_RC）—— 增删一条断言要同时改 LOGIC_EXPECTS 与 D11b" >&2
  FAILED=1
else
  echo "逻辑闸 doctest：$(pin_of doctest) 项、0 项失败 ✓"
fi

# 台账有一把刀会真叫 tools/verify.sh（LEGS=play），而 verify.sh 现在自己也叫台账：
# 不给嵌套那一层设哨兵就是闸与刀互相调用，谁都不肯先收口。env 由 sabotage.mjs 派发时设上。
# 阴性自证那一跑也跳过：SELF=1 给浏览器腿种的是注定错的期望，每一把刀的 rc 都会因此非 0，
# 于是"红"不再归因于刀——台账要在干净的树上量，这才是它自己那句承诺。
if [ -n "${MIDLOOP_VERIFY_INSIDE_LEDGER:-}" ]; then
  echo "台账：跳过（这一层是台账自己叫起的 verify.sh）"
elif [ "${SELF}" = "1" ]; then
  echo "台账：跳过（GATE_SELFTEST 这一跑的浏览器腿本来就红，刀的红没有归因）"
else
  MIDLOOP_VERIFY_INSIDE_LEDGER=1 node "$HERE/tools/sabotage.mjs" >"$LLOG" 2>&1
  SB_RC=$?
  # BSD sed 的基本正则不认 `\|`：写成 `\(yes\|NO\)` 时这条 s/// 永远不命中，于是台账明明打了
  # `rows: 16 …: yes`，门却报「未打印 rows:」。这里只数到第一个冒号后的整段，靠下面的等式判 yes。
  SB=$(sed -n 's/^rows: \([0-9]*\).*: \(.*\)$/\1\/\2/p' "$LLOG" | tail -1)
  cat "$LLOG"   # 逐把读数打进整闸日志：$LLOG 末尾会被 rm -f，不留下来就只有那 6 行尾巴当证人
  if [ "$SB" != "$(pin_of sabotage)/yes" ]; then
    echo "台账体量 ${SB:-未打印 rows:} != 钉的 $(pin_of sabotage)/yes（rc=$SB_RC）—— 刀少了或某一刀没能把点名的断言逼红" >&2
    FAILED=1
  else
    echo "台账：$(pin_of sabotage) 把刀各自逼红了点名的断言 ✓"
  fi
fi
rm -f "$LLOG"

CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

SPID=0
SPID2=0
LOCAL=1
# 形态 A：根 /（本地开发时浏览器里看到的那个 URL）
node "$HERE/server.cjs" "$HTTP" >"$TMPD/server.log" 2>&1 &
SPID=$!
# 形态 B：Pages 的 /<仓库名>/ 前缀。用一个只放着软链的根目录，让前缀是真的挂在 URL 上，
# 而不是服务器顺手替页面兜底——兜底会把线上 404 的写死绝对路径在这里伪装成正常。
mkdir -p "$TMPD/pages-root"
ln -sfn "$HERE" "$TMPD/pages-root/z-biz-game-midloop-cos"
node "$HERE/server.cjs" "$HTTP2" "$TMPD/pages-root" >"$TMPD/server2.log" 2>&1 &
SPID2=$!
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
  sleep 0.25
done
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$HTTP2/z-biz-game-midloop-cos/" >/dev/null 2>&1 && break
  sleep 0.25
done

SHAPES=("http://127.0.0.1:$HTTP/" "http://127.0.0.1:$HTTP2/z-biz-game-midloop-cos/")
if [ -n "${BASE_URL:-}" ]; then
  SHAPES+=("$BASE_URL")
  case "$BASE_URL" in "http://127.0.0.1:$HTTP"*) ;; *) LOCAL=0 ;; esac
fi

# Pre-flight: prove the bytes we are about to test are this app's, not some other repo's
# index.html served on the same port. 两种形态都要过——Pages 的前缀形态挂了就是 404。
for base in "${SHAPES[@]}"; do
  SERVED=$(curl -fsS -m 5 "$base" 2>/dev/null || true)
  case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $base (see $TMPD/server.log)" >&2; exit 2 ;; esac
  echo "$SERVED" | grep -q 中点环 || { echo "$base 的 HTML 里没有 中点环" >&2; exit 2; }
  echo "$SERVED" | grep -q ミッドループ || { echo "$base 的 HTML 里没有 ミッドループ（日文正名）" >&2; exit 2; }
  curl -fsS -m 5 "${base}js/engine/rules.js" >/dev/null || { echo "$base 下取不到 js/engine/rules.js" >&2; exit 2; }
done
echo "preflight: ${#SHAPES[@]} 个 URL 形态都 served 且带 中点环/ミッドループ 标记 — ${SHAPES[*]}"

CPID=0
UDD=""
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ "$SPID2" != 0 ] && kill $SPID2 2>/dev/null
  [ "$CPID" != 0 ] && kill -9 $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
}
trap cleanup EXIT
( sleep ${WD_TIMEOUT:-2400}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# FAILED 在逻辑闸那一节就置过 0：这里再重置一次，等于把逻辑闸的红冲掉再开始浏览器段，
# 「本地全绿」就又是一句假话。
REPORTS="$TMPD/reports.txt"; : >"$REPORTS"; export REPORTS
LEGS=${LEGS:-core play win mouse touch keys save}

leg_start() {   # $1 = leg name, $2 = base url
  UDD=$(mktemp -d "$TMPD/udd-$1.XXXXXX")
  "$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir="$UDD" \
    --window-size=900,900 --no-first-run --no-default-browser-check about:blank >"$TMPD/chrome-$1.log" 2>&1 &
  CPID=$!
  # A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
  for i in $(seq 1 120); do
    curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
    echo "  RED devtools never bound on :$PORT (leg $1)" >&2; FAILED=1; return 1; }
  export CDP_PORT=$PORT BASE_URL="$2"
  echo "--- leg $1 @ $2 (profile $UDD)"
}
leg_stop() {   # 每条腿自己收自己的尸：profile 一定要删，写完的档不能留给下一条腿
  [ "$CPID" != 0 ] && kill -9 $CPID 2>/dev/null
  wait $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
  CPID=0; UDD=""
}

parse() {   # $1 = leg name (used as the printed name when a run dies before any assertion)
  python3 -c "
import sys, json, os
leg, selfmode = sys.argv[1], sys.argv[2] == '1'
path = os.environ['RESULT_FILE']
raw = ''
try:
    with open(path) as f:
        for line in f:
            if line.startswith('RESULT '): raw = line[7:].strip()
except FileNotFoundError:
    pass
if not raw:
    print('  RED %s：没有 RESULT 行（这一腿一条断言都没跑到）' % leg); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-56s %s' % (r['test'], r['detail']))
if not d['rows']:
    print('  RED %s：NO CHECKS RUN — a leg that asserts nothing cannot be green' % leg); sys.exit(1)
planted = sum(1 for r in d['rows'] if r['test'].startswith('GATE_SELFTEST') and not r['pass'])
if selfmode:
    # 先记账再判：把没种上的报告也写进对数表，末尾那句「实到几份 / 点名几份」才是有分母的数，
    # 而不是"只有种上的才被数到"的自比较。
    open(os.environ['REPORTS'], 'a').write('%s %d\n' % (leg, planted))
    if planted == 0:
        print('  RED %s：这一份报告里没有种下的错期望（这条腿证明不了自己能红）' % leg); sys.exit(1)
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" "$1" "${SELF:-0}" || FAILED=1
}

run_scenario() {   # $1 name, $2 leg
  export RESULT_FILE="$TMPD/$2-$1.out"
  node tools/playtest.cjs scenario "$1" >"$TMPD/$2-$1.out" 2>"$TMPD/$2-$1.console.log"
  sed -n 's/^EVIDENCE /  EVID /p' "$TMPD/$2-$1.out"
  parse "$2/$1"
  if [ -s "$TMPD/$2-$1.console.log" ]; then
    echo "  --- console ($2/$1) ---"
    sed 's/^/  /' "$TMPD/$2-$1.console.log" | tail -10
  fi
}

run_cmd() {   # $1 = tag（文件名安全的腿名）, 其余 = playtest 参数
  local tag="$1"; shift
  export RESULT_FILE="$TMPD/$tag.cmd.out"
  node tools/playtest.cjs "$@" >"$TMPD/$tag.cmd.out" 2>"$TMPD/$tag.cmd.console.log"
  sed -n 's/^EVIDENCE /  EVID /p' "$TMPD/$tag.cmd.out"
  grep -q '^RESULT ' "$TMPD/$tag.cmd.out" && parse "$tag"
  return 0
}

for base in "${SHAPES[@]}"; do
  echo
  echo "########## URL 形态 $base ##########"
  for leg in $LEGS; do
    case $leg in
      core)
        leg_start core "$base" || continue
        node tools/playtest.cjs open "$base" | head -3
        BOOT=""
        for i in $(seq 1 60); do
          BOOT=$(node tools/playtest.cjs eval "window.midloop?window.midloop.state:'nope'" nonav 2>/dev/null | tr -d '\n" ')
          case "$BOOT" in *nope*|*booting*|"") sleep 0.5 ;; *) break ;; esac
        done
        echo "  boot: midloop $BOOT @ $base"
        [ "$BOOT" = "ready" ] || { echo "  RED core：页面没到 ready（读到 $BOOT）" >&2; FAILED=1; }
        run_scenario engine core
        run_scenario gen core
        leg_stop ;;
      play)
        leg_start play "$base" || continue
        run_scenario play play
        run_scenario hint play
        leg_stop ;;
      win)
        leg_start win "$base" || continue
        run_scenario win win
        run_scenario layout win
        leg_stop ;;
      mouse)
        leg_start mouse "$base" || continue
        run_cmd mouseleg leg mouse
        leg_stop ;;
      touch)
        leg_start touch "$base" || continue
        run_cmd touchleg leg touch
        leg_stop ;;
      keys)
        leg_start keys "$base" || continue
        run_cmd keysleg leg keys
        leg_stop ;;
      save)
        leg_start save "$base" || continue
        run_scenario save save
        # 证人必须在派发导航之前拿到：node 先把 timeOrigin/doc/哨兵读回来。
        W=$(node tools/playtest.cjs witness | tail -1)
        echo "  WITNESS $W"
        export WITNESS="$W"
        # 对照腿：片段导航不算重载 —— timeOrigin 与文档身份都不许变。
        run_cmd fragleg nav "${base}#gate-fragment-nav" same
        # 续局腿：scenario 自己会做一次真导航，所以这里拿到的一定是新文档。
        run_scenario resume save
        # 坏档：顺序很重要。先真重载拿到一个干净的文档，再把坏 payload 种下去——
        # 反过来做的话，重载那一下的 pagehide 会让这个文档把它自己那局合法存档写回去，
        # 刚种下的坏档在 scenario 读到它之前就被覆写了。saveResume/save 一并摘掉（本页只读不写）。
        run_cmd reloadleg reload
        # payload 里的 seed/sizeKey/n 一律取页面上这一局自己的：出盘一定成功，于是这一腿比的
        # 就只有"指纹对不上"这一件事。shapedResume 还要求 n 是 2..64 的整数——少了它两条腿
        # 测的都是形状门，不是它们各自该测的那一道。
        node tools/playtest.cjs eval "window.__plantedGarbage='corrupt payload';
          window.midloop.store.save=function(){return this.data;};
          window.midloop.store.saveResume=function(){return null;};
          var g=window.midloop.game;
          localStorage.setItem('midloop.save.v1', JSON.stringify({v:1,settings:{},totals:{solved:0,moves:0,ms:0},
            resume:{seed:g.seed,sizeKey:g.sizeKey,n:g.n,marks:'1'.repeat(window.midloop.engine.marksLength(g.n)+3),
                    moves:99,elapsedMs:99000,fingerprint:g.puzzle.fingerprint+'|这一截是编的'}}));
          localStorage.setItem('midloop.save.v1:probe','1');" nonav >/dev/null 2>&1
        run_scenario corrupt save
        # 第二份坏档：形状完全合法、但 sizeKey 那一档已经被请出菜单（TOO_EXPENSIVE）。
        # 页面必须先认菜单再谈生成，否则玩家按刷新那一下要等一张证不完的盘。
        run_cmd reload2leg reload
        node tools/playtest.cjs eval "window.__planted9x9='shape-valid off-menu payload';
          window.midloop.store.save=function(){return this.data;};
          window.midloop.store.saveResume=function(){return null;};
          localStorage.setItem('midloop.save.v1', JSON.stringify({v:1,settings:{},totals:{solved:0,moves:0,ms:0},
            resume:{seed:window.midloop.game.seed,sizeKey:'9x9',n:9,
                    marks:'0'.repeat(window.midloop.engine.marksLength(9)),
                    moves:0,elapsedMs:0,fingerprint:window.midloop.game.puzzle.fingerprint}}));" nonav >/dev/null 2>&1
        run_scenario offmenu save
        leg_stop ;;
      *)
        # 未知腿名必须红，不能"匹配不到就算跑完了"：LEGS=hint 曾经一声不响地跑出
        # === ALL GREEN === 而一份报告都没有（hint 是 play 腿里的一条 scenario，不是腿名）。
        # ${leg} 的花括号不是装饰：没有 LANG 的环境里裸写 `$leg（` 会把全角括号的首字节算进
        # 变量名，报 unbound variable——红是红了，但点不出是哪个腿名。
        echo "  RED 未知的腿：${leg}（LEGS 只认 core play win mouse touch keys save）" >&2
        FAILED=1 ;;
    esac
  done
done

if [ "$SELF" = 1 ]; then
  echo
  echo "=== GATE_SELFTEST：种下的期望必须点名变红 ==="
  echo "  planted rows: scenarios.js 在 __selftest 为真时给每一份报告加一条 1==2，"
  echo "                node 侧的腿（真事件 / nav / reload）由 playtest.cjs 的 result() 加同一条"
  # 对数：一份报告对应一条种下的红。少一份＝那条腿这一轮根本没跑（或种期望的代码漂了），
  # 光看 rc≠0 是分不清这两件事的。
  EXPECTED=0
  for leg in $LEGS; do
    case $leg in
      core|play|win) EXPECTED=$((EXPECTED + 2)) ;;
      mouse|touch|keys) EXPECTED=$((EXPECTED + 1)) ;;
      save) EXPECTED=$((EXPECTED + 7)) ;;   # save/resume/corrupt/offmenu + frag nav + 两次 reload
      *) echo "  RED 未知的腿：${leg}（对数表里没有它）" >&2; FAILED=1 ;;
    esac
  done
  EXPECTED=$((EXPECTED * ${#SHAPES[@]}))
  GOT=$(wc -l <"$REPORTS" | tr -d ' ')
  HIT=$(awk '$2 > 0' "$REPORTS" | wc -l | tr -d ' ')
  echo "  应有 $EXPECTED 份报告，实到 $GOT 份，其中 $HIT 份点名吃下了种下的错"
  if [ "$GOT" != "$EXPECTED" ]; then
    echo "  RED 阴性自证的报告数对不上：$GOT ≠ $EXPECTED（有腿没跑，或对数表漂了）" >&2
    FAILED=1
  fi
  if [ "$FAILED" = 0 ]; then
    echo "  RED 阴性自证失败：闸没能把种下的错期望跑红（这个闸证明不了自己会红）" >&2
    FAILED=1
  elif [ "$HIT" != "$EXPECTED" ]; then
    echo "  RED 阴性自证只被 $HIT/$EXPECTED 份报告点名（差的那些腿从没红过＝没被证明会红）" >&2
    FAILED=1
  else
    echo "  ok 闸确实会红，且 rc 非 0"
  fi
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE (rc=$FAILED) ==="
exit $FAILED
