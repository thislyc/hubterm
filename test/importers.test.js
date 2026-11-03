'use strict';
// lib/importers.js 单测：五种格式解析 + 编码识别 + parseContent 路由 + parseFiles 目录/去重。
// 全部离线，fixture 内联；临时目录用完即删。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeText, parseSecureCRT, parseXshell, parseMobaXterm, parsePutty, parseHostList, parseContent, parseFiles } = require('../lib/importers');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? '✓ PASS ' : '✗ FAIL ') + name + (pass ? '' : `  (${detail || ''})`));
}
function eq(actual, expected, name) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`);
}

/* ---------- decodeText ---------- */
eq(decodeText(Buffer.from('hello', 'utf8')), 'hello', 'decode: utf8 直读');
const bomLe = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文BOM', 'utf16le')]);
eq(decodeText(bomLe), '中文BOM', 'decode: utf16le BOM');
// 无 BOM UTF-16LE：NUL 密度判别
const noBom = Buffer.from('无BOM的UTF16', 'utf16le');
eq(decodeText(noBom), '无BOM的UTF16', 'decode: utf16le 无 BOM 密度判别');

/* ---------- SecureCRT ---------- */
const scrtIni = [
  'D:"[SSH2] Port"=00000016', // 十六进制 22
  'S:"Hostname"=10.65.20.1',
  'S:"Username"=opsuser',
  'S:"Identity File V2"=D:\\keys\\id_rsa',
  'S:"Forwards"=',
].join('\r\n');
const scrt = parseSecureCRT(scrtIni);
ok('securecrt: host/port(hex)/user', !!scrt && scrt.host === '10.65.20.1' && scrt.port === 22 && scrt.user === 'opsuser', JSON.stringify(scrt));
ok('securecrt: 密钥→auth=key', scrt && scrt.auth === 'key' && scrt.keyPath === 'D:\\keys\\id_rsa', JSON.stringify(scrt));
eq(parseSecureCRT('S:"Version"=9.5'), null, 'securecrt: 无 Hostname 返回 null');

/* ---------- Xshell ---------- */
const xsh = [
  '[ConType]',
  'Type=1',
  '[Connection]',
  'Protocol=SSH',
  'Host=192.168.1.10',
  'Port=2222',
  '[Connection\\Authentication]',
  'Method=3',
  'UserName=deploy',
].join('\n');
const xs = parseXshell(xsh);
ok('xshell: host/port/user', !!xs && xs.host === '192.168.1.10' && xs.port === 2222 && xs.user === 'deploy', JSON.stringify(xs));
ok('xshell: 无密钥→password', xs && xs.auth === 'password', JSON.stringify(xs));
eq(parseXshell('[Connection]\nProtocol=TELNET\nHost=1.2.3.4'), null, 'xshell: 非 SSH 协议返回 null');

/* ---------- MobaXterm ---------- */
const mxt = [
  '[Bookmarks]',
  'SubTreeName=',
  '[Bookmarks_1]',
  'web-01= #109#0%10.0.0.5%22%root%',
  'db-01= #109#0%10.0.0.6%2222%admin%',
].join('\n');
const mxa = parseMobaXterm(mxt);
eq(mxa.map((s) => [s.name, s.host, s.port, s.user]), [['web-01', '10.0.0.5', 22, 'root'], ['db-01', '10.0.0.6', 2222, 'admin']], 'moba: 两条会话字段');
eq(mxa.map((s) => s.group), ['', ''], 'moba: Bookmarks_1 分组归一');

/* ---------- PuTTY ---------- */
const putty = [
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\prod%20web]',
  '"HostName"="10.1.1.1"',
  '"PortNumber"=dword:00000016',
  '"UserName"="root"',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\keyhost]',
  '"HostName"="10.1.1.2"',
  '"UserName"="ci"',
  '"PublicKeyFile"="C:\\keys\\ci.ppk"',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial1]',
  '"Protocol"="Serial"',
].join('\n');
const pt = parsePutty(putty);
eq(pt.length, 2, 'putty: serial 段剔除后余 2 条');
eq(pt[0].name, 'prod web', 'putty: %20 解码会话名');
eq(pt[0].port, 22, 'putty: dword 十六进制端口');
eq([pt[1].auth, pt[1].keyPath], ['key', 'C:\\keys\\ci.ppk'], 'putty: PublicKeyFile→key');

/* ---------- CSV / 主机清单 ---------- */
const list = [
  '# 注释跳过',
  'host,port,user,name',
  '10.2.0.1,22,root,边界防火墙',
  'deploy@10.2.0.2:2200',
  'ssh root@10.2.0.3 -p 2223',
  '10.2.0.4',
].join('\n');
const hl = parseHostList(list);
eq(hl.length, 4, 'hostlist: 4 条有效');
eq(hl[0], { name: '边界防火墙', group: '', host: '10.2.0.1', port: 22, user: 'root', auth: 'password', keyPath: '' }, 'hostlist: csv 四列');
eq([hl[1].user, hl[1].host, hl[1].port], ['deploy', '10.2.0.2', 2200], 'hostlist: user@host:port');
eq([hl[2].user, hl[2].host, hl[2].port], ['root', '10.2.0.3', 2223], 'hostlist: ssh 命令形态');
eq(hl[3].name, '10.2.0.4', 'hostlist: 裸主机名');

/* ---------- parseContent 路由 ---------- */
const routed = parseContent('web.ini', scrtIni);
eq(routed[0].source, 'securecrt', 'route: .ini→securecrt');
eq(parseContent('a.xsh', xsh)[0].source, 'xshell', 'route: .xsh→xshell');
eq(parseContent('b.mxtsessions', mxt)[0].source, 'mobaxterm', 'route: .mxtsessions→moba');
eq(parseContent('c.reg', putty)[0].source, 'putty', 'route: .reg→putty');
eq(parseContent('hosts.txt', '10.3.0.9\n')[0].source, 'csv', 'route: txt→csv 清单');
eq(parseContent('nohost.ini', 'S:"Font"=Consolas').length, 0, 'route: 全局 ini 零会话');
eq(parseContent('r.txt', scrtIni)[0].source, 'securecrt', 'route: S:" 签名跨扩展名命中 securecrt');

/* ---------- parseFiles：临时目录 + UTF-16 xsh + 去重 + 未识别 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-imp-'));
try {
  fs.writeFileSync(path.join(tmp, 's1.ini'), scrtIni);
  fs.writeFileSync(path.join(tmp, 's2.xsh'), Buffer.from('\uFEFF' + xsh, 'utf16le'));
  fs.writeFileSync(path.join(tmp, 'Default.ini'), 'S:"Font"=Consolas\n');
  const res = parseFiles([tmp]);
  eq(res.items.length, 2, 'parseFiles: 两会话 + 全局 ini 落未识别');
  eq(res.items.map((s) => s.name === '' ? s.host : s.name).sort(), ['10.65.20.1', '192.168.1.10'], 'parseFiles: 无名会话保留 host');
  eq(res.unrecognized.length, 1, 'parseFiles: Default.ini 进未识别');
  const r2 = parseFiles([tmp, tmp]); // 重复目录：跨文件按 group/name 去重
  eq(r2.items.length, 2, 'parseFiles: 跨目录去重');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
