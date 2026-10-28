# Contributing

感谢关注 HubTerm！欢迎 Issue 与 PR。

Thanks for your interest! Issues and PRs are welcome.

## Setup / 环境准备

```bash
npm install
npm test
npm start        # dev run / 开发运行
npm run package  # build & install release build / 构建并安装（跟随本机架构）
```

If `npm install` is blocked or slow, the committed lockfile already resolves
against the npmmirror registry (a global CDN). You can still override:

如果安装慢或被墙，仓库锁文件本身已指向 npmmirror（全球可用 CDN）；
也可以自行覆盖：

```bash
npm install --registry=https://registry.npmjs.org
```

## Rules / 规则

1. **All engine changes need tests.** Connection logic lives in `lib/connect.js`
   and is tested against a mock SSH server (`lib/mockserver.js`, no network
   needed). ZMODEM is tested against real `lrzsz` binaries.
   所有引擎改动必须带测试。连接逻辑对着 mock SSH 服务器测试（无需网络），
   ZMODEM 对着真实 lrzsz 二进制测试。
2. **Never break the watcher principle**: user keystrokes always pass through to
   the remote; automation only reacts to recognized prompts. Anything
   unrecognized must degrade to manual typing, never block the terminal.
   不要破坏「监视器」原则：用户击键永远直通远端；自动化只应答已识别的提示，
   未识别的一律停手交还键盘。
3. **Passwords never appear in code, logs, or test output.**
   密码不出现在代码、日志或测试输出里。
4. Run `npm test` before committing. / 提交前跑 `npm test`。
5. Releasing is a local one-command flow (`npm run release`): build all three
   targets, then create a GitHub Release and upload the artifacts.
   发版是本地一条命令流程（`npm run release`）：构建三平台后创建 Release 并上传产物。

## Layout

- `lib/connect.js` — SSH engine (auth, bastion automaton, rules, jump, host-key verify)
- `lib/sessions.js` — session store (sessions.json, codec hooks for safeStorage)
- `lib/store.js` — snippets / forwards / known_hosts / backup
- `lib/sshconfig.js` — ~/.ssh/config importer
- `lib/mcp.js` — MCP server for AI agents (list hosts / exec, audit, approval)
- `lib/updater.js` — update check against GitHub Releases
- `lib/i18n.js` — zh-CN / en UI dictionary (main & renderer)
- `lib/mockserver.js` — mock SSH server for tests
- `main.js` — Electron main: window, session lifecycle, ZMODEM, SFTP, port-forward engine, updater & menus
- `renderer/` — UI (no framework; plain JS + CSS)
- `website/` — landing page (single static file)

## License

MIT — see LICENSE.
