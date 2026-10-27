'use strict';
// MCP server：把 HubTerm 的连接能力（主机清单、凭据）暴露给本地 AI Agent
// （Claude Code / ZCode / Cursor 等）。设计与安全模型见 docs/mcp-design.md：
// - 默认关闭；开启后只绑 127.0.0.1，随机端口 + Bearer token 鉴权
// - hubterm_exec 走 ssh2 exec() 单命令通道（无 PTY），stdout/stderr 各截断 256KB
// - 仅「有凭据且登录流程无交互应答」的会话可执行（automatable）；每次执行写审计日志
// - 审批模式（approve）：执行前经 getApproval 钩子征得用户同意
// 本模块不依赖 Electron（可在 node 测试中直接实例化）。

const http = require('http');
const crypto = require('crypto');
const i18n = require('./i18n');
const t = i18n.t;
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const { SshSession } = require('./connect');
const { DATA_DIR } = require('./sessions');
const store = require('./store');

let APP_VERSION = '0';
try { APP_VERSION = require('../package.json').version; } catch (e) { /* 打包外运行兜底 */ }

const CONFIG_FILE = path.join(DATA_DIR, 'mcp.json');
const AUDIT_FILE = path.join(DATA_DIR, 'mcp-audit.log');
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const MAX_EXEC_TIMEOUT_MS = 300000;
const CORS = { 'Access-Control-Allow-Origin': '*' };

/* ---------- 配置 / 审计 ---------- */
function loadMcpConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMcpConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}
function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { /* 审计写失败不阻断执行 */ }
}

/* ---------- 会话可自动化判定 ---------- */
/** 可被 Agent 自动执行：有凭据，且登录流程无交互应答（有规则 = 堡垒机菜单/MFA 类） */
function isAutomatable(s) {
  if (Array.isArray(s.rules) && s.rules.length) return false;
  if (s.auth === 'key') return !!s.keyPath;
  if (s.auth === 'agent') return true;
  return !!s.password;
}

/** known_hosts 校验（无弹窗版）：首次记住（accept-new），指纹变更直接拒绝执行 */
function verifyHostSilent(host, port, fp) {
  const known = store.listKnownHosts();
  const k = `${host}:${port}`;
  if (!known[k]) {
    known[k] = fp;
    store.saveKnownHosts(known);
    return true;
  }
  return known[k] === fp; // 变更 = 可能中间人：Agent 场景拒绝执行，由用户先在 UI 里连接确认
}

function execOnce(cfg, command, timeoutMs) {
  const clamped = Math.min(Math.max(timeoutMs, 1000), MAX_EXEC_TIMEOUT_MS);
  const s = new SshSession({ ...cfg, verifyHost: (fp) => verifyHostSilent(cfg.host, cfg.port, fp) });
  return s.runExec(command, clamped);
}

/* ---------- 工具返回值 ---------- */
function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errText(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    req.on('data', (b) => bufs.push(b));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(bufs).toString('utf8'))); }
      catch (e) { reject(new Error(t('mcp.badJson'))); }
    });
    req.on('error', reject);
  });
}

class HubTermMcpServer {
  /**
   * @param opts {{ listSessions: () => object[], getApproval?: (req: {host,key,command,timeoutMs}) => Promise<boolean> }}
   * listSessions 返回完整会话配置（含凭据，供引擎连接用，绝不进日志/工具返回）。
   * getApproval 在审批模式（approvalMode=approve）下被调用，false/超时 = 拒绝。
   */
  constructor(opts) {
    this.opts = opts || {};
    this.http = null;
    this.config = null;
  }

  get url() {
    if (!this.config || !this.config.port) return '';
    return `http://127.0.0.1:${this.config.port}/mcp`;
  }

  status() {
    const cfg = this.config || loadMcpConfig();
    return {
      enabled: !!this.http,
      url: this.url,
      token: cfg.token || '',
      approvalMode: cfg.approvalMode === 'approve' ? 'approve' : 'auto',
    };
  }

  async start() {
    if (this.http) return this.status();
    this.config = loadMcpConfig();
    if (!this.config.token) this.config.token = crypto.randomBytes(24).toString('base64url');
    if (this.config.approvalMode !== 'approve') this.config.approvalMode = 'auto';
    const srv = await new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          try {
            res.writeHead(500, { ...CORS, 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          } catch (e2) { /* 响应已发出 */ }
        });
      });
      s.on('error', reject);
      // 配置端口被占时回退随机端口（listen(0)），地址以实际监听为准
      s.listen(Number(this.config.port) || 0, '127.0.0.1', () => resolve(s));
    });
    this.http = srv;
    this.config.port = srv.address().port;
    saveMcpConfig(this.config);
    return this.status();
  }

  async stop() {
    if (!this.http) return this.status();
    const srv = this.http;
    this.http = null;
    if (srv.closeAllConnections) srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    return this.status();
  }

  setApprovalMode(mode) {
    const cfg = loadMcpConfig();
    cfg.approvalMode = mode === 'approve' ? 'approve' : 'auto';
    saveMcpConfig(cfg);
    if (this.config) this.config.approvalMode = cfg.approvalMode;
    return this.status();
  }

  regenToken() {
    const cfg = loadMcpConfig();
    cfg.token = crypto.randomBytes(24).toString('base64url');
    saveMcpConfig(cfg);
    if (this.config) this.config.token = cfg.token;
    return cfg.token;
  }

  async handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    const auth = req.headers.authorization || '';
    if (!this.config || auth !== 'Bearer ' + this.config.token) {
      res.writeHead(401, { ...CORS, 'WWW-Authenticate': 'Bearer', 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: t('mcp.unauthorized') } }));
    }
    const pathname = (req.url || '').split('?')[0];
    if (req.method !== 'POST' || !pathname.endsWith('/mcp')) {
      res.writeHead(404, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: t('mcp.notFound') }));
    }
    const body = await readBody(req);
    // 无会话（stateless）模式：每个请求独立 server + transport，用完即弃（SDK 官方推荐用法）
    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      try { transport.close(); server.close(); } catch (e) { /* 已关闭 */ }
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  buildServer() {
    const server = new McpServer({ name: 'hubterm', version: APP_VERSION });
    server.registerTool('hubterm_list_hosts', {
      title: t('mcp.listTitle'),
      description:
        t('mcp.listDesc'),
      inputSchema: {
        group: z.string().optional().describe(t('mcp.listGroupFilter')),
      },
    }, async ({ group }) => {
      const hosts = this.opts
        .listSessions()
        .filter((s) => !group || (s.group || '').startsWith(group))
        .map((s) => ({
          name: s.key,
          display_name: s.name,
          host: s.host,
          user: s.user,
          group: s.group || '',
          automatable: isAutomatable(s),
        }));
      audit({ tool: 'list_hosts', result: 'ok', count: hosts.length });
      return text({ total: hosts.length, hosts });
    });

    server.registerTool('hubterm_exec', {
      title: t('mcp.execTitle'),
      description:
        t('mcp.execDesc'),
      inputSchema: {
        host: z.string().describe(t('mcp.execHostDesc')),
        command: z.string().describe(t('mcp.execCmdDesc')),
        timeout_ms: z.number().int().min(1000).max(MAX_EXEC_TIMEOUT_MS).optional().describe(t('mcp.execTimeoutDesc')),
      },
    }, (args) => this.toolExec(args));
    return server;
  }

  async toolExec({ host, command, timeout_ms }) {
    const cfg = this.opts.listSessions().find((s) => s.key === host || s.name === host);
    if (!cfg) return errText(t('mcp.execNoHost', host));
    if (!isAutomatable(cfg)) {
      audit({ tool: 'exec', host: cfg.key, command, result: 'not-automatable' });
      return errText(t('mcp.execInteractive', cfg.name));
    }
    if (loadMcpConfig().approvalMode === 'approve') {
      const approved = this.opts.getApproval
        ? await this.opts.getApproval({ host: cfg.name, key: cfg.key, command, timeoutMs: timeout_ms || DEFAULT_EXEC_TIMEOUT_MS })
        : true;
      if (!approved) {
        audit({ tool: 'exec', host: cfg.key, command, result: 'denied' });
        return errText(t('mcp.execDenied'));
      }
    }
    const t0 = Date.now();
    try {
      const r = await execOnce(cfg, command, timeout_ms || DEFAULT_EXEC_TIMEOUT_MS);
      const durationMs = Date.now() - t0;
      audit({ tool: 'exec', host: cfg.key, command, result: 'ok', exitCode: r.exitCode, durationMs });
      return text({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, truncated: r.truncated, durationMs });
    } catch (e) {
      audit({ tool: 'exec', host: cfg.key, command, result: 'failed', error: e.message, durationMs: Date.now() - t0 });
      return errText(t('mcp.execFailed', e.message));
    }
  }
}

module.exports = { HubTermMcpServer, loadMcpConfig, saveMcpConfig, isAutomatable };
