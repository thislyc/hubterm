'use strict';
// 本地 mock SSH 服务器：复刻「直连主机(sudo) / 菜单式堡垒机(逐字符提示符) / 键盘交互MFA」
// 仅用于自动化测试，不进入打包产物。
const { Server } = require('ssh2');
const { generateKeyPairSync } = require('crypto');

const MOCK_PW = 'mockpass123';
const MFA_CODE = '123456';

function makeKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' });
}

function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i).replace(/^[\r\n]+/, '');
      if (line) onLine(line);
    }
  };
}

function startMockServer(mode, port) {
  return new Promise((resolve) => {
    const server = new Server({ hostKeys: [makeKey()] }, (client) => {
      client.on('error', () => { /* 客户端中途断开（如 hostVerifier 拒绝）属预期，忽略 */ });
      client.on('authentication', (ctx) => {
        if (mode === 'mfaprompt') {
          // 真实堡垒机 2026-10 现状：跳过密码，第一轮即 MFA（英文提示）
          if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
          ctx.prompt([{ prompt: '[MFA auth]: ', echo: true }], 'root', 'Please enter 6 digits.', (ans) => {
            if (ans[0] === MFA_CODE) ctx.accept();
            else ctx.reject(['keyboard-interactive']);
          });
          return;
        }
        if (mode === 'mfaen') {
          // 纯英文验证码提示（name/instr 均为空）：考验客户端的 MFA 判定，
          // wrongKb 计数留下「密码被当验证码提交」的痕迹供测试断言
          if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
          ctx.prompt([{ prompt: 'Verification code: ', echo: false }], '', '', (ans) => {
            if (ans[0] === MFA_CODE) return ctx.accept();
            server.wrongKb = (server.wrongKb || 0) + 1;
            ctx.reject(['keyboard-interactive']);
          });
          return;
        }
        if (mode === 'zhpass') {
          // 键盘交互但提示词是中文"请输入密码"（复现真实堡垒机行为）
          if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
          ctx.prompt([{ prompt: '请输入密码 用户 ' + ctx.username + ' @mock', echo: false }], 'auth', 'SSH 认证', (ans) => {
            if (ans[0] === MOCK_PW) ctx.accept();
            else ctx.reject(['keyboard-interactive']);
          });
          return;
        }
        if (mode === 'mfa') {
          // 键盘交互：第一轮密码，第二轮 MFA 验证码
          // 服务器端 API: ctx.prompt(prompts, title, instructions, cb)
          if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
          ctx.prompt([{ prompt: 'Password: ', echo: false }], 'auth', '密码认证', (ans) => {
            if (ans[0] !== MOCK_PW) return ctx.reject(['keyboard-interactive']);
            ctx.prompt([{ prompt: 'Verification code: ', echo: false }], 'mfa', '请输入6位验证码', (ans2) => {
              if (ans2[0] === MFA_CODE) ctx.accept();
              else ctx.reject(['keyboard-interactive']);
            });
          });
          return;
        }
        if (ctx.method === 'publickey') return ctx.accept(); // 测试：任意公钥放行
        if (ctx.method === 'password' && ctx.password === MOCK_PW) return ctx.accept();
        ctx.reject(['password', 'publickey']);
      });

      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc && acc());
        // exec 通道（MCP 单命令执行的测试支撑）：
        // echo X -> stdout；errfail -> stderr+exit 3；sleepms N -> 延迟 N 毫秒；
        // bigout -> 300KB+ 输出（截断测试）；其余回显 ran: <cmd>
        // 注意：ssh2 服务端通道 end() 会立刻 eof+close，exit() 必须在 end() 之前调用
        session.on('exec', (accept, reject, info) => {
          const cmd = String(info.command || '').trim();
          const mEcho = cmd.match(/^echo\s+(.*)$/);
          const mSleep = cmd.match(/^sleepms\s+(\d+)$/);
          const finish = (stream, code) => { stream.exit(code); stream.end(); };
          if (mSleep) {
            const stream = accept();
            setTimeout(() => { stream.write('slept\n'); finish(stream, 0); }, parseInt(mSleep[1], 10));
            return;
          }
          const stream = accept();
          if (mEcho) {
            stream.write(mEcho[1] + '\n');
            finish(stream, 0);
          } else if (cmd === 'errfail') {
            stream.stderr.end('boom\n');
            finish(stream, 3);
          } else if (cmd === 'bigout') {
            const chunk = Buffer.alloc(8192, 0x78); // 'x'
            for (let i = 0; i < 38; i++) stream.write(chunk); // 38*8KB = 304KiB > 256KB 截断上限
            finish(stream, 0);
          } else {
            stream.write('ran: ' + cmd + '\n');
            finish(stream, 0);
          }
        });
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('mock-ssh welcome\r\n');
          if (mode === 'direct' || mode === 'zhpass' || mode === 'mfaprompt') {
            let root = false;
            let sudoing = false;
            const read = lineReader((line) => {
              if (sudoing) {
                sudoing = false;
                stream.write(line === MOCK_PW ? '\r\nroot@mock:~# ' : '\r\n抱歉，请重试\r\nmockuser@mock:~$ ');
                return;
              }
              if (line === 'sudo -i') {
                sudoing = true;
                root = true;
                stream.write('sudo -i\r\n[sudo] password for mockuser: ');
                return;
              }
              if (line === 'exit') return stream.end();
              if (line.startsWith('echo __MARK__')) {
                stream.write(`\r\n__MARK__${line.slice(13)}__\r\n`);
              } else {
                stream.write(`\r\n${line}\r\n`);
              }
              stream.write(root ? 'root@mock:~# ' : 'mockuser@mock:~$ ');
            });
            stream.write('mockuser@mock:~$ ');
            stream.on('data', (b) => { stream.write(b); read(b); }); // 模拟远端 pty 回显
          } else {
            // bastion / mfa(认证后同样给菜单) / raw
            let atTarget = false;
            const read = lineReader((line) => {
              if (!atTarget) {
                if (line === 'q') return stream.end();
                if (line === '10.99.99.99') {
                  stream.write(line + '\r\n  ID | 主机名 | IP          | 登录用户\r\n');
                  stream.write('  1  | mock   | 10.99.99.99 | root,yunwei\r\n');
                  stream.write('  ID | NAME\r\n  1  | root\r\n  2  | yunwei\r\n');
                  let i = 0;
                  const chars = 'I\rD\r> ';
                  const timer = setInterval(() => {   // 逐字符渲染提示符（真实堡垒机行为）
                    stream.write(chars[i++]);
                    if (i >= chars.length) clearInterval(timer);
                  }, 8);
                  return;
                }
                if (line === '1' || line === '2') {
                  atTarget = true;
                  stream.write(line + '\r\nroot@10.99.99.99:~# ');
                  return;
                }
                stream.write(line + '\r\n无匹配，请重新输入\r\nOpt> ');
                return;
              }
              if (line === 'exit') {
                atTarget = false;
                stream.write(line + '\r\n已断开，回到菜单\r\nOpt> ');
                return;
              }
              if (line.startsWith('echo __MARK__')) {
                stream.write(`\r\n__MARK__${line.slice(13)}__\r\n`);
              } else {
                stream.write(`\r\n${line}\r\n`);
              }
              stream.write('root@10.99.99.99:~# ');
            });
            stream.write('Mock Bastion Menu  1) Enter ID  2) Search IP\r\nOpt> ');
            stream.on('data', (b) => { stream.write(b); read(b); });
          }
        });
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startMockServer, MOCK_PW, MFA_CODE };
