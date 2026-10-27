'use strict';
// sessions.js 存储层测试：JSON 权威存储 / 旧 TSV 自动迁移 / 高级字段往返 / 双写兼容
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-sess-'));
process.env.HOME = FAKE_HOME;
const store = require('../lib/sessions');
const D = path.join(FAKE_HOME, '.hubterm');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

// 1. 旧 TSV + secrets.b64 自动迁移
fs.mkdirSync(D, { recursive: true });
fs.writeFileSync(path.join(D, 'hosts.tsv'),
  'home/nas\tdirect\t192.0.2.250\t22\tthislyc\t192.0.2.250\tthislyc\thome\tsudo -i\n' +
  'tc/k8s/x\tbastion\tbastion.example.com\t22\tdemo.user\t10.0.0.1\t1\ttc/k8s\t\n');
fs.writeFileSync(path.join(D, 'secrets.b64'),
  `home/nas:${Buffer.from('pw-nas').toString('base64')}\ntc/k8s/x:${Buffer.from('pw-x').toString('base64')}\n`);

let list = store.loadSessions();
ok('旧格式迁移: 2 个会话', list.length === 2);
ok('迁移: name 从 key 派生', list.every((s) => s.name) && list.find((s) => s.key === 'home/nas').name === 'nas');
ok('迁移: 密码解出', list.find((s) => s.key === 'home/nas').password === 'pw-nas');
ok('迁移: sessions.json 已生成', fs.existsSync(path.join(D, 'sessions.json')));
ok('迁移: 高级字段完整', (() => { const x = list.find((s) => s.key === 'tc/k8s/x'); return x.target === '10.0.0.1' && x.tuser === '1' && x.type === 'ssh'; })());

// 2. 高级字段往返
list[0].colorScheme = 'dracula';
list[0].scrollback = 50000;
list[0].autoReconnect = 3;
list[0].keepalive = 30;
list[0].cursor = 'bar';
list[0].cursorBlink = '0';
list[0].fontOverride = 14;
list[0].emulation = 'vt100';
list[0].logMode = 'off';
list[0].rules = [
  { expect: 'Opt>', send: '10.0.0.9', enter: '1', hide: '0' },
  { expect: 'ID>', send: '2' },
  { junk: true }, // 应被清洗掉
];
store.saveSessions(list);
list = store.loadSessions();
const nas = list.find((s) => s.key === 'home/nas');
ok('高级字段往返: 配色/回滚/重连', nas.colorScheme === 'dracula' && nas.scrollback === 50000 && nas.autoReconnect === 3);
ok('高级字段往返: keepalive/光标/字号', nas.keepalive === 30 && nas.cursor === 'bar' && nas.cursorBlink === '0' && nas.fontOverride === 14);
ok('高级字段往返: 终端类型/日志', nas.emulation === 'vt100' && nas.logMode === 'off');
ok('规则往返: 清洗+保留', Array.isArray(nas.rules) && nas.rules.length === 2 &&
   nas.rules[0].expect === 'Opt>' && nas.rules[1].send === '2' && nas.rules[1].enter === '1');
ok('密码仍在', nas.password === 'pw-nas');

// 3. 双写：TSV/b64 保持 login.exp 兼容
const tsv = fs.readFileSync(path.join(D, 'hosts.tsv'), 'utf8');
const b64 = fs.readFileSync(path.join(D, 'secrets.b64'), 'utf8');
ok('双写: TSV 首列与密码可被 CLI 解析', tsv.includes('home/nas\tssh\t192.0.2.250\t22\tthislyc') &&
  b64.includes(`home/nas:${Buffer.from('pw-nas').toString('base64')}`));

// 4. normalize 兜底：非法条目被剔除、端口/类型纠正
store.saveSessions([
  { key: 'ok/host', host: '1.2.3.4', type: 'weird-type', port: 'abc' },   // 类型纠正为 direct，端口 22
  { key: '', host: 'x' },                                                  // 无 key 剔除
  { key: 'no-host', host: '' },                                            // 无 host 剔除
]);
list = store.loadSessions();
ok('normalize: 非法条目处理', list.length === 1 && list[0].key === 'ok/host' && list[0].type === 'ssh' && list[0].port === 22);

// 5. JSON 损坏回退
fs.writeFileSync(path.join(D, 'sessions.json'), '{broken json');
list = store.loadSessions();
ok('JSON 损坏: 从 TSV 回退不丢数据', list.length >= 1 && list.every((s) => s.key));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
