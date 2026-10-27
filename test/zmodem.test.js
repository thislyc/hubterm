'use strict';
// ZMODEM 集成测试：与真实 lrzsz (sz/rz) 进程对打，验证收/发两个方向
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Zmodem = require('zmodem.js');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-zmodem-'));

function wait(ms, label) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms));
}

(async () => {
  // ---------- 1. 接收方向：spawn sz 发文件，zmodem.js 收 ----------
  await Promise.race([
    (async () => {
      const src = path.join(tmp, 'send-test.bin');
      const payload = crypto.randomBytes(256 * 1024); // 256KB 随机二进制
      fs.writeFileSync(src, payload);

      const proc = spawn('sz', ['-q', 'send-test.bin'], { cwd: tmp, stdio: ['pipe', 'pipe', 'ignore'] });
      const received = [];
      const zfiles = [];

      const sentry = new Zmodem.Sentry({
        to_terminal: () => {},
        sender: (bytes) => proc.stdin.write(Buffer.from(bytes)),
        on_retract: () => {},
        on_detect: (detection) => {
          const zsession = detection.confirm();
          zsession.on('offer', (xfer) => {
            zfiles.push(xfer.get_details().name);
            xfer.accept().then((payloads) => received.push(Buffer.concat(payloads.map((p) => Buffer.from(p)))));
          });
          zsession.start();
        },
      });
      proc.stdout.on('data', (b) => sentry.consume(b));

      await new Promise((res) => proc.on('exit', res));
      await new Promise((r) => setTimeout(r, 300)); // 等 payload 收尾

      ok('接收: sz -> zmodem.js 收到文件', received.length === 1 && zfiles[0] === 'send-test.bin');
      ok('接收: 内容 sha256 一致', received[0] && sha256(received[0]) === sha256(payload),
         `${received[0] ? received[0].length : 0} bytes`);
    })(),
    wait(25000, 'sz 接收'),
  ]).catch((e) => ok('接收: sz -> zmodem.js 收到文件', false, e.message));

  // ---------- 2. 发送方向：spawn rz 收文件，zmodem.js 发 ----------
  await Promise.race([
    (async () => {
      const rxcwd = path.join(tmp, 'rx');
      fs.mkdirSync(rxcwd);
      const srcData = crypto.randomBytes(128 * 1024);
      const srcName = 'upload-test.bin';

      const proc = spawn('rz', ['-y', '-q'], { cwd: rxcwd, stdio: ['pipe', 'pipe', 'ignore'] });
      let zsessionHolder = null;

      const sentry = new Zmodem.Sentry({
        to_terminal: () => {},
        sender: (bytes) => proc.stdin.write(Buffer.from(bytes)),
        on_retract: () => {},
        on_retract: () => {},
        on_detect: (detection) => { zsessionHolder = detection.confirm(); },
      });
      proc.stdout.on('data', (b) => sentry.consume(b));

      // 等 rz 发出 ZRINIT、sentry 检出会话
      const t0 = Date.now();
      while (!zsessionHolder && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      if (!zsessionHolder) throw new Error('未检测到 rz 的 ZMODEM 会话');

      const zs = zsessionHolder;
      if (zs.type !== 'send') throw new Error('会话类型应为 send，实际 ' + zs.type);
      const xfer = await zs.send_offer({ name: srcName, size: srcData.length, mode: 0o644, files_remaining: 1, bytes_remaining: srcData.length });
      if (!xfer) throw new Error('offer 被跳过');
      for (let i = 0; i < srcData.length; i += 8192) {
        xfer.send(Array.from(srcData.subarray(i, i + 8192)));
      }
      await xfer.end();
      await zs.close();
      await new Promise((res) => proc.on('exit', res));

      const got = fs.readFileSync(path.join(rxcwd, srcName));
      ok('发送: zmodem.js -> rz 收到文件', got.length === srcData.length);
      ok('发送: 内容 sha256 一致', sha256(got) === sha256(srcData));
    })(),
    wait(25000, 'rz 发送'),
  ]).catch((e) => ok('发送: zmodem.js -> rz 收到文件', false, e.message));

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
