#!/bin/sh
# HubTerm 一键构建安装：测试 -> 补丁 -> 组装 -> 安装 -> 清理 dist（防 Spotlight 重复）
# 用法: sh scripts/assemble.sh [arch]
#   arch 缺省 = 本机架构；Intel Mac 传 x64（electron zip 缺失时自动从镜像下载）
#   HUBTERM_DEST=/path/HubTerm.app 可改安装目的地（默认 /Applications；
#   改目的地时不 pkill 旧实例，方便并行验证多架构产物）
set -e
cd "$(dirname "$0")/.."

ARCH="${1:-$(uname -m | sed 's/x86_64/x64/')}"
DEST="${HUBTERM_DEST:-/Applications/HubTerm.app}"
EV=$(node -p "require('./node_modules/electron/package.json').version")
MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

echo "==> 1/5 运行测试"
node test/automaton.test.js
node test/zmodem.test.js
node test/mcp.test.js

echo "==> 2/5 应用 zmodem 兼容补丁"
sh scripts/patch-zmodem.sh

ZIP=$(ls "$HOME/Library/Caches/electron/"*/electron-v$EV-darwin-$ARCH.zip 2>/dev/null | head -1)
if [ -z "$ZIP" ]; then
  echo "==> 缓存无 electron v$EV darwin-$ARCH，从镜像下载"
  mkdir -p "$HOME/Library/Caches/electron/hubterm-dl"
  curl -fL --progress-bar -o "$HOME/Library/Caches/electron/hubterm-dl/electron-v$EV-darwin-$ARCH.zip" \
    "$MIRROR/v$EV/electron-v$EV-darwin-$ARCH.zip"
  ZIP="$HOME/Library/Caches/electron/hubterm-dl/electron-v$EV-darwin-$ARCH.zip"
fi

echo "==> 3/5 组装 app bundle (darwin-$ARCH)"
rm -rf dist
mkdir -p dist
unzip -q "$ZIP" -d dist/_x
mv dist/_x/Electron.app dist/HubTerm.app
rm -rf dist/_x
APP=dist/HubTerm.app
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/HubTerm"
rm -f "$APP/Contents/Resources/default_app.asar"
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"
P=/usr/libexec/PlistBuddy
$P -c "Set :CFBundleName HubTerm" "$APP/Contents/Info.plist"
$P -c "Set :CFBundleDisplayName HubTerm" "$APP/Contents/Info.plist"
$P -c "Set :CFBundleExecutable HubTerm" "$APP/Contents/Info.plist"
$P -c "Set :CFBundleIdentifier com.luyicheng.hubterm" "$APP/Contents/Info.plist"
VERSION=$(node -p "require('./package.json').version")
$P -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
$P -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources/app"
rsync -a --exclude 'electron' --exclude 'electron-packager' --exclude '.bin' --exclude 'cpu-features' --exclude 'nan' node_modules/ "$APP/Contents/Resources/app/node_modules/"
cp -R main.js preload.js lib renderer package.json "$APP/Contents/Resources/app/"
codesign --force --deep -s - "$APP" 2>&1 | grep -v "^$" || true

echo "==> 4/5 安装到 $DEST"
if [ "$DEST" = "/Applications/HubTerm.app" ]; then
  pkill -x HubTerm 2>/dev/null || true
  sleep 1
fi
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$APP" "$DEST"

echo "==> 5/5 清理构建目录（避免 Spotlight 出现两个 HubTerm）"
rm -rf dist

echo "✓ 完成: $DEST (darwin-$ARCH)"
