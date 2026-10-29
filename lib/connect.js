'use strict';
// SSH 连接引擎。
//
// 自动化原则（对齐 SecureCRT Logon Actions，且无任何内置流程）：
// - 每会话的「登录规则」(rules: expect→send 序列) 是唯一的自动应答机制；
//   规则里的 expect 用 $PASSWORD / $TARGET 变量引用凭据。
// - 用户键盘输入永远直通远端；规则只是"监视器"：等待文本出现才发送，
//   未预期的情况（MFA、菜单改版）下终端随时可手动操作，不会卡死。
// - 无规则时仅有协议级安全网：host key 确认、密码提示应答。
// - 状态（对齐常规 SSH 客户端语义）：shell 通道打开即为 connected、可交互，
//   不猜测远端提示符；带登录规则的会话在规则走完后才 connected。
//   manual(超时可手动) / error / disconnected。

const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const os = require('os');
const i18n = require('./i18n');
const t = i18n.t;

const TCP_TIMEOUT_MS = 8000;   // TCP 建立超时（黑洞路由快速失败）
const READY_TIMEOUT_MS = 15000; // SSH 握手超时（等待用户输入认证信息期间暂停计时）
const EXEC_CAP_BYTES = 256 * 1024; // exec 单命令输出截断上限（stdout/stderr 各一）

/** 解析认证配置 -> ssh2 connect 片段（密码 / 私钥 / agent） */
function authOpts(cfg) {
  if (cfg.auth === 'agent') {
    return { agent: process.env.SSH_AUTH_SOCK || undefined };
  }
  if (cfg.auth === 'key') {
    const p = String(cfg.keyPath || '').replace(/^~(?=\/|$)/, os.homedir());
    const privateKey = fs.readFileSync(p); // 抛错由调用方转为 error 状态
    return cfg.keyPass ? { privateKey, passphrase: cfg.keyPass } : { privateKey };
  }
  return cfg.password ? { password: cfg.password } : {};
}

/** 自建 socket：TCP 层 8 秒超时，避免不可达地址长时间无反馈 */
function dial(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.connect({ host, port });
    const fail = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(err);
    };
    sock.once('connect', () => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      resolve(sock);
    });
    sock.once('error', fail);
    sock.setTimeout(timeoutMs, () =>
      fail(new Error(t('conn.tcpTimeout', timeoutMs / 1000)))
    );
  });
}

const RE = {
  hostKey: /\(yes\/no/,
  password: /[Pp]assword[^\r\n]{0,32}[：:]/,  // 兼容 "[sudo] password for user: "
  mfa: /(输入\s*6|6\s*digits|验证码|verification\s*code|动态口令|OTP)/i,
  denied: /Permission\s+denied/,
  prompt: /[$#]\s*$/,                     // 行尾 shell 提示符
};

class SshSession extends EventEmitter {
  /**
   * @param cfg {key,type,host,port,user,password,target,tuser,post,name}
   * @param ipc {{askMfa: (prompt:string)=>Promise<string>}} 可选，MFA 二次认证弹窗
   */
  constructor(cfg, ipc) {
    super();
    this.cfg = cfg;
    this.ipc = ipc || { askMfa: async () => '', askPassword: async () => ({ password: '', remember: false }) };
    this.status = 'idle';
    this.sends = { pw: 0, post: 0, yes: 0 };
    this.tail = '';
    this.conn = null;
    this.stream = null;
    this.mfaHinted = false;
    this._kbTried = 0;
    this.manualTimer = null;
    this._hsTimer = null;
  }

  /** 自管握手计时：等待用户输入（MFA 弹窗/密码弹窗/host key 确认）期间暂停，
      用户提交后重新起算。ssh2 内置 readyTimeout 不区分等待对象，会把慢慢输
      验证码的用户掐断在半路（对端已死还收码、且 error 状态不触发自动重连）。 */
  armHandshake() {
    const ms = this.cfg.handshakeTimeoutMs > 0 ? this.cfg.handshakeTimeoutMs : READY_TIMEOUT_MS;
    this.disarmHandshake();
    this._hsTimer = setTimeout(() => {
      if (['connected', 'error', 'disconnected'].includes(this.status)) return;
      this.setStatus('error', t('conn.handshakeTimeout', Math.round(ms / 1000)));
    }, ms);
  }
  disarmHandshake() {
    if (this._hsTimer) { clearTimeout(this._hsTimer); this._hsTimer = null; }
  }

  setStatus(s, msg) {
    this.status = s;
    // exec 单命令模式：引擎级错误直接结单（Promise reject），不走状态流
    if (this._execJob && s === 'error') {
      this._finishExec(null, msg || t('conn.connectFailed'));
      return;
    }
    this.emit('status', s, msg || '');
    if (s === 'connected') {
      clearTimeout(this.manualTimer);
    }
  }

  connect() {
    const cfg = this.cfg;
    // 无密码（密码认证）-> 先向用户询问，而不是拿空密码去撞服务器
    if ((!cfg.auth || cfg.auth === 'password') && !cfg.password && this.ipc.askPassword) {
      this.setStatus('need-password', t('conn.waitingPassword'));
      Promise.resolve(this.ipc.askPassword(t('conn.askPassword', cfg.user, cfg.host)))
        .then(({ password, remember }) => {
          if (!password) {
            this.setStatus('error', t('conn.cancelledNoPw'));
            return;
          }
          cfg.password = password;
          if (remember) this.emit('save-password', password);
          this._connect();
        })
        .catch(() => this.setStatus('error', t('conn.cancelledNoPw')));
      return;
    }
    this._connect();
  }

  _connect() {
    const cfg = this.cfg;
    this.setStatus('connecting');
    const c = (this.conn = new Client());
    c.on('ready', () => this.onReady());
    c.on('error', (err) => this.setStatus('error', err.message));
    c.on('close', () => {
      this.disarmHandshake();
      if (this._execJob) this._finishExec(null, t('conn.disconnected'));
      this.closeSftp(); // 失效 SFTP 通道缓存，避免断线后拿着僵尸通道操作
      // 终态去重：断线时 conn close 与 stream close 常接连到达，只发一次 disconnected
      //（重复触发会让上层把一次断线记成两次 attempts、排出两个重连定时器）
      if (this.status !== 'error' && this.status !== 'disconnected') this.setStatus('disconnected');
      this.emit('close');
    });
    // 键盘交互认证：中文/英文密码提示自动应答；未知提示先试一次密码；MFA 才弹窗
    c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      const p = prompts[0] || {};
      const text = `${p.prompt || ''} ${instr || ''} ${name || ''}`;
      // MFA 特征：明说 MFA/OTP/验证码，或要求 6 位数字（含中英文，覆盖 "[MFA auth]: Please enter 6 digits." 这类）
      const isMfa = /mfa|otp|验证码|动态口令|token|6\s*digits|六位|one[- ]?time|verification\s*code/i.test(text) && !/password|密码/i.test(text);
      const isPw = /pass|密码/i.test(text);
      if (!isMfa && cfg.password && (isPw || this._kbTried < 1) && (this._kbTried || 0) < 3) {
        // 明确的密码提示，或未知提示（先自动试会话密码）；最多 3 次，防止无限重交
        this._kbTried = (this._kbTried || 0) + 1;
        return finish([cfg.password]);
      }
      const askUser = (prompt, mfa) => {
        // 交给用户输入：弹窗未决期间暂停握手计时（用户掏手机看验证码不应被掐断）
        this.setStatus('mfa-wait', mfa ? t('conn.waitingMfa') : t('conn.waitingCred'));
        this.disarmHandshake();
        this.ipc
          .askMfa(prompt, { mfa })
          .then((code) => { this.armHandshake(); finish([code]); })
          .catch(() => { this.armHandshake(); finish(['']); });
      };
      if (isMfa || !cfg.password) {
        // 真 MFA / 无密码：交给用户输入（弹窗标题按类型区分）
        return askUser(p.prompt || t('conn.enterCred'), isMfa);
      }
      // 自动试过一次仍被问（密码可能已改）→ 让用户输入
      askUser(p.prompt || t('mfa.enterPassword'), /otp|验证码/i.test(text));
    });

    let auth;
    try {
      auth = authOpts(cfg);
    } catch (e) {
      return this.setStatus('error', t('conn.authConfigError', e.message));
    }

    const attach = (sock) => {
      if (this.status === 'error' || this.status === 'disconnected') return sock.destroy();
      const connectOpts = {
        sock,
        username: cfg.user,
        tryKeyboard: true,
        readyTimeout: 0, // 内置握手超时停用，改用自管计时（见 armHandshake）
        // keepalive：0=默认15s；-1=关闭
        keepaliveInterval: cfg.keepalive === -1 ? 0 : (cfg.keepalive > 0 ? cfg.keepalive * 1000 : 15000),
        keepaliveCountMax: 4,
        ...auth,
      };
      if (typeof cfg.verifyHost === 'function') {
        // known_hosts 校验：新指纹自动记住，变更时交给上层决定
        connectOpts.hostVerifier = (key, cb) => {
          const fp = require('crypto').createHash('sha256').update(key).digest('base64');
          this.disarmHandshake(); // 指纹确认弹窗未决期间不计时（用户读警告不该被掐断）
          Promise.resolve(cfg.verifyHost(fp))
            .then((ok) => cb(ok !== false))
            .catch(() => cb(false))
            .finally(() => this.armHandshake()); // 用户已选择：重新起算
        };
      } else {
        connectOpts.hostVerifier = () => true; // 等价 accept-new
      }
      this.armHandshake();
      c.connect(connectOpts);
    };

    // 直连：自建 TCP（8s 超时快速失败）
    dial(cfg.host, cfg.port).then(attach, (err) => this.setStatus('error', err.message));

    // 45 秒未落壳 -> 转手动模式（终端仍可操作）；exec 单命令模式由自身超时管理
    if (!this._execJob) this.manualTimer = setTimeout(() => {
      if (!['connected', 'error', 'disconnected'].includes(this.status)) {
        this.setStatus('manual', t('conn.autoLoginTimeout'));
      }
    }, 45000);
  }

  onReady() {
    this.disarmHandshake(); // 认证完成，握手计时使命结束（交互/exec 两路都至此）
    if (this._execJob) return this._execReady();
    this.setStatus('logging-in');
    this.conn.shell(
      {
        term: this.cfg.emulation || 'xterm-256color',
        rows: this.rows || 30,
        cols: this.cols || 120,
      },
      (err, stream) => {
        if (err) return this.setStatus('error', err.message);
        this.stream = stream;
        stream.on('data', (chunk) => {
          this.feed(chunk);
          this.emit('data', chunk);
        });
        stream.on('close', () => {
          this.disarmHandshake();
          if (this.status !== 'error' && this.status !== 'disconnected') this.setStatus('disconnected');
          this.emit('close');
        });
        // 常规 SSH 语义：无任何自动化的会话（无规则、无 post），shell 通道打开
        // 即已连接、可交互（PTY 会缓冲期间的击键），不猜测远端打印提示符还是菜单。
        // 带自动化的会话（规则 / post）仍等流程收尾再置 connected：
        // 自动注入期间用户击键可能与自动应答交错（如命令被当成 sudo 密码提交）。
        const automated = (Array.isArray(this.cfg.rules) && this.cfg.rules.length) || this.cfg.post;
        if (!automated) this.finishConnect();
      }
    );
  }

  /** 喂数据给自动化监视器（所有数据同时原样发往终端渲染） */
  feed(chunk) {
    this.tail = (this.tail + chunk.toString('utf8')).slice(-1024);
    const t = this.tail;
    const cfg = this.cfg;
    const lastLine = t.slice(t.lastIndexOf('\n') + 1);
    const promptSeen = RE.prompt.test(lastLine.trimEnd()) || /\$$/.test(t.trimEnd());

    // 认证被拒/MFA 提示只在登录阶段判定：connected 之后终端输出里出现
    // "Permission denied"（sudo 失败、命令回显等）或横幅提到验证码，
    // 都属于正常内容，不能据此改状态、盖错误遮罩
    const preConnected = this.status !== 'connected';
    if (preConnected && RE.denied.test(t)) {
      this.setStatus('error', t('conn.authDenied'));
      return;
    }
    if (RE.hostKey.test(t) && this.sends.yes < 2) {
      this.sends.yes++;
      return this.send('yes\r');
    }
    if (preConnected && RE.mfa.test(t) && !this.mfaHinted) {
      this.mfaHinted = true;
      this.setStatus('mfa-wait', t('conn.typeMfaInTerm')); // 仅提示，不阻断规则匹配
    }

    // ---- 登录规则：唯一的自动应答机制（无内置流程；等价 SecureCRT Logon Actions）----
    if (Array.isArray(cfg.rules) && cfg.rules.length) {
      return this.feedRules(cfg.rules);
    }

    // ---- 无规则：协议级通用安全网 ----
    // 密码提示（登录或 sudo 二次密码）自动应答，最多两次防止死循环
    if (RE.password.test(t) && this.sends.pw < 2 && cfg.password) {
      this.sends.pw++;
      this.tail = '';
      return this.send(cfg.password + '\r');
    }
    // 「登录后执行」流程：等真正的 shell 提示符注入 post（触发密码提示时由
    // 上面的安全网应答），之后再次回到提示符即完成。无 post 的会话无需等——
    // shell 打开时已是 connected
    if (promptSeen && cfg.post) {
      if (this.sends.post === 0) {
        this.sends.post = 1;
        this.tail = '';
        return this.send(cfg.post + '\r');
      }
      return this.finishConnect(); // 提示符已回到行尾：post 执行完毕
    }
  }

  /** 自定义规则引擎：按顺序等 expect、发 send；全部发完即视为已就绪 */
  feedRules(rules) {
    if (this.ruleIdx === undefined) this.ruleIdx = 0;
    const rule = rules[this.ruleIdx];
    if (!rule) {
      this.finishConnect();
      return;
    }
    const hit = !rule.expect || this.tail.includes(rule.expect);
    if (!hit) return;
    this.ruleIdx++;
    this.tail = '';
    // 变量替换：$PASSWORD=会话密码，$TARGET=目标地址（避免明文散落在规则里）
    let body = String(rule.send || '');
    if (body.includes('$')) {
      body = body.replace(/\$PASSWORD/g, this.cfg.password || '')
                 .replace(/\$TARGET/g, this.cfg.target || this.cfg.host || '');
    }
    const payload = body + (rule.enter !== '0' ? '\r' : '');
    this.send(payload);
    this.emit('auto-log', { step: this.ruleIdx, total: rules.length, expect: rule.expect || t('conn.immediate') });
    if (this.ruleIdx >= rules.length) {
      this.finishConnect();
      // 规则会话的「登录后执行」：最后一条规则发出后目标 shell 还在初始化，稍候补发；
      // 无规则会话的 post 不走这里——在 feed 中等真正的提示符再发
      if (this.cfg.post && !this.postSent) {
        this.postSent = true;
        setTimeout(() => {
          if (this.stream) this.send(this.cfg.post + '\r');
        }, 600);
      }
    }
  }

  /** 连接流程完成：标记就绪 */
  finishConnect() {
    if (this.status === 'connected') return;
    this.setStatus('connected');
  }

  send(s) {
    if (this.stream) this.stream.write(s);
  }

  /** SFTP 子系统（直连/raw 会话可用；懒加载并缓存，通道断开自动失效重开） */
  sftp() {
    if (this.cfg.type === 'bastion') {
      return Promise.reject(new Error(t('conn.sftpBastionUnsupported')));
    }
    if (!this.conn) return Promise.reject(new Error(t('conn.notEstablished')));
    if (this.status === 'error' || this.status === 'disconnected') {
      return Promise.reject(new Error(t('conn.sftpDisconnected')));
    }
    if (this._sftp) return this._sftp;
    const p = new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error(t('conn.notEstablished')));
      this.conn.sftp((err, sftp) => {
        if (err) {
          if (this._sftp === p) this._sftp = null;
          return reject(err);
        }
        // 通道被服务端关闭 / 协议错误时失效缓存，下次调用自动重开（自愈）
        const die = () => { if (this._sftp === p) this._sftp = null; };
        sftp.once('end', die);
        sftp.once('close', die);
        resolve(sftp);
      });
    });
    this._sftp = p;
    return p;
  }

  /* ================= 单命令执行（MCP / 自动化） =================
     连接 → ssh2 exec() 通道（无 PTY）→ 收集 stdout/stderr → 断开。
     与交互 shell 互斥；全程零交互（无凭据直接拒绝，不触发任何弹窗）；
     输出 stdout/stderr 各截断 256KB（truncated 标记）。 */
  runExec(command, timeoutMs = 30000) {
    if (this._execJob) return Promise.reject(new Error(t('conn.execBusy')));
    if (this.status !== 'idle') return Promise.reject(new Error(t('conn.execBadState', this.status)));
    const cfg = this.cfg;
    const hasCred = cfg.auth === 'agent' || (cfg.auth === 'key' && cfg.keyPath) || !!cfg.password;
    if (!hasCred) {
      return Promise.reject(new Error(t('conn.execNoCred')));
    }
    return new Promise((resolve, reject) => {
      const job = (this._execJob = {
        command,
        out: [], outBytes: 0,
        err: [], errBytes: 0,
        truncated: false, done: false,
        resolve, reject,
        timer: setTimeout(
          () => this._finishExec(null, t('conn.execTimeout', Math.round(timeoutMs / 1000))),
          timeoutMs
        ),
      });
      this.connect(); // hasCred 已保证不会走 askPassword 询问路径
    });
  }

  _execReady() {
    const job = this._execJob;
    this.conn.exec(job.command, (err, stream) => {
      if (err) return this._finishExec(null, t('conn.execOpenFailed', err.message));
      stream.on('data', (b) => this._execCollect(job, 'out', b));
      stream.stderr.on('data', (b) => this._execCollect(job, 'err', b));
      stream.on('close', (code) =>
        this._finishExec({
          stdout: Buffer.concat(job.out).toString('utf8'),
          stderr: Buffer.concat(job.err).toString('utf8'),
          exitCode: code == null ? null : code,
          truncated: job.truncated,
        })
      );
    });
  }

  _execCollect(job, which, buf) {
    const chunks = job[which];
    const used = which + 'Bytes';
    const room = EXEC_CAP_BYTES - job[used];
    if (room <= 0) {
      job.truncated = true;
      return;
    }
    if (buf.length > room) {
      chunks.push(buf.subarray(0, room));
      job[used] = EXEC_CAP_BYTES;
      job.truncated = true;
    } else {
      chunks.push(buf);
      job[used] += buf.length;
    }
  }

  _finishExec(result, errMsg) {
    const job = this._execJob;
    if (!job || job.done) return;
    job.done = true;
    this._execJob = null;
    clearTimeout(job.timer);
    // 静默收尾：exec 模式不广播状态流，直接改状态拦截拨号在途的 attach
    this.status = errMsg ? 'error' : 'disconnected';
    this.destroy();
    if (errMsg) job.reject(new Error(errMsg));
    else job.resolve(result);
  }

  /** 关闭并失效缓存的 SFTP 通道（取消在途传输 / 断线清理）；下次 sftp() 自动重开 */
  closeSftp() {
    const p = this._sftp;
    this._sftp = null;
    if (p) p.then((sftp) => { try { sftp.end(); } catch (e) { /* 已关闭 */ } }, () => {});
  }

  /** 供端口转发使用的底层连接 */
  get client() {
    return this.conn;
  }

  write(data) {
    if (this.stream) this.stream.write(data);
  }

  resize(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    if (this.stream && rows > 0 && cols > 0) {
      this.stream.setWindow(rows, cols, 480, 480);
    }
  }

  destroy() {
    clearTimeout(this.manualTimer);
    this.disarmHandshake();
    this.closeSftp();
    try { this.conn && this.conn.end(); } catch (e) { /* ignore */ }
  }
}

module.exports = { SshSession, RE };
