#!/bin/sh
# 本地构建三平台并上传 GitHub Release（不依赖 GitHub Actions）
# 用法: sh scripts/release.sh [tag]          # tag 缺省 = v<package.json version>
#       SKIP_BUILD=1 sh scripts/release.sh   # 跳过构建，直接上传 dist-release/ 里现成的产物
# 流程: 推 main 与 tag（快速失败暴露网络问题）→ 构建三平台 → 创建 Release → 上传产物
# 依赖: npm 依赖已装好；网络直连失败自动回退代理（通过 HUBTERM_PROXY 环境变量指定，如 http://127.0.0.1:7897）
set -e
cd "$(dirname "$0")/.."
export HUBTERM_RELEASE=1   # 让本机 pre-push 钩子放行内部的 git push，避免递归

VERSION=$(node -p "require('./package.json').version")
TAG="${1:-v$VERSION}"
OUT=dist-release
PROXY="${HUBTERM_PROXY:-}"

git_push() {
  # git_push <参数...>：直连与代理各试 3 次
  i=0
  until git push "$@" 2>/dev/null; do
    i=$((i + 1))
    if [ $i -ge 3 ] && [ -n "$PROXY" ]; then
      echo "    直连失败，走代理重试"
      until git -c http.proxy="$PROXY" -c https.proxy="$PROXY" push "$@" 2>/dev/null; do
        i=$((i + 1)); [ $i -ge 8 ] && return 1; sleep 5
      done
      return 0
    fi
    [ $i -ge 8 ] && return 1
    sleep 3
  done
}

echo "==> [1/5] 推送 main 与 $TAG"
git_push main
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag "$TAG"
git_push "refs/tags/$TAG"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> [2/5] 构建 macOS arm64"
  rm -rf "$OUT"; mkdir -p "$OUT"
  HUBTERM_DEST="$PWD/$OUT/HubTerm.app" sh scripts/assemble.sh
  ditto -c -k --keepParent "$OUT/HubTerm.app" "$OUT/HubTerm-macOS-arm64.zip"

  echo "==> [3/5] 构建 macOS x64"
  HUBTERM_DEST="$PWD/$OUT/HubTerm-x64.app" sh scripts/assemble.sh x64
  ditto -c -k --keepParent "$OUT/HubTerm-x64.app" "$OUT/HubTerm-macOS-x64.zip"

  echo "==> [4/5] 构建 Windows x64"
  node scripts/assemble-win.js
  mv dist/HubTerm-*-win-x64.zip "$OUT/"
fi
ls -lh "$OUT"

echo "==> [5/5] 创建 Release 并上传产物"
TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill | awk -F= '/^password=/{print $2}')
try_curl() {
  # try_curl <curl 参数...>：直连失败走代理（HUBTERM_PROXY），各试 2 次
  if [ -n "$PROXY" ]; then
    curl -sS -f "$@" || curl -sS -f -x "$PROXY" "$@" || curl -sS -f "$@" || curl -sS -f -x "$PROXY" "$@"
  else
    curl -sS -f "$@" || curl -sS -f "$@"
  fi
}
RELEASE_JSON=$(try_curl -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/thislyc/hubterm/releases \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"generate_release_notes\":true}")
RELEASE_ID=$(printf '%s' "$RELEASE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.id){console.error('创建 Release 失败:',j.message);process.exit(1)}console.log(j.id)})")
UPLOAD_URL=$(printf '%s' "$RELEASE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).upload_url.split('{')[0]))")

for f in "$OUT"/*.zip; do
  NAME=$(basename "$f")
  echo "    上传 $NAME ($(du -h "$f" | cut -f1))"
  try_curl -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" "$UPLOAD_URL?name=$NAME" >/dev/null
done

echo "✓ 完成: https://github.com/thislyc/hubterm/releases/tag/$TAG"
