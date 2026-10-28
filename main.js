'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const Zmodem = require('zmodem.js');
const { loadSessions, publicSessions, saveSessions, DATA_DIR } = require('./lib/sessions');
const sshconfig = require('./lib/sshconfig');

const store = require('./lib/store');
const { SshSession } = require('./lib/connect');
const { HubTermMcpServer, loadMcpConfig, saveMcpConfig } = require('./lib/mcp');
const i18n = require('./lib/i18n');
const t = i18n.t;
const updater = require('./lib/updater');

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const SETTINGS = path.join(DATA_DIR, 'settings.json');

let win = null;
let sessions = [];
const states = new Map(); // id -> {ssh, sentry, zm, logStream, name, fwdServers: Map}
const mfaWaiters = new Map();
const credWaiters = new Map();
let nextId = 1;
let settings = { logging: true, legacyTSV: true, restoreMode: 'manual', openTabs: [], uiTheme: 'auto', lang: '' };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch (e) { /* 默认 */ }
// 语言：settings.json 记忆优先，否则跟随系统（渲染层首次切换后会同步进来）
i18n.setLang(settings.lang || (/^zh/i.test(app.getLocale()) ? 'zh-CN' : 'en'));

// 密码存储：明文 + 600 权限。不接 Keychain——ad-hoc 签名下每次启动都会弹钥匙串授权，
// 体验不可接受；未来用正式证书签名后再启用 safeStorage（setCodec 钩子已预留）。

function toastViaStatus(sid, text) {
  send('session:status', { id: sid, status: 'manual', msg: text });
}
function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}
function saveSettings() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(settings)); } catch (e) {}
}

/* ================= known_hosts 校验 ================= */
function verifyHostFingerprint(host, port, fp) {
  const known = store.listKnownHosts();
  const k = `${host}:${port}`;
  if (!known[k]) {
    known[k] = fp;
    store.saveKnownHosts(known);
    return Promise.resolve(true); // 首次连接：信任并记住
  }
  if (known[k] === fp) return Promise.resolve(true);
  // 指纹变更：可能是重装/换 IP，也可能是中间人——交给用户判断
  return dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: [t('fp.reject'), t('fp.trust')],
      defaultId: 0,
      cancelId: 0,
      message: t('fp.changed', k),
      detail: t('fp.detail', known[k], fp),
    })
    .then((r) => {
      if (r.response === 1) {
        known[k] = fp;
        store.saveKnownHosts(known);
        return true;
      }
      return false;
    });
}

/* ================= ZMODEM（主进程，lrzsz 兼容补丁版 zmodem.js） ================= */
class ZmodemManager {
  constructor(id, ssh) {
    this.id = id;
    this.ssh = ssh;
    this.zsession = null;
    this.busy = false;
    this.pendingFiles = null;
  }

  emitProgress(p) { send('zmodem:progress', { id: this.id, ...p }); }

  async rz() {
    if (this.busy) return;
    const r = await dialog.showOpenDialog(win, {
      title: t('zm.pickUpload'),
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return;
    this.pendingFiles = r.filePaths;
    this.ssh.write('rz\r');
    this.emitProgress({ phase: 'wait', direction: 'send', name: r.filePaths.map((f) => path.basename(f)).join(', ') });
    setTimeout(() => {
      if (!this.zsession && this.pendingFiles) {
        this.pendingFiles = null;
        this.emitProgress({ phase: 'fail', msg: t('zm.rzNoResponse') });
      }
    }, 20000);
  }

  async onDetect(detection) {
    if (this.busy) { detection.deny(); return; }
    this.busy = true;
    const zs = (this.zsession = detection.confirm());
    zs.on('session_end', () => this.cleanup());

    if (zs.type === 'send') {
      let files = this.pendingFiles;
      this.pendingFiles = null;
      if (!files) {
        const r = await dialog.showOpenDialog(win, {
          title: t('zm.pickSend'),
          properties: ['openFile', 'multiSelections'],
        });
        files = r.canceled ? [] : r.filePaths;
      }
      if (!files.length) { this.abort(); return; }
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const data = fs.readFileSync(f);          this.emitProgress({ phase: 'start', direction: 'send', name: path.basename(f), bytes: 0, total: data.length });
          const xfer = await zs.send_offer({
            name: path.basename(f), size: data.length, mode: 0o644,
            files_remaining: files.length - i, bytes_remaining: data.length,
          });
          if (!xfer) continue;
          for (let off = 0; off < data.length; off += 8192) {
            xfer.send(Array.from(data.subarray(off, off + 8192)));
            this.emitProgress({ phase: 'progress', direction: 'send', name: path.basename(f), bytes: Math.min(off + 8192, data.length), total: data.length });
          }
          await xfer.end();
        }
        await zs.close();
        this.emitProgress({ phase: 'done' });
        this.cleanup();
      } catch (e) {
        this.emitProgress({ phase: 'fail', msg: e.message || String(e) });
        this.cleanup();
      }
    } else {
      zs.on('offer', async (xfer) => {
        const details = xfer.get_details();
        let bytes = 0;
        this.emitProgress({ phase: 'start', direction: 'recv', name: details.name, bytes: 0, total: details.size });
        xfer.on('input', (payload) => {
          bytes += payload.length;
          this.emitProgress({ phase: 'progress', direction: 'recv', name: details.name, bytes, total: details.size });
        });
        try {
          const payloads = await xfer.accept();
          const data = Buffer.concat(payloads.map((p) => Buffer.from(p)));
          const r = await dialog.showSaveDialog(win, {
            title: t('zm.saveAs', details.name),
            defaultPath: path.join(app.getPath('downloads'), details.name),
          });
          if (!r.canceled) {
            fs.writeFileSync(r.filePath, data);
            this.emitProgress({ phase: 'saved', name: r.filePath, bytes: data.length });
          }
        } catch (e) {
          this.emitProgress({ phase: 'fail', msg: e.message || String(e) });
        }
      });
      zs.start();
    }
  }

  abort() {
    if (this.zsession) { try { this.zsession.abort(); } catch (e) { /* ignore */ } }
    this.cleanup();
  }
  cancel() {
    this.abort();
    this.emitProgress({ phase: 'fail', msg: t('zm.cancelled') });
  }
  cleanup() {
    this.busy = false;
    this.zsession = null;
    this.pendingFiles = null;
  }
}

/* ================= 端口转发 ================= */
class ForwardManager {
  constructor(sid, ssh) {
    this.sid = sid;
    this.ssh = ssh;
    this.servers = new Map(); // ruleId -> net.Server
  }
  // 应用该会话的全部启用规则
  async apply() {
    const key = this.ssh.cfg.key;
    if (key.startsWith('adhoc:')) return;
    const rules = store.forwardsFor(key).filter((r) => r.enabled);
    for (const rule of rules) this.start(rule);
  }
  start(rule) {
    if (this.servers.has(rule.id)) return;
    const ssh = this.ssh;
    const server = net.createServer((sock) => {
      ssh.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, rule.host, rule.port, (err, stream) => {
        if (err) { sock.destroy(); return; }
        stream.pipe(sock).pipe(stream);
        stream.on('error', () => sock.destroy());
        sock.on('error', () => stream.destroy());
      });
    });
    server.on('error', (err) => {
      send('session:status', { id: this.sid, status: 'manual', msg: t('fwd.listenFailed', rule.listen, err.code) });
      this.servers.delete(rule.id);
    });
    server.listen(rule.listen, '127.0.0.1', () => {
      send('forward:status', { id: this.sid, ruleId: rule.id, listening: true });
    });
    this.servers.set(rule.id, server);
  }
  stop(ruleId) {
    const s = this.servers.get(ruleId);
    if (s) { try { s.close(); } catch (e) {} this.servers.delete(ruleId); }
  }
  destroy() {
    for (const [id] of this.servers) this.stop(id);
  }
}

/* ================= 会话生命周期 ================= */
function openLogStream(cfg) {
  // 每会话日志覆盖：'' 跟随全局 | on | off
  const mode = cfg.logMode || '';
  if (mode === 'off') return null;
  if (mode !== 'on' && !settings.logging) return null;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const d = new Date();
    const safe = (cfg.name || 'session').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return fs.createWriteStream(path.join(LOGS_DIR, `${stamp}_${safe}.log`), { flags: 'a' });
  } catch (e) { return null; }
}

// 密码凭证弹窗：返回 {password, remember}；取消返回空密码
function askPasswordDialog(sid, prompt, kind) {
  return new Promise((resolve) => {
    credWaiters.set(sid, resolve);
    send('cred:ask', { id: sid, prompt, kind: kind || 'empty' });
  });
}

// 记住密码：更新本会话 + 同主机同用户的所有会话（密码轮换一次改全）
function persistPassword(cfgKey, host, user, password) {
  const hit = sessions.filter((s) => s.host === host && s.user === user && s.auth !== 'key' && s.auth !== 'agent');
  if (!hit.length) return 0;
  for (const s of hit) s.password = password;
  saveSessions(sessions);
  send('sessions:updated', { sessions: publicSessions(sessions) });
  return hit.length;
}

function wireSession(sid, st, cfg) {
  const s = new SshSession(cfg, {
    askMfa: (prompt, opts) =>
      new Promise((resolve) => {
        st.mfaAsked = true; // 已进入 MFA 阶段：后续认证失败不再怪密码
        mfaWaiters.set(sid, resolve); send('mfa:ask', { id: sid, prompt, mfa: !!(opts && opts.mfa) });
      }),
    askPassword: (prompt) => askPasswordDialog(sid, prompt, 'empty'),
  });
  // 引擎请求记住密码（连接前询问时勾选）
  s.on('save-password', (password) => {
    const n = persistPassword(null, cfg.host, cfg.user, password);
    if (n) toastViaStatus(sid, t('main.passwordSaved', n));
  });
  st.ssh = s;
  st.zm.ssh = s;
  st.fwd = new ForwardManager(sid, s);
  st.logStream = openLogStream(cfg);

  s.on('data', (chunk) => {
    st.logStream && st.logStream.write(chunk);
    try { st.sentry.consume(chunk); } catch (e) { send('session:data', { id: sid, data: chunk }); }
  });
  s.on('status', (status, msg) => {
    send('session:status', { id: sid, status, msg });
    if (status === 'connected') {
      st.attempts = 0;
      st.reasked = false;
      st.fwd.apply();
    }
    // 认证被拒且是密码认证 -> 静默拦截（不向界面发 error），直接弹重输框；
    // 用户取消或重输后仍失败才显示连接失败。密码轮换场景一次改全同主机会话。
    if (status === 'error' && /auth|认证|denied/i.test(msg || '') && st.mfaAsked && !st.manuallyClosed) {
      // MFA 阶段的失败：验证码错误或已取消——明确归因，不再弹密码重输框
      send('session:status', { id: sid, status: 'auth-failed', msg: t('main.mfaFailed', cfg.user, cfg.host) });
      return;
    }
    if (status === 'error' && /auth|认证|denied/i.test(msg || '') && (!cfg.auth || cfg.auth === 'password') && !st.manuallyClosed) {
      if (st.reasked) {
        // 已重输过仍失败：这次把错误透出（包含服务器原文）
        send('session:status', { id: sid, status: 'auth-failed', msg });
        return;
      }
      st.reasked = true;
      send('session:status', { id: sid, status: 'reauth', msg: t('main.passwordRejected', cfg.user, cfg.host) });
      askPasswordDialog(sid, t('main.reenterPassword', cfg.user, cfg.host), 'rejected')
        .then(({ password, remember }) => {
          if (!password || st.manuallyClosed) {
            send('session:status', { id: sid, status: 'error', msg: t('main.authCancelled', cfg.user, cfg.host) });
            return;
          }
          cfg.password = password;
          if (remember) persistPassword(cfg.key, cfg.host, cfg.user, password);
          st.attempts = 0;
          send('session:status', { id: sid, status: 'connecting', msg: t('main.reconnectingNewPw') });
          wireSession(sid, st, cfg);
        });
      return; // 不透出原始 error
    }
    if (status === 'disconnected') st.fwd.destroy();
    if (status === 'error') {
      st.fwd.destroy();
      st.lastError = msg || '';
    }
    // 断线自动重连（认证失败/手动关闭不重试）
    if (status === 'disconnected' && !st.manuallyClosed && cfg.autoReconnect > 0) {
      st.attempts = (st.attempts || 0) + 1;
      if (st.attempts <= cfg.autoReconnect) {
        const delay = Math.min(2000 * st.attempts, 10000);
        st.reconnectTimer = setTimeout(() => {
          if (st.manuallyClosed) return;
          send('session:status', { id: sid, status: 'connecting', msg: t('main.autoReconnect', st.attempts, cfg.autoReconnect) });
          wireSession(sid, st, cfg);
        }, delay);
      }
    }
  });
  s.connect();
}

// 解析跳板：jumpKey -> 对方会话的连接参数（防止自引用与链式跳板）
function resolveJump(cfg) {
  if (!cfg.jumpKey || cfg.type === 'local') return null;
  const j = sessions.find((s) => s.key === cfg.jumpKey);
  if (!j || j.key === cfg.key) return { err: t('main.jumpMissing') };
  if (j.jumpKey) return { err: t('main.jumpChain', j.name) };
  const via = { host: j.host, port: j.port, username: j.user, password: j.password,
                auth: j.auth, keyPath: j.keyPath, keyPass: j.keyPass };
  return { via };
}

function startSession(cfg, id) {
  const sid = id || nextId++;
  const st = { ssh: null, sentry: null, zm: null, logStream: null, name: cfg.name || cfg.host, fwd: null, mfaAsked: false };
  states.set(sid, st);

  st.zm = new ZmodemManager(sid, null);
  st.sentry = new Zmodem.Sentry({
    to_terminal: (octets) => send('session:data', { id: sid, data: Buffer.from(octets) }),
    sender: (bytes) => st.ssh && st.ssh.write(Buffer.from(bytes)),
    on_retract: () => {},
    on_detect: (det) => st.zm.onDetect(det),
  });

  const cfgFull = { ...cfg, verifyHost: (fp) => verifyHostFingerprint(cfg.host, cfg.port, fp) };
  if (cfg.jumpKey) {
    const r = resolveJump(cfgFull);
    if (r.err) { send('session:status', { id: sid, status: 'error', msg: r.err }); return sid; }
    cfgFull.via = r.via;
  }
  wireSession(sid, st, cfgFull);
  return sid;
}

function destroyState(id) {
  const st = states.get(id);
  if (!st) return;
  try { st.fwd && st.fwd.destroy(); } catch (e) {}
  try { st.ssh && st.ssh.destroy(); } catch (e) {}
  try { st.logStream && st.logStream.end(); } catch (e) {}
  states.delete(id);
  mfaWaiters.delete(id);
  credWaiters.delete(id);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    // macOS 融合式红绿灯；Windows/Linux 走系统标准标题栏
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 14 } }
      : {}),
    // 启动一瞬间的窗口底色跟随上次的外观设置，避免浅色模式下先闪一帧深色
    backgroundColor: settings.uiTheme === 'light' ? '#eef1f6' : '#111118',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

function buildMenu() {
  const sendAction = (action) => () => send('menu:action', { action });
  const template = [
    {
      label: 'HubTerm',
      submenu: [
        { label: t('menu.about'), click: () => app.showAboutPanel() },
        { label: t('menu.checkUpdates'), click: () => doCheckUpdate(true) },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.palette'), accelerator: 'CmdOrCtrl+P', click: sendAction('palette') },
        { label: t('menu.quickConnect'), accelerator: 'CmdOrCtrl+N', click: sendAction('quick-connect') },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: sendAction('close-tab') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        // 复制/粘贴/全选交给渲染层按焦点路由（终端选区 vs 输入框选区），原生 role 拿不到 xterm 选区
        { label: t('menu.copy'), accelerator: 'CmdOrCtrl+C', click: sendAction('copy') },
        { label: t('menu.paste'), accelerator: 'CmdOrCtrl+V', click: sendAction('paste') },
        { label: t('menu.selectAll'), accelerator: 'CmdOrCtrl+A', click: sendAction('select-all') },
        { type: 'separator' },
        { label: t('menu.find'), accelerator: 'CmdOrCtrl+F', click: sendAction('find') },
      ],
    },
    {
      label: t('menu.session'),
      submenu: [
        { label: t('menu.newSession'), accelerator: 'CmdOrCtrl+Shift+N', click: sendAction('new-session') },
        { label: t('menu.editSession'), accelerator: 'CmdOrCtrl+E', click: sendAction('edit-session') },
        { label: t('menu.reconnect'), accelerator: 'CmdOrCtrl+R', click: sendAction('reconnect') },
        { label: t('menu.reloadLibrary'), accelerator: 'CmdOrCtrl+Shift+R', click: () => reloadSessions() },
        { type: 'separator' },
        { label: t('menu.forwards'), accelerator: 'CmdOrCtrl+L', click: sendAction('forwards') },
        { label: t('menu.sftp'), accelerator: 'CmdOrCtrl+Shift+F', click: sendAction('sftp') },
        { label: t('menu.snippets'), accelerator: 'CmdOrCtrl+Shift+K', click: sendAction('snippets') },
        { type: 'separator' },
        { label: t('menu.exportBackup'), click: () => exportBackup() },
        { label: t('menu.importBackup'), click: () => importBackup() },
        {
          label: t('menu.importSshConfig'),
          click: async () => {
            const r = doImportSSHConfig();
            dialog.showMessageBox(win, r.error ? { type: 'error', message: r.error } : { type: 'info', message: r.detail });
          },
        },
        { type: 'separator' },
        {
          label: t('menu.sessionLog'),
          type: 'checkbox',
          checked: settings.logging,
          click: (mi) => { settings.logging = mi.checked; saveSettings(); },
        },
        { label: t('menu.openLogDir'), click: () => shell.openPath(LOGS_DIR) },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.toggleSidebar'), accelerator: 'CmdOrCtrl+B', click: sendAction('toggle-sidebar') },
        { label: t('menu.clear'), accelerator: 'CmdOrCtrl+K', click: sendAction('clear') },
        { type: 'separator' },
        { label: t('menu.splitV'), accelerator: 'CmdOrCtrl+D', click: sendAction('split-right') },
        { label: t('menu.splitH'), accelerator: 'CmdOrCtrl+Shift+D', click: sendAction('split-down') },
        { type: 'separator' },
        { label: t('menu.fontInc'), accelerator: 'CmdOrCtrl+=', click: sendAction('font-inc') },
        { label: t('menu.fontDec'), accelerator: 'CmdOrCtrl+-', click: sendAction('font-dec') },
        { label: t('menu.fontReset'), accelerator: 'CmdOrCtrl+0', click: sendAction('font-reset') },
        { type: 'separator' },
        { label: t('menu.themeCycle'), click: sendAction('theme-cycle') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+/', click: sendAction('help') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [{ role: 'minimize', label: t('menu.minimize') }, { role: 'zoom', label: t('menu.zoom') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 更新检查：只提示不静默替换（macOS 自更新需正式签名，未签名阶段引导到 Releases） ---------- */
let updateChecking = false;
async function doCheckUpdate(interactive) {
  if (updateChecking) return;
  updateChecking = true;
  send('updater:checking', {});
  const info = await updater.checkForUpdates({ currentVersion: app.getVersion() });
  updateChecking = false;
  send('updater:status', { status: info.status, latest: info.latest, url: info.url });
  if (info.status === 'available') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: t('upd.available', info.latest),
      detail: (info.notes || '').slice(0, 800) || t('upd.noNotes'),
      buttons: [t('upd.goDownload'), t('upd.later')],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(info.url);
  } else if (interactive) {
    if (info.status === 'up-to-date') {
      dialog.showMessageBox(win, { type: 'info', message: t('upd.upToDate', info.currentVersion) });
    } else {
      dialog.showMessageBox(win, { type: 'error', message: t('upd.checkFailed'), detail: info.error });
    }
  }
}

function reloadSessions() {
  try {
    sessions = loadSessions();
  } catch (e) {
    sessions = [];
    send('sessions:error', { message: t('main.loadFailed', e.message) });
    return;
  }
  send('sessions:updated', { sessions: publicSessions(sessions) });
}

function exportBackup() {
  dialog.showSaveDialog(win, {
    title: t('backup.exportTitle'),
    defaultPath: path.join(app.getPath('documents'), `hubterm-backup-${Date.now()}.json`),
  }).then((r) => {
    if (r.canceled) return;
    fs.writeFileSync(r.filePath, store.exportSessions(sessions), { mode: 0o600 });
    dialog.showMessageBox(win, { type: 'info', message: t('backup.exported'), detail: t('backup.exportedDetail', sessions.length, r.filePath) });
  });
}

function importBackup() {
  dialog.showOpenDialog(win, { title: t('backup.importTitle'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    .then(async (r) => {
      if (r.canceled || !r.filePaths.length) return;
      let imported;
      try {
        imported = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      } catch (e) {
        return dialog.showMessageBox(win, { type: 'error', message: t('backup.parseFailed'), detail: e.message });
      }
      const { listSnippets } = store; // snippets 一并导入
      const snippetCount = Array.isArray(imported.snippets) ? imported.snippets.length : 0;
      const confirm = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('common.cancelMain'), t('backup.importBtn')],
        defaultId: 1,
        message: t('backup.importTitle'),
        detail: t('backup.importDetail', imported.sessions?.length || 0, snippetCount),
      });
      if (confirm.response !== 1) return;
      const result = store.importSessions(sessions, imported);
      sessions = result.merged;
      saveSessions(sessions);
      if (snippetCount) {
        const mergedSnippets = [...store.listSnippets()];
        for (const sn of imported.snippets) {
          const i = mergedSnippets.findIndex((x) => x.id === sn.id || x.name === sn.name);
          if (i >= 0) mergedSnippets[i] = sn; else mergedSnippets.push(sn);
        }
        store.saveSnippets(mergedSnippets);
        send('snippets:updated', { snippets: mergedSnippets });
      }
      reloadSessions();
      dialog.showMessageBox(win, { type: 'info', message: t('backup.importDone'), detail: t('backup.importDoneDetail', result.added, result.updated) });
    });
}

/* ================= IPC ================= */
ipcMain.handle('sessions:list', () => publicSessions(sessions));

// 会话恢复：mode = auto(恢复并自动连接) | manual(恢复但不连接) | off
// openTabs 由渲染层在标签变化时上报，持久化在 settings.json
ipcMain.handle('restore:info', () => ({
  mode: settings.restoreMode || 'manual',
  keys: Array.isArray(settings.openTabs) ? settings.openTabs : [],
  lang: i18n.getLang(), // 渲染层无本地语言记忆时采用主进程保存的选择
}));
ipcMain.on('restore:saveTabs', (e, keys) => {
  settings.openTabs = Array.isArray(keys) ? keys.slice(0, 12) : [];
  saveSettings();
});
ipcMain.on('restore:setMode', (e, mode) => {
  if (['auto', 'manual', 'off'].includes(mode)) { settings.restoreMode = mode; saveSettings(); }
});
// 渲染层外观变更上报：只用于下次启动的窗口底色，界面主题的事实来源是渲染层 localStorage
ipcMain.on('theme:set', (e, mode) => {
  if (['auto', 'dark', 'light'].includes(mode)) { settings.uiTheme = mode; saveSettings(); }
});
// 渲染层语言切换：主进程菜单/对话框同步 + settings.json 持久化
ipcMain.on('lang:set', (e, lang) => {
  if (!['zh-CN', 'en'].includes(lang)) return;
  settings.lang = lang;
  saveSettings();
  if (i18n.getLang() !== lang) { i18n.setLang(lang); buildMenu(); }
});

// 退出时询问恢复策略（⌘Q / 关窗都会走到）
let quitFlowDone = false;
app.on('before-quit', (e) => {
  if (quitFlowDone) return;
  const hasTabs = Array.isArray(settings.openTabs) && settings.openTabs.length > 0;
  if (!hasTabs || !win || win.isDestroyed()) { quitFlowDone = true; return; }
  e.preventDefault();
  dialog.showMessageBox(win, {
    type: 'question',
    title: t('quit.title'),
    message: t('quit.message', settings.openTabs.length),
    detail: t('quit.detail'),
    buttons: [t('quit.restoreAuto'), t('quit.restoreManual'), t('quit.restoreOff'), t('quit.cancel')],
    defaultId: 1,
    cancelId: 3,
  }).then((r) => {
    if (r.response === 3) return; // 取消退出
    settings.restoreMode = ['auto', 'manual', 'off'][r.response];
    saveSettings();
    quitFlowDone = true;
    app.quit();
  });
});
ipcMain.handle('session:open', (e, key) => {
  const cfg = sessions.find((s) => s.key === key);
  if (!cfg) return { error: t('main.sessionMissing', key) };
  const id = startSession(cfg);
  return { id, session: { ...cfg, password: undefined } };
});
ipcMain.handle('adhoc:open', (e, a) => {
  const cfg = {
    key: 'adhoc:' + nextId,
    name: `${a.user}@${a.host}`,
    type: 'ssh',
    host: a.host,
    port: a.port || 22,
    user: a.user,
    target: a.host,
    tuser: a.user,
    post: '',
    group: '快速连接',
    password: a.password || '',
  };
  const id = startSession(cfg);
  return { id, session: { ...cfg, password: undefined } };
});
ipcMain.handle('session:save', (e, s) => {
  let key = s.key;
  if (key) {
    const idx = sessions.findIndex((x) => x.key === key);
    if (idx < 0) return { error: t('main.sessionMissingShort') };
    const old = sessions[idx];
    sessions[idx] = { ...old, ...s, password: s.password ? s.password : old.password };
    const newKey = (s.group ? s.group + '/' : '') + s.name;
    if (newKey !== key) {
      while (sessions.some((x) => x.key === newKey)) return { error: t('main.duplicateKey', newKey) };
      sessions[idx] = { ...sessions[idx], key: newKey };
      key = newKey;
    }
  } else {
    key = (s.group ? s.group + '/' : '') + s.name;
    while (sessions.some((x) => x.key === key)) return { error: t('main.duplicateKey', key) };
    sessions.push({ ...s, key });
  }
  saveSessions(sessions);
  send('sessions:updated', { sessions: publicSessions(sessions) });
  return { ok: true, key };
});
ipcMain.handle('session:delete', (e, key) => {
  sessions = sessions.filter((x) => x.key !== key);
  // 顺带清理该会话的转发规则
  const fw = store.listForwards();
  delete fw[key];
  store.saveForwards(fw);
  saveSessions(sessions);
  send('sessions:updated', { sessions: publicSessions(sessions) });
  return { ok: true };
});

ipcMain.on('session:write', (e, { id, data }) => {
  const st = states.get(id);
  if (st && st.ssh) st.ssh.write(Buffer.from(data));
});
ipcMain.on('session:resize', (e, { id, rows, cols }) => {
  const st = states.get(id);
  if (st && st.ssh) st.ssh.resize(rows, cols);
});
ipcMain.on('session:close', (e, { id }) => {
  const st = states.get(id);
  if (st) st.manuallyClosed = true;
  if (st && st.reconnectTimer) clearTimeout(st.reconnectTimer);
  destroyState(id);
});
ipcMain.handle('session:reconnect', (e, { id }) => {
  const st = states.get(id);
  if (!st) return { error: t('main.sessionGone') };
  const cfg = st.ssh.cfg;
  st.manuallyClosed = false;
  st.attempts = 0;
  if (st.reconnectTimer) clearTimeout(st.reconnectTimer);
  try { st.fwd && st.fwd.destroy(); } catch (err) {}
  try { st.ssh.destroy(); } catch (err) {}
  try { st.logStream && st.logStream.end(); } catch (err) {}
  wireSession(id, st, cfg);
  return { ok: true };
});
ipcMain.on('cred:reply', (e, { id, password, remember }) => {
  const resolve = credWaiters.get(id);
  if (resolve) { credWaiters.delete(id); resolve({ password: password || '', remember: !!remember }); }
});
ipcMain.on('mfa:reply', (e, { id, code }) => {
  const resolve = mfaWaiters.get(id);
  if (resolve) { mfaWaiters.delete(id); resolve(code || ''); }
});

// 剪贴板走主进程：不受渲染层焦点/权限限制（navigator.clipboard 在窗口无焦点时会静默失败）
ipcMain.handle('clip:read', () => clipboard.readText('clipboard'));
ipcMain.handle('clip:write', (e, t) => { if (typeof t === 'string') clipboard.writeText(t, 'clipboard'); return { ok: true }; });

// ZMODEM
ipcMain.on('zmodem:rz', (e, { id }) => { const st = states.get(id); if (st) st.zm.rz(); });
ipcMain.on('zmodem:cancel', (e, { id }) => { const st = states.get(id); if (st) st.zm.cancel(); });

// 从 ~/.ssh/config 导入
function doImportSSHConfig() {
  const file = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(file)) return { error: t('sshcfg.missing') };
  let added;
  try {
    const items = sshconfig.importFromFile(file, sessions);
    for (const it of items) {
      const { _proxyjump, ...clean } = it;
      sessions.push(clean);
    }
    added = items.length;
    if (added) saveSessions(sessions);
    send('sessions:updated', { sessions: publicSessions(sessions) });
  } catch (e) {
    return { error: t('sshcfg.parseFailed', e.message) };
  }
  return { ok: true, added, detail: added ? t('sshcfg.imported', added) : t('sshcfg.noNew') };
}
ipcMain.handle('sshconfig:import', () => doImportSSHConfig());

// Snippets
ipcMain.handle('snippets:list', () => store.listSnippets());
ipcMain.handle('snippets:save', (e, list) => {
  store.saveSnippets(list);
  send('snippets:updated', { snippets: list });
  return { ok: true };
});

// 端口转发
ipcMain.handle('forwards:list', (e, key) => store.forwardsFor(key));
ipcMain.handle('forwards:save', (e, { key, rules }) => {
  const all = store.listForwards();
  all[key] = rules;
  store.saveForwards(all);
  // 对所有使用该 key 的活跃会话重载规则
  for (const [, st] of states) {
    if (st.ssh && st.ssh.cfg.key === key && st.fwd) {
      st.fwd.destroy();
      if (st.ssh.status === 'connected') st.fwd.apply();
    }
  }
  return { ok: true };
});

// SFTP
const sftpTransfers = new Map(); // id -> { cancelled }（取消在途传输用）
function sftpOf(id) {
  const st = states.get(id);
  if (!st || !st.ssh) return Promise.reject(new Error(t('sftp.notConnected')));
  return st.ssh.sftp();
}
ipcMain.handle('sftp:list', async (e, { id, p }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => {
    sftp.readdir(p || '.', (err, list) => {
      if (err) return reject(err);
      const entries = list
        .map((x) => ({
          name: x.filename,
          isDir: (x.attrs.mode & 0o170000) === 0o040000,
          isLink: (x.attrs.mode & 0o170000) === 0o120000,
          size: x.attrs.size || 0,
          mtime: (x.attrs.mtime || 0) * 1000,
        }))
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      resolve({ path: p || '.', entries });
    });
  });
});
ipcMain.handle('sftp:realpath', async (e, { id, p }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => sftp.realpath(p || '.', (err, abs) => (err ? reject(err) : resolve(abs))));
});
ipcMain.handle('sftp:mkdir', async (e, { id, p }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => sftp.mkdir(p, (err) => (err ? reject(err) : resolve())));
});
ipcMain.handle('sftp:rm', async (e, { id, p }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => sftp.unlink(p, (err) => (err ? reject(err) : resolve())));
});
ipcMain.handle('sftp:rmdir', async (e, { id, p }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => sftp.rmdir(p, (err) => (err ? reject(err) : resolve())));
});
ipcMain.handle('sftp:rename', async (e, { id, from, to }) => {
  const sftp = await sftpOf(id);
  return new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
});
// 在途传输注册：取消时关掉 SFTP 通道立即中止（ssh2 无逐传输 abort），错误归一为「已取消」
async function runSftpTransfer(id, run) {
  const tr = { cancelled: false, abort: null };
  sftpTransfers.set(id, tr);
  try {
    const sftp = await sftpOf(id);
    if (tr.cancelled) throw new Error(i18n.t('sftp.cancelled'));
    // 取消时通道关闭使在途请求尽快失败；个别服务端不回 CHANNEL_CLOSE，由 abort 兜底返回
    const work = run(sftp);
    await new Promise((resolve, reject) => {
      let done = false;
      work.then(
        (v) => { if (!done) { done = true; resolve(v); } },
        (e) => { if (!done) { done = true; reject(e); } }
      );
      tr.abort = () => { if (!done) { done = true; reject(new Error(i18n.t('sftp.cancelled'))); } };
    });
  } catch (err) {
    throw new Error(tr.cancelled ? i18n.t('sftp.cancelled') : err.message);
  } finally {
    sftpTransfers.delete(id);
  }
}
ipcMain.handle('sftp:upload', (e, { id, local, remote }) =>
  runSftpTransfer(id, (sftp) => new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, { step: (t) => send('sftp:progress', { id, name: path.basename(remote), bytes: t, op: 'upload' }) },
      (err) => (err ? reject(err) : resolve()));
  })));
ipcMain.handle('sftp:download', (e, { id, remote, local }) =>
  runSftpTransfer(id, (sftp) => new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, { step: (t) => send('sftp:progress', { id, name: path.basename(remote), bytes: t, op: 'download' }) },
      (err) => (err ? reject(err) : resolve()));
  })));
ipcMain.on('sftp:cancel', (e, { id }) => {
  const tr = sftpTransfers.get(id);
  if (!tr) return;
  tr.cancelled = true;
  const st = states.get(id);
  if (st && st.ssh) st.ssh.closeSftp(); // 关闭 SFTP 通道中止在途读写；缓存随之失效，下次操作自动重开新通道
  setTimeout(() => tr.abort && tr.abort(), 2000); // 兜底：个别服务端不回 CHANNEL_CLOSE，限时强制返回
});
ipcMain.on('sftp:reveal', (e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('open-external', (e, url) => {
  if (/^https?:\/\//i.test(url || '')) shell.openExternal(url);
});
ipcMain.handle('dialog:openFiles', () =>
  dialog.showOpenDialog(win, { title: t('sftp.pickUpload'), properties: ['openFile', 'multiSelections'] })
    .then((r) => (r.canceled ? [] : r.filePaths)));
ipcMain.handle('dialog:saveFile', (e, { defaultName }) =>
  dialog.showSaveDialog(win, { title: t('sftp.saveAs'), defaultPath: path.join(app.getPath('downloads'), defaultName || 'file') })
    .then((r) => (r.canceled ? null : r.filePath)));

/* ================= MCP（本地 AI Agent 接入） ================= */
// 详见 docs/mcp-design.md：默认关闭；开启后只绑 127.0.0.1 + token 鉴权；
// exec 走单命令通道并全程审计；approve 模式经渲染层弹窗审批（30s 无响应 = 拒绝）。
let mcpServer = null;
const mcpApprovals = new Map(); // 审批请求 id -> {resolve, timer}

function mcpStatus() {
  if (mcpServer) return mcpServer.status();
  const cfg = loadMcpConfig();
  return { enabled: false, url: '', token: cfg.token || '', approvalMode: cfg.approvalMode === 'approve' ? 'approve' : 'auto' };
}

function askApprovalViaRenderer(req) {
  return new Promise((resolve) => {
    const id = 'ap' + Date.now() + Math.random().toString(36).slice(2, 6);
    const timer = setTimeout(() => {
      const p = mcpApprovals.get(id);
      if (p) { mcpApprovals.delete(id); p.resolve(false); }
      send('mcp:approval:cancel', { id });
    }, 30000);
    mcpApprovals.set(id, { resolve, timer });
    send('mcp:approval:ask', { id, ...req });
  });
}

async function mcpSetEnabled(on) {
  if (on && !mcpServer) {
    mcpServer = new HubTermMcpServer({ listSessions: () => sessions, getApproval: askApprovalViaRenderer });
    try {
      const st = await mcpServer.start();
      send('mcp:status', st);
    } catch (e) {
      mcpServer = null;
      return { error: t('mcp.startFailed', e.message) };
    }
  } else if (!on && mcpServer) {
    await mcpServer.stop();
    mcpServer = null;
  }
  const cfg = loadMcpConfig();
  cfg.enabled = !!on;
  saveMcpConfig(cfg);
  return mcpStatus();
}

ipcMain.handle('mcp:status', () => mcpStatus());
ipcMain.handle('mcp:set-enabled', (e, on) => mcpSetEnabled(!!on));
ipcMain.handle('mcp:set-mode', (e, mode) => {
  if (mcpServer) return mcpServer.setApprovalMode(mode);
  const cfg = loadMcpConfig();
  cfg.approvalMode = mode === 'approve' ? 'approve' : 'auto';
  saveMcpConfig(cfg);
  return mcpStatus();
});
ipcMain.handle('mcp:regen-token', () => {
  if (mcpServer) mcpServer.regenToken();
  else {
    const cfg = loadMcpConfig();
    cfg.token = crypto.randomBytes(24).toString('base64url');
    saveMcpConfig(cfg);
  }
  return mcpStatus();
});
ipcMain.on('mcp:approval:reply', (e, { id, approved }) => {
  const p = mcpApprovals.get(id);
  if (!p) return;
  mcpApprovals.delete(id);
  clearTimeout(p.timer);
  p.resolve(!!approved);
});

/* ================= 启动 ================= */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    try {
    app.setAboutPanelOptions({ applicationName: 'HubTerm', applicationVersion: app.getVersion(), credits: t('main.aboutCredits') });
    try { sessions = loadSessions(); } catch (e) { sessions = []; }
    buildMenu();
    createWindow();
    // MCP：上次开启过则随应用自启（端口被占会自动换并写回配置）
    if (loadMcpConfig().enabled) {
      mcpSetEnabled(true).catch((e) => console.error('MCP 自启失败:', e.message));
    }
    // 自测钩子：--screenshot=<file> 启动后自摄主窗口（绕过系统缩放层）
    const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
    if (shotArg) {
      const file = shotArg.split('=')[1];
      setTimeout(async () => {
        try {
          // 预览指定外观（仅本次运行生效，不写 localStorage）
          const themeArg = process.argv.find((a) => a.startsWith('--theme='));
          if (themeArg) {
            await win.webContents.executeJavaScript(`applyTheme('${themeArg.split('=')[1] === 'light' ? 'light' : 'dark'}')`, true);
            await new Promise((r) => setTimeout(r, 200));
          }
          if (process.argv.includes('--open-help')) {
            await win.webContents.executeJavaScript("document.querySelector('#btn-help').click()", true);
            await new Promise((r) => setTimeout(r, 600));
          }
          if (process.argv.includes('--open-edit')) {
            await win.webContents.executeJavaScript(
              "const list = (typeof sessions !== 'undefined' ? sessions : []); const s = list.find(x => x.rules && x.rules.length) || list[0] || null; showEdit(s);", true);
            await new Promise((r) => setTimeout(r, 600));
          }
          // 通用驱动：--eval=<js> 在截图前执行渲染层表达式（如 window.hub.adhoc 连本地 mock 验证终端主题）
          const evalArg = process.argv.find((a) => a.startsWith('--eval='));
          if (evalArg) {
            await win.webContents.executeJavaScript(decodeURIComponent(evalArg.split('=').slice(1).join('=')), true);
            await new Promise((r) => setTimeout(r, 1200));
          }
          const img = await win.webContents.capturePage();
          require('fs').writeFileSync(file, img.toPNG());
          console.log('[screenshot] saved', file);
        } catch (e) { console.error('[screenshot] failed', e.message); }
        quitFlowDone = true; // 截图自测路径直接退出，不被「退出恢复」弹窗卡住
        app.quit();
      }, 3500);
      return;
    }
    // 启动后静默检查一次更新（仅发现新版本时弹提示；出错不打扰，自测路径已被上方 return 跳过）
    setTimeout(() => doCheckUpdate(false), 8000);
    // 自测钩子：--selftest-edit 直接调 renderer 的 showEdit，抓取编辑弹窗运行时错误
    if (process.argv.includes('--selftest-edit')) {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(
            "try { const list = (typeof sessions !== 'undefined' ? sessions : []); const s = list.find(x => x.rules && x.rules.length) || list[0] || null; showEdit(s); document.querySelector('#edit-modal').classList.contains('hidden') ? 'STILL_HIDDEN' : 'OPENED; 弹窗 scrollHeight=' + (function(){ const mm = document.querySelector('#edit-modal .modal'); return mm.scrollHeight + '/' + mm.clientHeight + ' overflowY=' + getComputedStyle(mm).overflowY + ' maxH=' + getComputedStyle(mm).maxHeight; })(); } catch (err) { 'THREW: ' + err.message + ' STACK: ' + String(err.stack).split('\\n').slice(0,4).join(' | '); }",
            true
          )
          .then(async (r) => {
            await new Promise((res) => setTimeout(res, 400));
            try { const img = await win.webContents.capturePage(); require('fs').writeFileSync('/tmp/hubterm-edit-shot.png', img.toPNG()); } catch (e) {}
            require('fs').writeFileSync('/tmp/hubterm-selftest-edit.txt', 'RESULT: ' + r);
          })
          .catch((e) => require('fs').writeFileSync('/tmp/hubterm-selftest-edit.txt', 'ERROR: ' + (e && e.message)));
      }, 2500);
    }
    } catch (bootErr) { console.error('启动异常:', bootErr); }
  });
  app.on('window-all-closed', () => app.quit());
}
