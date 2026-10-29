'use strict';
// 连接引擎自动化测试：直连+sudo / 堡垒机菜单 / raw / 密码错误 / 键盘交互 MFA
const { startMockServer, MOCK_PW, MFA_CODE } = require('../lib/mockserver');
const { SshSession } = require('../lib/connect');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

function waitStatus(s, status, ms = 12000) {
  return new Promise((resolve, reject) => {
    if (s.status === status) return resolve();
    const to = setTimeout(() => reject(new Error(`等待 ${status} 超时，当前 ${s.status}`)), ms);
    s.on('status', (st, msg) => {
      if (st === status) { clearTimeout(to); resolve(); }
    });
  });
}
function waitData(s, re, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (c) => {
      buf += c.toString('utf8');
      if (re.test(buf)) { s.removeListener('data', onData); clearTimeout(to); resolve(buf); }
    };
    const to = setTimeout(() => { s.removeListener('data', onData); reject(new Error('等待数据超时: ' + re)); }, ms);
    s.on('data', onData);
  });
}
const base = { key: 'test', name: 'test', host: '127.0.0.1', user: 'mockuser', target: '10.99.99.99', tuser: '1', post: '', group: 'test', port: 0 };

(async () => {
  // 1. 直连 + sudo -i
  // （端口 2221 的 mock 服务器在此启动）
  await startMockServer('direct', 2221);
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, post: 'sudo -i', password: MOCK_PW });
    s.connect();
    await waitStatus(s, 'connected');
    ok('直连: 自动登录+sudo 变 root', s.status === 'connected');
    s.write('echo __MARK__direct-ok\r');
    await waitData(s, /__MARK__direct-ok__/);
    ok('直连: 命令回显往返', true);
    s.destroy();
  }

  // 2. 无规则 + 菜单式远端：shell 打开即 connected（对齐常规 SSH 客户端，不猜提示符），
  //    但引擎绝不自动应答菜单（无内置流程）
  await startMockServer('bastion', 2222);
  {
    const s = new SshSession({ ...base, type: 'ssh', port: 2222, password: MOCK_PW });
    const sent = [];
    const origSend = s.send.bind(s);
    s.send = (d) => { sent.push(d); origSend(d); };
    s.connect();
    await waitStatus(s, 'connected'); // 菜单式远端没有 $/# 提示符，也必须立刻就绪可手动操作
    await new Promise((r) => setTimeout(r, 1500)); // 菜单早已出现
    ok('无规则: shell 打开即就绪（不猜提示符）', s.status === 'connected');
    ok('无规则: 菜单出现不自动应答', sent.length === 0, JSON.stringify(sent));
    s.destroy();
  }

  // 2b. 无规则 + post：post 属于自动化流程，等「注入 post → 回到提示符」再就绪，
  //     期间用户击键不会与自动应答交错（命令不会被当成 sudo 密码提交）
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, post: 'echo __POSTDONE2__', password: MOCK_PW });
    const postOut = waitData(s, /__POSTDONE2__/, 8000); // post 输出可能与 connected 同块到达，先挂监听
    s.connect();
    await waitStatus(s, 'connected');
    await postOut;
    ok('无规则+post: 注入并执行后回到提示符才就绪', true);
    s.destroy();
  }

  // 2d. 无规则无 post（纯交互）：就绪一刻起立即可敲命令（PTY 缓冲，无需等提示符）
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, password: MOCK_PW });
    s.connect();
    await waitStatus(s, 'connected');
    s.write('echo __MARK__pure-ok\r');
    await waitData(s, /__MARK__pure-ok__/);
    ok('纯交互: 就绪后立即可敲命令往返', true);
    s.destroy();
  }

  // 2c. connected 之后终端里出现 denied/验证码字样（sudo 失败、横幅等）：
  //     属于正常输出，不得改状态、不得在界面盖错误遮罩
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, password: MOCK_PW });
    s.connect();
    await waitStatus(s, 'connected');
    s.feed(Buffer.from('cat: /root/secret: Permission denied\r\n'));
    s.feed(Buffer.from('如需解锁请输入验证码\r\n'));
    ok('connected 后: denied/验证码字样不影响状态', s.status === 'connected');
    s.destroy();
  }

  // 4. 密码错误 -> error
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, password: 'wrong-password' });
    s.connect();
    let err = '';
    await new Promise((res) => { s.on('status', (st, msg) => { if (st === 'error') { err = msg; res(); } }); });
    ok('密码错误: 进入 error 状态', /denied|auth|All configured/i.test(err), err.slice(0, 60));
    s.destroy();
  }

  // 6. 连接快速失败（用户反馈的核心问题：原来 30 秒无反馈）
  {
    // 6a. TCP 黑洞地址：8 秒 TCP 超时
    const t0 = Date.now();
    const s = new SshSession({ ...base, type: 'direct', host: '10.255.255.1', port: 22, password: MOCK_PW });
    s.connect();
    let err = '';
    await new Promise((res) => { s.on('status', (st, msg) => { if (st === 'error') { err = msg; res(); } }); });
    const secs = (Date.now() - t0) / 1000;
    ok('黑洞地址: 快速失败(<12s)', secs < 12, `${secs.toFixed(1)}s: ${err.slice(0, 40)}`);
    s.destroy();

    // 6b. TCP 通但 SSH 死(静默服务器)：15 秒握手超时
    const net = require('net');
    const silent = net.createServer(() => {});
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const t1 = Date.now();
    const s2 = new SshSession({ ...base, type: 'direct', host: '127.0.0.1', port: silent.address().port, password: MOCK_PW });
    s2.connect();
    await new Promise((res) => { s2.on('status', (st) => { if (st === 'error') res(); }); });
    ok('静默SSH: 15s 内报错', (Date.now() - t1) / 1000 < 17);
    s2.destroy();
    silent.close();
  }

  // 7. hostVerifier 钩子（known_hosts）：新指纹自动信任并上报
  {
    const seen = [];
    const s = new SshSession(
      { ...base, type: 'direct', port: 2221, password: MOCK_PW, verifyHost: async (fp) => { seen.push(fp); return true; } }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('known_hosts: verifyHost 钩子被调用并放行', seen.length === 1 && /^[A-Za-z0-9+/=]{20,}$/.test(seen[0]));
    s.destroy();
  }
  {
    const s = new SshSession(
      { ...base, type: 'direct', port: 2221, password: MOCK_PW, verifyHost: async () => false } // 拒绝
    );
    s.connect();
    let err = '';
    await new Promise((res) => { s.on('status', (st, msg) => { if (st === 'error') { err = msg; res(); } }); });
    ok('known_hosts: 拒绝时连接失败', !!err);
    s.destroy();
  }

  // 8. 键盘交互 MFA（密码轮 + 验证码轮）
  await startMockServer('mfa', 2223);
  {
    const s = new SshSession(
      {
        ...base, type: 'ssh', port: 2223, password: MOCK_PW,
        rules: [{ expect: 'Opt> ', send: '10.99.99.99' }, { expect: 'I\rD\r>', send: '1' }],
      },
      { askMfa: async (prompt) => { ok('MFA: 弹窗回调被触发', /code|验证码/i.test(prompt), prompt); return MFA_CODE; } }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('MFA: 键盘交互两轮认证后落壳', true);
    s.destroy();
  }

  // 9. 自定义登录规则（SecureCRT Logon Actions 原教旨形态：等 Opt> 发 IP、等 ID> 发应答）
  {
    const s = new SshSession({
      ...base, type: 'ssh', port: 2222, password: MOCK_PW,
      rules: [
        { expect: 'Opt> ', send: '10.99.99.99', enter: '1' },
        { expect: 'I\rD\r>', send: '2', enter: '1' },   // mock 里选 2 也落 root shell
      ],
    });
    s.connect();
    await waitStatus(s, 'connected');
    ok('自定义规则: 两步规则走完即就绪', s.ruleIdx === 2);
    s.write('echo __MARK__rules-ok\r');
    await waitData(s, /__MARK__rules-ok__/);
    ok('自定义规则: 目标机命令回显往返', true);
    s.destroy();
  }

  // 10. 规则 + 登录后命令（post 对所有类型生效）
  {
    const s = new SshSession({
      ...base, type: 'ssh', port: 2222, password: MOCK_PW,
      rules: [{ expect: 'Opt> ', send: '10.99.99.99' }, { expect: 'I\rD\r>', send: '1' }],
      post: 'echo __POSTDONE__',
    });
    s.connect();
    await waitStatus(s, 'connected');
    await waitData(s, /__POSTDONE__/, 6000);
    ok('规则模式: 登录后命令自动执行', true);
    s.destroy();
  }

  // 11. 公钥认证（临时 ed25519 私钥）
  {
    const { generateKeyPairSync } = require('crypto');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-key-')), 'id_test');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const s = new SshSession({ ...base, type: 'direct', port: 2221, password: '', auth: 'key', keyPath: keyFile });
    s.connect();
    await waitStatus(s, 'connected');
    ok('公钥认证: 私钥登录成功', true);
    s.destroy();

    // 私钥路径错误 -> 明确报错
    const s2 = new SshSession({ ...base, type: 'direct', port: 2221, password: '', auth: 'key', keyPath: '/nonexistent/key' });
    let err = '';
    const gotErr = new Promise((res) => { s2.on('status', (st, msg) => { if (st === 'error') { err = msg; res(); } }); });
    s2.connect(); // 同步路径的错误在 connect 内就发出，必须先挂监听
    await gotErr;
    ok('公钥认证: 路径错误快速报错', /认证配置错误/.test(err), err.slice(0, 40));
    s2.destroy();
  }

  // 12. 规则变量 $PASSWORD（等提示后自动带出会话密码）
  {
    const s = new SshSession({
      ...base, type: 'ssh', port: 2222, password: MOCK_PW,
      rules: [{ expect: 'Opt> ', send: 'echo __V__$PASSWORD', enter: '1' }],
    });
    s.connect();
    await waitStatus(s, 'connected');
    await waitData(s, new RegExp('__V__' + MOCK_PW));
    ok('规则变量: $PASSWORD 展开', true);
    s.destroy();
  }

  // 13. ZMODEM 正交性：规则会话中混入 ZMODEM 起始帧噪声，规则状态机不受干扰
  {
    const s = new SshSession({
      ...base, type: 'ssh', port: 2222, password: MOCK_PW,
      rules: [{ expect: 'Opt> ', send: '10.99.99.99' }, { expect: 'I\rD\r>', send: '1' }],
    });
    s.connect();
    await waitStatus(s, 'connected');
    // 直接向引擎 feed 一段 ZMODEM 头（模拟 sz 启动噪声）——引擎只是监视器，应无异常且状态不变
    s.feed(Buffer.from('**\x18B00000000000000\r**\x18B0100000023be50', 'latin1'));
    s.feed(Buffer.from('root@10.99.99.99:~# ', 'utf8'));
    ok('ZMODEM 正交: 引擎对 zmodem 帧无异常', s.status === 'connected');
    s.destroy();
  }

  // 14. 中文密码提示的键盘交互：自动应答，不弹窗（真实堡垒机踩过的坑）
  {
    await startMockServer('zhpass', 2224);
    let asked = 0;
    const s = new SshSession(
      { ...base, type: 'ssh', port: 2224, password: MOCK_PW, rules: [] },
      { askMfa: async () => { asked++; return ''; } }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('中文密码提示: 自动应答不弹窗', asked === 0, `弹窗次数=${asked}`);
    s.destroy();
  }

  // 15. 无密码：连接前弹窗询问（记住勾选传出事件），取消则中止不连
  {
    let asked = 0, saved = null;
    const mk = (pw, remember) => new SshSession(
      { ...base, type: 'ssh', port: 2221, password: '' },
      { askMfa: async () => '', askPassword: async () => { asked++; return { password: pw, remember }; } }
    );
    const s = mk(MOCK_PW, true);
    s.on('save-password', (p) => { saved = p; });
    s.connect();
    await waitStatus(s, 'connected');
    ok('无密码: 弹窗询问后自动登录', asked === 1);
    ok('无密码: 记住勾选触发 save-password', saved === MOCK_PW);
    s.destroy();

    const s2 = mk('', false); // 取消
    s2.connect();
    await new Promise((res) => { s2.on('status', (st) => { if (st === 'error') res(); }); });
    ok('无密码: 取消则中止（不撞服务器）', true);
    s2.destroy();
  }

  // 16. MFA-only 服务器（跳过密码直接要验证码）：密码绝不被当验证码提交，弹窗索码
  {
    await startMockServer('mfaprompt', 2225);
    let asked = 0;
    const s = new SshSession(
      { ...base, type: 'ssh', port: 2225, password: MOCK_PW, rules: [] },
      { askMfa: async (prompt) => { asked++; return /MFA|mfa|6 digits/i.test(prompt) ? MFA_CODE : ''; } }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('MFA-only: 弹窗索码并用验证码登录', asked === 1);
    s.destroy();
  }

  // 17. 认证弹窗未决期间暂停握手计时：输入耗时超过超时设置也能登录成功
  //     （回归背景：ssh2 内置 readyTimeout 不区分等待对象，慢慢输 MFA 会被掐死且不自动重连）
  await startMockServer('mfaprompt', 2226);
  {
    const s = new SshSession(
      { ...base, type: 'ssh', port: 2226, password: MOCK_PW, rules: [], handshakeTimeoutMs: 800 },
      { askMfa: () => new Promise((res) => setTimeout(() => res(MFA_CODE), 1800)) } // 输入耗时 > 超时设置
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('MFA 慢输入: 弹窗期间暂停握手计时', s.status === 'connected');
    s.destroy();
  }

  // 18. host key 确认慢（用户读指纹变更警告）同样暂停计时
  {
    const s = new SshSession(
      {
        ...base, type: 'direct', port: 2221, password: MOCK_PW, handshakeTimeoutMs: 800,
        verifyHost: () => new Promise((res) => setTimeout(() => res(true), 1800)),
      }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('hostKey 慢确认: 弹窗期间暂停握手计时', s.status === 'connected');
    s.destroy();
  }

  // 19. 静默服务器：自管握手超时按配置生效（兜底能力不因内置 readyTimeout 停用而丢失）
  {
    const net = require('net');
    const silent = net.createServer(() => {});
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    const s = new SshSession({ ...base, type: 'direct', host: '127.0.0.1', port: silent.address().port, password: MOCK_PW, handshakeTimeoutMs: 600 });
    s.connect();
    let msg = '';
    await new Promise((res) => { s.on('status', (st, m) => { if (st === 'error') { msg = m; res(); } }); });
    const secs = (Date.now() - t0) / 1000;
    ok('静默SSH: 自管握手超时生效(<3s)', secs < 3 && /握手|handshake/i.test(msg), `${secs.toFixed(1)}s: ${msg.slice(0, 40)}`);
    s.destroy();
    silent.close();
  }

  // 20. 断线只发一次 disconnected（一次断线 = 一次重连预算；重复触发会排出并行连接）
  {
    const s = new SshSession({ ...base, type: 'direct', port: 2221, password: MOCK_PW });
    s.connect();
    await waitStatus(s, 'connected');
    const events = [];
    s.on('status', (st) => events.push(st));
    s.conn.end();
    await new Promise((r) => setTimeout(r, 600));
    const n = events.filter((x) => x === 'disconnected').length;
    ok('断线: disconnected 只发一次', n === 1, JSON.stringify(events));
    s.destroy();
  }

  // 21. 纯英文 "Verification code:" 提示必须判为 MFA 弹窗索码，密码绝不被当验证码提交
  {
    const server = await startMockServer('mfaen', 2227);
    let asked = 0;
    const s = new SshSession(
      { ...base, type: 'ssh', port: 2227, password: MOCK_PW, rules: [] },
      { askMfa: async (prompt) => { asked++; return /verification/i.test(prompt) ? MFA_CODE : MOCK_PW; } }
    );
    s.connect();
    await waitStatus(s, 'connected');
    ok('英文验证码: 弹窗索码且密码零误交', asked === 1 && !server.wrongKb, `弹窗=${asked} 误交=${server.wrongKb || 0}`);
    s.destroy();
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('✗ 测试异常:', e.message);
  process.exit(1);
});
