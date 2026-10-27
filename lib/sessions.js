'use strict';
// 会话数据层：sessions.json 为权威存储（支持任意配置字段）。
// 兼容：首次无 JSON 时从旧 hosts.tsv + secrets.b64 导入；
// 保存时双写 hosts.tsv（前9列）+ secrets.b64，保持 login.exp 等 CLI 兜底可用。
const fs = require('fs');
const path = require('path');
const os = require('os');

// HUBTERM_HOME：测试/CI 隔离数据目录（默认 ~/.hubterm）
const DATA_DIR = process.env.HUBTERM_HOME ? path.resolve(process.env.HUBTERM_HOME) : path.join(os.homedir(), '.hubterm');
const SESSIONS_JSON = path.join(DATA_DIR, 'sessions.json');
const HOSTS_TSV = path.join(DATA_DIR, 'hosts.tsv');
const SECRETS = path.join(DATA_DIR, 'secrets.b64');

const DEFAULTS = {
  key: '', name: '', type: 'direct', host: '', port: 22, user: '', target: '', tuser: '',
  group: '', post: '', password: '',
  // 高级选项（空 = 用全局默认）
  emulation: '',        // xterm-256color | xterm | vt100 | linux | ansi
  scrollback: 0,        // 0=默认10000
  fontOverride: 0,      // 0=跟随全局
  colorScheme: '',      // '' = Catppuccin Mocha | dracula | solarized | classic
  cursor: '',           // '' = block | bar | underline
  cursorBlink: '',      // '' | '1' | '0'
  autoReconnect: 0,     // 0=关
  keepalive: 0,         // 0=默认15s；-1=关
  logMode: '',          // '' 跟随全局 | on | off
  rules: [],            // 自定义自动登录规则 [{expect,send,enter,hide}]，空=内置流程
  auth: 'password',     // password | key | agent
  keyPath: '',          // 私钥路径（auth=key）
  keyPass: '',          // 私钥口令（auth=key）
};

// 可选密码加解密钩子（主进程注入 safeStorage；测试/CLI 不注入则明文）
let codec = null; // {encrypt(str)->str, decrypt(str)->str}，带 null 检查
function setCodec(c) { codec = c; }
let legacyTSV = true; // 双写旧 TSV（login.exp CLI 兜底）；开源分发默认可关
function setLegacyTSV(v) { legacyTSV = !!v; }
const ENC_PREFIX = 'hubenc:';

function encPass(p) {
  if (!p || !codec) return p || '';
  try { return ENC_PREFIX + codec.encrypt(p); } catch (e) { return p; }
}
function decPass(p) {
  if (!p || !p.startsWith(ENC_PREFIX) || !codec) return p || '';
  try { return codec.decrypt(p.slice(ENC_PREFIX.length)) ?? ''; } catch (e) { return ''; }
}

function normalize(s) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  }
  if (!out.key || !out.host) return null;
  out.name = out.name || out.key.split('/').pop() || ''; // 名称缺失时从 key 派生
  out.port = parseInt(out.port, 10) || 22;
  // 类型体系：只有 ssh（旧 bastion/direct/raw/local 读取时全部归并为 ssh）
  out.type = 'ssh';
  out.auth = ['password', 'key', 'agent'].includes(out.auth) ? out.auth : 'password';
  out.rules = Array.isArray(out.rules)
    ? out.rules
        .map((r) => ({
          expect: String(r?.expect ?? ''),
          send: String(r?.send ?? ''),
          enter: r?.enter === '0' || r?.enter === 0 ? '0' : '1',
          hide: r?.hide === '1' || r?.hide === 1 ? '1' : '0',
        }))
        .filter((r) => r.expect || r.send)
    : [];
  return out;
}

function loadFromLegacy() {
  if (!fs.existsSync(HOSTS_TSV)) return [];
  const secrets = {};
  try {
    for (const line of fs.readFileSync(SECRETS, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) secrets[line.slice(0, i)] = Buffer.from(line.slice(i + 1).trim(), 'base64').toString('utf8');
    }
  } catch (e) { /* 无密码文件 */ }
  const list = [];
  for (const line of fs.readFileSync(HOSTS_TSV, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [key, type, host, port, user, target, tuser, group, post] = line.split('\t');
    const s = normalize({ key, type, host, port, user, target, tuser, group, post, password: secrets[key] || '' });
    if (s) list.push(s);
  }
  return list;
}

function loadSessions() {
  if (fs.existsSync(SESSIONS_JSON)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
      return (Array.isArray(raw) ? raw : [])
        .map((s) => (s && typeof s.password === 'string' && s.password.startsWith(ENC_PREFIX)
          ? { ...s, password: decPass(s.password) } : s))
        .map(normalize).filter(Boolean);
    } catch (e) {
      // JSON 损坏时回退旧格式，避免数据丢失
    }
  }
  const legacy = loadFromLegacy();
  if (legacy.length) saveSessions(legacy); // 立即迁移
  return legacy;
}

function saveSessions(sessions) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const list = sessions.map(normalize).filter(Boolean);
  // JSON：密码加密存储（有 codec 时）
  const stored = list.map((s) => ({ ...s, password: encPass(s.password) }));
  const tmp = SESSIONS_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_JSON);
  // 旧格式双写（CLI 兜底；开源分发或安全要求下可关闭）
  if (legacyTSV) {
    fs.writeFileSync(
      HOSTS_TSV,
      list.map((s) => [s.key, s.type, s.host, s.port, s.user, s.target, s.tuser, s.group, s.post].join('\t')).join('\n') + '\n',
      { mode: 0o600 }
    );
    fs.writeFileSync(
      SECRETS,
      list.map((s) => `${s.key}:${Buffer.from(s.password || '', 'utf8').toString('base64')}`).join('\n') + '\n',
      { mode: 0o600 }
    );
  } else {
    try { fs.unlinkSync(HOSTS_TSV); fs.unlinkSync(SECRETS); } catch (e) { /* 不存在则忽略 */ }
  }
}

// 给渲染进程的版本（剥离密码）
function publicSessions(sessions) {
  return sessions.map(({ password, ...rest }) => rest);
}

module.exports = { DATA_DIR, loadSessions, saveSessions, publicSessions, setCodec, setLegacyTSV };
