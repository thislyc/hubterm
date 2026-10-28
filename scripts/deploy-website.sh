#!/bin/sh
# 把 website/ 同步到 gh-pages 分支并推送（GitHub Pages 源分支）
# 用法: sh scripts/deploy-website.sh
# 前提: 仓库 Settings → Pages 已选择 gh-pages 分支（本仓库已配置）
set -e
cd "$(dirname "$0")/.."

W=$(mktemp -d)
trap 'git worktree remove --force "$W" 2>/dev/null || true' EXIT

if git show-ref --verify --quiet refs/heads/gh-pages; then
  git worktree add "$W" gh-pages
else
  git worktree add --orphan -b gh-pages "$W"
fi

# 清空工作树内容（保留 .git），拷入最新站点
find "$W" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R website/. "$W"/

cd "$W"
git add -A
if git diff --cached --quiet; then
  echo "✓ 站点无变化"
else
  git commit -m "site: sync from main website/ ($(date +%F))"
  if ! git push origin gh-pages 2>/dev/null; then
    git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin gh-pages
  fi
  echo "✓ 已推送 gh-pages，GitHub Pages 将自动重新部署"
fi
