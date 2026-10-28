#!/bin/sh
# 本地构建三平台并上传 GitHub Release（不依赖 GitHub Actions）
# 用法: sh scripts/release.sh [tag]      # tag 缺省 = v<package.json version>
# 流程: 构建 macOS arm64/x64 + Windows x64 → 推 main 与 tag → 创建 Release → 上传产物
# 依赖: npm 依赖已装好；网络走直连，失败自动回退 Clash 代理 (127.0.0.1:7897)
set -e
cd "$(dirname "$0")/.."
export HUBTERM_RELEASE=1   # 让本机 pre-push 钩子放行内部的 git push，避免递归

VERSION=$(node -p "require('./package.json').version")
TAG="${1:-v$VERSION}"
OUT=dist-release
PROXY_ARGS=()
try_curl() {
  # try_curl <curl 参数...>：先直连，失败走代理再试一次
  curl -sS -f "$@" || curl -sS -f -x http://127.0.0.1:7897 "$@"
}

echo "==> [1/5] 构建 macOS arm64"
rm -rf "$OUT"; mkdir -p "$OUT"
HUBTERM_DEST="$PWD/$OUT/HubTerm.app" sh scripts/assemble.sh
ditto -c -k --keepParent "$OUT/HubTerm.app" "$OUT/HubTerm-macOS-arm64.zip"

echo "==> [2/5] 构建 macOS x64"
HUBTERM_DEST="$PWD/$OUT/HubTerm-x64.app" sh scripts/assemble.sh x64
ditto -c -k --keepParent "$OUT/HubTerm-x64.app" "$OUT/HubTerm-macOS-x64.zip"

echo "==> [3/5] 构建 Windows x64"
node scripts/assemble-win.js
mv dist/HubTerm-*-win-x64.zip "$OUT/"
ls -lh "$OUT"

echo "==> [4/5] 推送 main 与 $TAG"
git push origin main || git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag "$TAG"
git push origin "refs/tags/$TAG" || git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin "refs/tags/$TAG"

echo "==> [5/5] 创建 Release 并上传产物"
TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill | awk -F= '/^password=/{print $2}')
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
