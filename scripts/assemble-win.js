#!/usr/bin/env node
'use strict';
// Windows x64 打包：跨平台执行（在 macOS/Linux 上构建 win32 目标），产出绿色目录 + zip。
// 思路与 assemble.sh 一致：直接组装官方 electron zip（不走 electron-packager——
// 其在非 Windows 主机上嵌 exe 图标/版本需要 Wine，本机没有时会静默挂死）。
// exe 图标/版本信息：检测到 wine 时用 rcedit 嵌入（node_modules 自带 rcedit-x64.exe），
// 没有则跳过（exe 显示 Electron 默认图标，zip 里附带 icon.ico 供快捷方式使用）。
//
// 产物：dist/HubTerm-win32-x64/ 与 dist/HubTerm-<版本>-win-x64.zip（未签名，SmartScreen 会提示）
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EV = require(path.join(ROOT, 'node_modules/electron/package.json')).version;
const APPV = require(path.join(ROOT, 'package.json')).version;
const ARCH = 'x64';
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

function run(cmd, args, opts = {}) {
  console.log(`==> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/** 在 electron 缓存里找 win32 zip；没有则从镜像下载（与 assemble.sh 共用缓存目录） */
function findOrDownloadZip() {
  const cacheGlobDir = path.join(process.env.HOME || '', 'Library', 'Caches', 'electron');
  const name = `electron-v${EV}-win32-x64.zip`;
  const found = fs.existsSync(cacheGlobDir)
    ? fs.readdirSync(cacheGlobDir)
        .map((d) => path.join(cacheGlobDir, d, name))
        .filter((p) => fs.existsSync(p))
        .find(Boolean)
    : null;
  if (found) return found;
  const dlDir = path.join(cacheGlobDir, 'hubterm-dl');
  fs.mkdirSync(dlDir, { recursive: true });
  const dest = path.join(dlDir, name);
  console.log(`==> 缓存无 ${name}，从镜像下载`);
  run('curl', ['-fL', '--progress-bar', '-o', dest, `${MIRROR}/v${EV}/${name}`]);
  return dest;
}

(async () => {
  console.log('==> 1/5 运行测试');
  run('node', ['test/automaton.test.js']);
  run('node', ['test/zmodem.test.js']);
  run('node', ['test/mcp.test.js']);

  console.log('==> 2/5 应用 zmodem 兼容补丁 + 确认 icon.ico');
  run('sh', ['scripts/patch-zmodem.sh']);
  const ico = path.join(ROOT, 'assets', 'icon.ico');
  if (!fs.existsSync(ico)) {
    // 生成 icon 需要 Pillow；逐个探测可用的解释器（默认 python3 未必装了 PIL）
    const py = ['python3.13', 'python3.12', 'python3', '/usr/bin/python3'].find((p) => {
      try { execFileSync(p, ['-c', 'import PIL'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
    });
    if (!py) throw new Error('生成 assets/icon.ico 需要 Pillow（pip3 install pillow）；或先在任意机器生成后放入 assets/');
    run(py, ['scripts/make_ico.py']);
  }

  console.log('==> 3/5 组装 win32-x64 应用目录');
  const zip = findOrDownloadZip();
  const out = path.join(ROOT, 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, '_x'), { recursive: true });
  run('unzip', ['-q', zip, '-d', path.join(out, '_x')]);
  const dir = path.join(out, 'HubTerm-win32-x64');
  fs.renameSync(path.join(out, '_x'), dir);
  fs.renameSync(path.join(dir, 'electron.exe'), path.join(dir, 'HubTerm.exe'));
  fs.rmSync(path.join(dir, 'resources', 'default_app.asar'), { force: true });

  // 代码 + 生产依赖（与 assemble.sh 相同的排除清单；纯 JS，无平台原生件）
  const appDir = path.join(dir, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  run('rsync', ['-a',
    '--exclude', 'electron', '--exclude', 'electron-packager', '--exclude', '.bin',
    '--exclude', 'cpu-features', '--exclude', 'nan',
    'node_modules/', path.join(appDir, 'node_modules') + '/']);
  for (const f of ['main.js', 'preload.js', 'lib', 'renderer', 'package.json']) {
    execFileSync('cp', ['-R', f, appDir], { cwd: ROOT });
  }

  console.log('==> 4/5 嵌入 exe 图标/版本（需 wine）');
  const wine = spawnSync('sh', ['-c', 'command -v wine'], { encoding: 'utf8' }).stdout;
  if (wine && String(wine).trim()) {
    const rcedit = require('rcedit');
    await rcedit(path.join(dir, 'HubTerm.exe'), {
      'version-string': {
        CompanyName: 'luyicheng',
        FileDescription: 'HubTerm',
        ProductName: 'HubTerm',
        LegalCopyright: 'MIT License',
      },
      'product-version': APPV,
      'file-version': APPV,
      icon: ico,
    });
    console.log('    ✓ rcedit 完成（wine）');
  } else {
    execFileSync('cp', [ico, dir]);
    console.log('    跳过（未安装 wine；exe 用默认图标，icon.ico 已附在目录里供快捷方式使用）');
  }

  console.log('==> 5/5 打 zip');
  const zipPath = path.join(out, `HubTerm-${APPV}-win-x64.zip`);
  try {
    execFileSync('zip', ['-qr9', path.basename(zipPath), path.basename(dir)], { cwd: out, stdio: 'inherit' });
  } catch (e) {
    console.log('（zip 命令不可用，跳过压缩；绿色目录已生成）');
  }
  console.log(`✓ 完成: ${dir}`);
  if (fs.existsSync(zipPath)) console.log(`     压缩包: ${zipPath}`);
  console.log('  注意：未签名，Windows 首次运行会弹 SmartScreen 提示（更多信息 → 仍要运行）');
})().catch((e) => {
  console.error('打包失败:', e && e.message ? e.message : e);
  process.exit(1);
});
