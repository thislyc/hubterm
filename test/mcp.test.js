'use strict';
// MCP server 集成测试：协议握手 / token 鉴权 / list_hosts / exec（成功·退出码·超时·截断）/ 审批拒绝 / 不可自动化
// 数据目录用 HUBTERM_HOME 隔离（不碰真实 ~/.hubterm）
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.HUBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hubterm-mcp-test-'));

const { startMockServer, MOCK_PW } = require('../lib/mockserver');
const { HubTermMcpServer, saveMcpConfig, isAutomatable } = require('../lib/mcp');

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

const SESSIONS = [
  { key: '生产/web-1', name: 'web-1', type: 'ssh', host: '127.0.0.1', port: 2221, user: 'mockuser', password: MOCK_PW, group: '生产', auth: 'password', rules: [] },
  { key: '生产/bastion', name: 'bastion', type: 'ssh', host: '127.0.0.1', port: 2221, user: 'mockuser', password: MOCK_PW, group: '生产', auth: 'password', rules: [{ expect: 'Opt>', send: '1' }] },
  { key: '其他/nopass', name: 'nopass', type: 'ssh', host: '127.0.0.1', port: 2221, user: 'mockuser', password: '', group: '其他' },
];

let token = '';
// 响应可能是 JSON 或 SSE（SDK 按 Accept 头选择，真实客户端两种都能处理）
async function readRpc(res) {
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (ct.includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
    }
    throw new Error('SSE 响应无 data 行: ' + raw.slice(0, 200));
  }
  return JSON.parse(raw);
}
async function rpc(method, params) {
  const res = await fetch('http://127.0.0.1:PORT/mcp'.replace('PORT', String(rpc.port)), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res;
}
async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const j = await readRpc(res);
  if (j.error) return { rpcError: j.error.message };
  const item = { isError: j.result.isError === true, text: j.result.content[0].text };
  try { item.json = JSON.parse(item.text); } catch (e) { /* 文本型错误 */ }
  return item;
}

(async () => {
  await startMockServer('direct', 2221);

  // 判定函数单测
  ok('isAutomatable: 有密码无规则 = true', isAutomatable(SESSIONS[0]) === true);
  ok('isAutomatable: 有规则(堡垒机菜单) = false', isAutomatable(SESSIONS[1]) === false);
  ok('isAutomatable: 无凭据 = false', isAutomatable(SESSIONS[2]) === false);

  const server = new HubTermMcpServer({ listSessions: () => SESSIONS });
  const st = await server.start();
  rpc.port = Number(st.url.match(/:(\d+)\//)[1]);
  token = st.token;
  ok('启动: 只绑 127.0.0.1 且分配端口/token', st.url.startsWith('http://127.0.0.1:') && !!st.token, st.url);

  // 1. 未带 token -> 401
  {
    const saved = token;
    token = '';
    const res = await rpc('tools/list', {});
    token = saved;
    ok('鉴权: 无 token 请求返回 401', res.status === 401);
  }

  // 2. initialize 握手
  {
    const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const j = await readRpc(res);
    ok('握手: initialize 返回 hubterm serverInfo', j.result && j.result.serverInfo && j.result.serverInfo.name === 'hubterm', JSON.stringify(j.result && j.result.serverInfo));
  }

  // 3. tools/list
  {
    const res = await rpc('tools/list', {});
    const j = await readRpc(res);
    const names = (j.result.tools || []).map((t) => t.name);
    ok('工具: tools/list 含 hubterm_list_hosts + hubterm_exec', names.includes('hubterm_list_hosts') && names.includes('hubterm_exec'), names.join(','));
  }

  // 4. list_hosts
  {
    const r = await callTool('hubterm_list_hosts', {});
    const byName = Object.fromEntries(r.json.hosts.map((h) => [h.name, h]));
    ok('list_hosts: automatable 标记正确', r.json.total === 3 && byName['生产/web-1'].automatable === true && byName['生产/bastion'].automatable === false, JSON.stringify(r.json));
    const r2 = await callTool('hubterm_list_hosts', { group: '生产' });
    ok('list_hosts: 分组过滤', r2.json.total === 2);
  }

  // 5. exec 成功 + 退出码
  {
    const r = await callTool('hubterm_exec', { host: '生产/web-1', command: 'echo hello' });
    ok('exec: echo -> stdout + exitCode 0', !r.isError && r.json.stdout === 'hello\n' && r.json.exitCode === 0, JSON.stringify(r.json));
  }
  {
    const r = await callTool('hubterm_exec', { host: 'web-1', command: 'errfail' });
    ok('exec: errfail -> stderr + exitCode 3', !r.isError && r.json.stderr === 'boom\n' && r.json.exitCode === 3, JSON.stringify(r.json));
  }

  // 6. 截断
  {
    const r = await callTool('hubterm_exec', { host: '生产/web-1', command: 'bigout' });
    ok('exec: 304KiB 输出截断到 256KiB', !r.isError && r.json.truncated === true && Buffer.byteLength(r.json.stdout) === 256 * 1024, `stdout=${Buffer.byteLength(r.json.stdout || '')}B`);
  }

  // 7. 超时
  {
    const t0 = Date.now();
    const r = await callTool('hubterm_exec', { host: '生产/web-1', command: 'sleepms 6000', timeout_ms: 1500 });
    ok('exec: 超时终止并报错', r.isError && /超时|秒未完成|已终止/.test(r.text), `${r.text} (${Date.now() - t0}ms)`);
  }

  // 8. 不可自动化会话
  {
    const r = await callTool('hubterm_exec', { host: '生产/bastion', command: 'echo hi' });
    ok('exec: 有规则的会话明确拒绝', r.isError && /暂不支持 Agent 执行/.test(r.text), r.text);
  }

  // 9. 不存在的会话
  {
    const r = await callTool('hubterm_exec', { host: '不存在', command: 'echo hi' });
    ok('exec: 未知会话报错', r.isError && /会话不存在/.test(r.text), r.text);
  }

  // 10. 审批模式：拒绝
  {
    saveMcpConfig({ ...(server.status()), approvalMode: 'approve' });
    const approveServer = new HubTermMcpServer({ listSessions: () => SESSIONS, getApproval: async () => false });
    const st2 = await approveServer.start();
    const port2 = Number(st2.url.match(/:(\d+)\//)[1]);
    const savedPort = rpc.port;
    rpc.port = port2;
    const savedToken = token;
    token = st2.token;
    const r = await callTool('hubterm_exec', { host: '生产/web-1', command: 'echo hi' });
    ok('审批: 用户拒绝 -> 命令不执行', r.isError && /用户拒绝了本次执行/.test(r.text), r.text);
    rpc.port = savedPort;
    token = savedToken;
    await approveServer.stop();
  }

  // 11. 审计日志
  {
    const lines = fs.readFileSync(path.join(process.env.HUBTERM_HOME, 'mcp-audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const execEntries = lines.filter((l) => l.tool === 'exec');
    ok('审计: 每次执行都有日志（含 denied/not-automatable/exitCode）',
      execEntries.some((l) => l.result === 'ok' && typeof l.exitCode === 'number') &&
      execEntries.some((l) => l.result === 'not-automatable') &&
      execEntries.some((l) => l.result === 'denied'),
      `${lines.length} 行`);
  }

  await server.stop();
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
