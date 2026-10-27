'use strict';
// store 层测试：snippets / forwards / known_hosts / 会话导入合并（临时 HOME 隔离）
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离 HOME，避免污染真实 ~/.hubterm
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-store-'));
process.env.HOME = FAKE_HOME;
delete require.cache[require.resolve('../lib/store')];
const store = require('../lib/store');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

// snippets
store.saveSnippets([{ id: 'sn1', name: 'df', command: 'df -h' }]);
ok('snippets 保存+读取', store.listSnippets().length === 1 && store.listSnippets()[0].command === 'df -h');

// forwards
store.saveForwards({ 'tc/k8s/x': [{ id: 'f1', listen: 8080, host: '10.0.0.1', port: 80, enabled: true }] });
ok('forwards 按 key 读取', store.forwardsFor('tc/k8s/x')[0].listen === 8080);
ok('forwards 空 key', store.forwardsFor('none').length === 0);

// known_hosts
store.saveKnownHosts({ 'h:22': 'AAA' });
const kh = store.listKnownHosts();
ok('known_hosts 保存+读取', kh['h:22'] === 'AAA');

// 导出/导入
const current = [
  { key: 'g/a', name: 'a', host: '1.1.1.1', type: 'direct', port: 22, user: 'root', target: '', tuser: '', group: 'g', post: '', password: 'oldpw' },
  { key: 'g/b', name: 'b', host: '2.2.2.2', type: 'direct', port: 22, user: 'root', target: '', tuser: '', group: 'g', post: '', password: 'b' },
];
const exported = store.exportSessions(current);
const parsed = JSON.parse(exported);
ok('导出包含全部会话与密码', parsed.sessions.length === 2 && parsed.sessions[0].password === 'oldpw');

const imported = store.importSessions(current, {
  sessions: [
    { key: 'g/a', name: 'a2', host: '9.9.9.9', type: 'direct', port: 22, user: 'root', target: '', tuser: '', group: 'g', post: '', password: '' }, // 覆盖但密码为空 → 保留 oldpw
    { key: 'g/c', name: 'c', host: '3.3.3.3', type: 'direct', port: 22, user: 'root', target: '', tuser: '', group: 'g', post: '', password: 'c' }, // 新增
  ],
});
ok('导入: 新增 1', imported.added === 1);
ok('导入: 更新 1', imported.updated === 1);
const a = imported.merged.find((s) => s.key === 'g/a');
ok('导入: 空密码保留原密码', a.password === 'oldpw' && a.host === '9.9.9.9');
ok('导入: 总数 3', imported.merged.length === 3);

// 格式错误
let threw = false;
try { store.importSessions(current, { foo: 1 }); } catch (e) { threw = true; }
ok('导入: 错误格式抛异常', threw);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
