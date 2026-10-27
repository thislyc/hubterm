'use strict';
// ~/.ssh/config 导入器测试
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSSHConfig, toSessions } = require('../lib/sshconfig');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

const sample = `
# 注释行
Host web1
  HostName 10.0.0.11
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *.internal
  User root

Host db-jump
  HostName 10.9.9.9
  ProxyJump web1
  User admin
  port 22

Host alias-only
Host   spaced  multi
`;
const parsed = parseSSHConfig(sample);
ok('解析: 通配块被跳过', parsed.length === 4 && parsed.some((h) => h.aliases.includes('web1')));
ok('解析: 字段读取（大小写不敏感）', (() => {
  const w = parsed.find((h) => h.aliases[0] === 'web1');
  return w.hostname === '10.0.0.11' && w.user === 'deploy' && w.port === '2222' && !!w.identityfile;
})());
ok('解析: 小写 port 也识别', parsed.find((h) => h.aliases[0] === 'db-jump').port === '22');
ok('解析: 多别名块保留全部', parsed.find((h) => h.aliases.includes('spaced')).aliases.join(',') === 'spaced,multi');

const sess = toSessions(parsed, null);
const web1 = sess.find((s) => s.name === 'web1');
ok('转换: 密钥认证识别', web1.auth === 'key' && web1.keyPath === path.join(os.homedir(), '.ssh/id_ed25519'));
ok('转换: 端口/用户', web1.port === 2222 && web1.user === 'deploy');
ok('转换: 无 IdentityFile -> 密码认证', sess.find((s) => s.name === 'alias-only').auth === 'password');
ok('转换: ProxyJump 归入跳板分组', sess.find((s) => s.name === 'db-jump').group === 'ssh-config/跳板');
ok('转换: alias-only 无 HostName 用别名', sess.find((s) => s.name === 'alias-only').host === 'alias-only');

const filtered = toSessions(parsed, new Set(['ssh-config/web1']));
ok('合并: 已存在的 key 跳过', !filtered.some((s) => s.key === 'ssh-config/web1') && filtered.length === 3);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
