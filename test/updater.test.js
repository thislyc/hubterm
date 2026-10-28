'use strict';
// 更新检查测试：版本比较 + checkForUpdates 对本地 mock 服务器的三种结局（新版本/最新/出错）
const http = require('http');
const assert = require('assert');
const { checkForUpdates, isNewer, parseVer } = require('../lib/updater');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

function serve(body, status = 200) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

(async () => {
  // 版本比较
  ok('isNewer: 2.9.0 > 2.8.0', isNewer('v2.9.0', '2.8.0'));
  ok('isNewer: 2.8.1 > 2.8.0', isNewer('2.8.1', 'v2.8.0'));
  ok('isNewer: 相等 = false', !isNewer('v2.8.0', '2.8.0'));
  ok('isNewer: 旧版本 = false', !isNewer('2.7.9', '2.8.0'));
  ok('isNewer: 补零比较 2.8 = 2.8.0', !isNewer('v2.8', '2.8.0'));
  ok('parseVer: 剥 v 前缀', JSON.stringify(parseVer(' v2.10.3 ')) === '[2,10,3]');
  ok('parseVer: 非法输入 = null', parseVer('abc') === null);

  // available
  let h = await serve({ tag_name: 'v2.9.0', html_url: 'http://127.0.0.1/r', body: '## Fixes\n- a' });
  let r = await checkForUpdates({ currentVersion: '2.8.0', endpoint: `http://127.0.0.1:${h.port}` });
  ok('available: 新版本被识别', r.status === 'available' && r.latest === '2.9.0', r.status);
  ok('available: 携带 release url 与 notes', r.url === 'http://127.0.0.1/r' && r.notes.includes('Fixes'));
  h.s.close();

  // up-to-date
  h = await serve({ tag_name: 'v2.8.0', html_url: 'http://127.0.0.1/r' });
  r = await checkForUpdates({ currentVersion: '2.8.0', endpoint: `http://127.0.0.1:${h.port}` });
  ok('up-to-date: 同版本', r.status === 'up-to-date', r.status);
  h.s.close();

  // HTTP 错误
  h = await serve('{"message":"Not Found"}', 404);
  r = await checkForUpdates({ currentVersion: '2.8.0', endpoint: `http://127.0.0.1:${h.port}` });
  ok('error: HTTP 404 归一为 error 状态', r.status === 'error' && /404/.test(r.error), r.error);
  h.s.close();

  // 坏响应体
  h = await serve('not-json', 200);
  r = await checkForUpdates({ currentVersion: '2.8.0', endpoint: `http://127.0.0.1:${h.port}` });
  ok('error: 非法 JSON 归一为 error 状态', r.status === 'error', r.error);
  h.s.close();

  const pass = results.filter((x) => x.pass).length;
  console.log(`\n结果: ${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
})();
