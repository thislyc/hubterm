'use strict';
/* 更新检查：对比 GitHub Releases latest 与当前版本。
   只检测与提示，不做静默自替换——macOS 的 Squirrel 自更新强制要求正式签名
   （ad-hoc 签名无法校验），未签名阶段的标准做法是引导用户到 Releases 下载。
   endpoint/fetchImpl 可注入，供离线测试使用。 */
const REPO = 'thislyc/hubterm';

function parseVer(s) {
  const m = String(s || '').trim().replace(/^v/i, '').match(/^\d+(?:\.\d+){0,3}/);
  return m ? m[0].split('.').map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVer(latest);
  const b = parseVer(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkForUpdates({ currentVersion, endpoint, fetchImpl, timeoutMs = 8000 } = {}) {
  const f = fetchImpl || fetch;
  const url = endpoint || `https://api.github.com/repos/${REPO}/releases/latest`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HubTerm-Updater' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    if (!latest || !parseVer(latest)) throw new Error('bad tag_name');
    return {
      status: isNewer(latest, currentVersion) ? 'available' : 'up-to-date',
      latest,
      currentVersion,
      url: j.html_url || `https://github.com/${REPO}/releases/latest`,
      notes: String(j.body || '').slice(0, 2000),
      prerelease: j.prerelease === true,
    };
  } catch (e) {
    return { status: 'error', currentVersion, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdates, isNewer, parseVer, REPO };
