# HubTerm MCP Server 设计稿

> 状态：**v3.0 已实现**（`lib/mcp.js` + 设置面板 + 审批弹窗 + `test/mcp.test.js`）。
> 已落地：§2-§6 全部、§5 审批模式（含 30s 自动拒绝）。待后续：Agent 会话终端投屏、SFTP 工具（read/write/tail）、stdio shim。

## 1. 定位

把 HubTerm 的连接能力（主机清单、凭据、堡垒机、sudo）通过本地 MCP server 暴露给
AI Agent（Claude Code / ZCode / Cursor 等）。Agent 得到的是"在名为 X 的连接上执行命令"
的结构化能力，而不是一个无法处理 MFA / 菜单应答的裸 `ssh` 子进程。

HubTerm 的差异化：**Agent 在服务器上干活，人全程看得见、可审批。**

## 2. 架构

- MCP server 跑在 Electron 主进程内，streamable HTTP 传输，只绑 `127.0.0.1`。
- 随机端口 + 随机 token（首次开启时生成，持久化到 `~/.hubterm/mcp.json`）。
- Agent 侧配置形如 `http://127.0.0.1:<port>/mcp`，请求头带 `Authorization: Bearer <token>`。
- **v1 不做 stdio shim**（`hubterm mcp` 子命令转发到常驻实例）。主流 Agent 都支持
  HTTP 型 MCP，stdio 是锦上添花，等有真实需求再加。

```
Agent ──HTTP──> HubTerm 主进程 MCP server ──> lib/connect.js SshSession（复用现有引擎）
                        │
                        └──ipc──> 渲染层（审批弹窗 / Agent 会话终端 tab 可见）
```

不引入 `@modelcontextprotocol/sdk` 也可以做（协议就 initialize / tools/list /
tools/call 三个 JSON-RPC 方法），但倾向直接用官方 SDK 省掉协议细节维护。

## 3. 工具集

### v1（最小可用）

| 工具 | 入参 | 返回 |
|---|---|---|
| `hubterm_list_hosts` | `group?` | 主机数组：name / host / user / group / automatable |
| `hubterm_exec` | `host`, `command`, `timeout_ms?`（默认 30s，上限 300s） | `{ stdout, stderr, exitCode, durationMs }` |

### v1.5（后续）

- `hubterm_read_file(host, path, maxBytes)` / `hubterm_write_file(host, path, content)` —— 复用 SFTP。
- `hubterm_tail(host, path, lines)` —— 日志场景高频。

## 4. exec 语义

- 走 ssh2 的 **`exec()` 单命令通道**，不复用交互式 shell tab：Agent 要的是干净输出 +
  退出码，PTY 回显对它是噪音。
- 输出超限（如 256KB）截断并在返回里标注 `truncated: true`。
- 连接按 host 名解析到现有会话库；执行完断开（每次短连接，v1 不做连接池）。
- **自动化边界**：需要 MFA / 菜单应答 / 交互输密码的连接，`list_hosts` 里标
  `automatable: false`，`exec` 对其直接返回明确错误。不做特例补丁，等真实需求再设计。

## 5. 安全模型

1. **默认关闭**，设置里显式开启（标准设置行 + 可见开关，遵循"状态切换必须有可见按钮入口"）。
2. 只绑 127.0.0.1，随机端口，随机 token。
3. `hubterm_exec` 每次写审计日志（`~/.hubterm/mcp-audit.log`：时间 / 工具 / host / 命令 / 结果码）。
4. **审批模式**（差异化卖点，**已实现**）：
   - 模式 A `auto`：直接执行（默认）。
   - 模式 B `approve`：Agent 调 exec → 主进程弹审批弹窗（host + 命令 + 超时）→
     用户批准/拒绝；30s 无响应视为拒绝。
   - 待后续：Agent 的执行以只读方式投到一个可见的"Agent 会话"终端 tab，
     用户全程可看（对齐"慢操作要有内容区 loading"的原则）。

## 6. 设置 UI

设置面板新增"MCP 服务（AI Agent 接入）"区块：

```
状态      ● 已开启（端口 47632）        [开启/关闭]
访问地址  http://127.0.0.1:47632/mcp   [复制]
Token     ••••••••                      [显示/复制]
审批模式  自动执行 / 每次询问            （单选）
```

开启时弹一次说明：Agent 将能在此设备已保存凭据的免交互连接上执行命令。

## 7. Agent 接入示例

Claude Code / ZCode（`~/.claude.json` 或对应 MCP 配置）：

```json
{
  "mcpServers": {
    "hubterm": {
      "url": "http://127.0.0.1:47632/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

跨平台注记：Windows 上若 Agent 跑在 WSL2 内，连宿主机需镜像网络模式（wslconfig
`networkingMode=mirrored`）或改用宿主机 IP；macOS / 原生 Windows 无此问题。

## 8. 测试策略

- 复用 `lib/mockserver.js` + automaton 测试模式：起 mock server，MCP 层直连
  `SshSession` 跑 `hubterm_exec`，断言 stdout / exitCode / 截断 / 超时 / 不可自动化拒绝。
- 协议层测试：initialize 握手、token 错误 401、工具列表。

## 9. 分期

| 阶段 | 内容 |
|---|---|
| v3.0 | 主进程 MCP server + `list_hosts` / `exec` + 设置 UI + 审计日志 |
| v3.x | 审批模式、Agent 会话终端投屏、SFTP 工具（read/write/tail） |
| 之后 | 按真实需求评估 stdio shim、连接池 |
