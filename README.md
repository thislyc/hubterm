<div align="center">

[English](README.md) | **中文**

***

<img src="assets/icon-512.png" width="96" alt="HubTerm icon" />

# HubTerm

**One-click SSH through any bastion host.**

A modern, open-source SecureCRT alternative: session tree, menu-driven bastion
automation, ZMODEM, SFTP, port forwarding — and an MCP server so your AI agents
can safely run commands on your hosts.

[![Release](https://img.shields.io/github/v/release/thislyc/hubterm)](https://github.com/thislyc/hubterm/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/thislyc/hubterm/total)](https://github.com/thislyc/hubterm/releases/latest)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)
[![Website](https://img.shields.io/badge/docs-website-89b4fa)](website/index.html)

<img src="assets/screenshot-main.png" width="800" alt="HubTerm main window" />

</div>

## Why HubTerm

Most SSH clients assume `ssh user@host`. In most companies (especially in
China), reality is: you land on a **menu-driven bastion** (`Opt>`, pick a host,
pick a user), sometimes with MFA on top. SecureCRT solved this twenty years ago
with login scripts — and still charges $99. Termius / Tabby / WindTerm don't
handle menu bastions at all.

HubTerm's automation is a **watcher, not a script**: it watches terminal output,
answers known prompts, and hands control back to you the moment anything
unexpected appears. Menu redesigned? MFA enabled mid-flight? You can always
type — the automation never fights you for the keyboard.

## Highlights

| | |
|---|---|
| 🏰 **Bastion automation** | Per-session expect→send rules (SecureCRT Logon Actions equivalent) — the *only* automation mechanism, fully visible & editable. `$PASSWORD` / `$TARGET` variables, post-login command, MFA dialog, ProxyJump. |
| 🗂 **Session management** | Tree with nested folders & drag-and-drop, fuzzy quick-open (`⌘P`), live status dots, tabs (drag-reorder, batch close, restore), split panes, double-click to connect. |
| 🔑 **Auth & security** | Password / private key (+passphrase) / SSH Agent; passwords encrypted via OS Keychain (Electron safeStorage); known_hosts fingerprint pinning with change warnings. |
| 📦 **File transfer** | ZMODEM rz/sz with progress panel & cancel (lrzsz-compatible patches included); SFTP browser for direct sessions (drag-drop upload, download, rename, delete, cancellable transfers). |
| 🔀 **Port forwarding** | Persisted per session — reach intranet web/DB through your bastion. |
| 🤖 **MCP server for AI agents** | Claude Code / Cursor / ZCode can list your hosts and run commands via local MCP (`127.0.0.1` + token auth, audit log, optional approve-before-run dialog). |
| ⚡ **Ops ergonomics** | Snippets panel with **broadcast** (run one command on every connected pane), terminal search, clickable links, session logging, fast-fail connect (8s timeout, cancellable overlay, auto-reconnect). |
| 🎨 **Themes & languages** | Auto / light / dark following your OS; Catppuccin Mocha & Latte, Solarized Light + per-session terminal schemes that follow the theme live. UI & menus in **English or 中文** — switch anytime in Settings → Language. |
| 🧰 **Migration & backup** | SecureCRT migration restores each session's ORIGINAL Logon Actions as rules; `~/.ssh/config` import; JSON backup export/import. |

## Bastion automation, without the black box

Every automation in HubTerm is a **login rule you wrote**, attached to one
session. Nothing is hardcoded, nothing happens you can't see in the session
editor:

```
Expect: Opt>            Send: 3
Expect: login:          Send: $TARGET
Expect: Password:       Send: $PASSWORD
```

- **`$PASSWORD` / `$TARGET`** — the session's saved password and its target
  user, so the same rule set works across hosts.
- **Post-login command** — `sudo -i`, `tmux attach`, whatever you run next.
- **MFA** — when an MFA prompt is detected, HubTerm pops a dialog and waits for
  *you*. Your code never lives in a config file.
- **Anything unexpected** — automation stops and the terminal is yours.
- **Coming from SecureCRT?** The migration tool decrypts your existing sessions
  and restores each one's ORIGINAL Logon Actions as its HubTerm rules.
- **ProxyJump** — chain through another HubTerm session as a standard SSH jump
  host.

## MCP: let AI agents work on your hosts, with you in the loop

HubTerm ships a built-in MCP server (official SDK, streamable HTTP). Turn it on
in Settings → **AI Agent Access (MCP)**, then point your agent at it:

```json
{
  "mcpServers": {
    "hubterm": {
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

- **`hubterm_list_hosts`** — your session tree with an `automatable` flag.
- **`hubterm_exec`** — run a single command on a session with saved
  credentials: clean stdout/stderr, real exit code, 30s default / 300s max
  timeout, 256KB output truncation.

Safety model, by design:

1. **Off by default**; binds `127.0.0.1` only, random port + Bearer token.
2. Sessions that need MFA or menu answers are marked non-automatable and
   **refuse exec** — no special-casing, ever.
3. Every call is written to `~/.hubterm/mcp-audit.log` (JSONL).
4. **Approval mode**: a dialog shows the target host and command before every
   exec; no response in 30s counts as *deny*.

known_hosts fingerprint change ⇒ exec refused outright.

## Build & install

Grab a prebuilt package from [Releases](https://github.com/thislyc/hubterm/releases/latest)
(macOS arm64/x64, Windows x64), or build from source (Node ≥ 20):

```bash
npm install            # lockfile resolves against the npmmirror registry (global CDN)
npm test               # 80+ offline tests (mock SSH server + real lrzsz + MCP)
npm run package        # macOS app → /Applications (follows host arch)
npm run package:intel  # macOS x64 build for Intel Macs
npm run package:win    # Windows x64 green folder + zip (builds on macOS/Linux too)
```

- **macOS** (arm64 & x64) and **Windows x64** are packaged today; Linux runs
  with the same recipe but isn't packaged yet.
- The whole stack is pure JS (`ssh2` without its optional native accelerator,
  xterm.js, zmodem.js) — no native rebuilds anywhere.
- Windows builds embed icon/version via `rcedit` when `wine` is present, and
  otherwise ship fully working with the default Electron icon. Unsigned
  binaries trigger SmartScreen on first run.

The UI is available in **English and 简体中文**; switch anytime in
Settings → Language（设置 → 语言）. The choice is remembered and applies to
menus, dialogs and terminal prompts.

## Data layout

Everything lives in `~/.hubterm/` — plain JSON, no cloud, no telemetry:

```
~/.hubterm/
├── sessions.json      # sessions, groups, login rules, per-session config
├── snippets.json      # snippets & broadcast sets
├── forwards.json      # port forwarding rules
├── known_hosts.json   # pinned host key fingerprints
├── mcp.json           # MCP server config (port/token), mcp-audit.log (JSONL)
└── logs/              # per-session logs (optional)
```

Passwords are encrypted at rest with the OS Keychain when available. The test
suite runs fully offline and isolates all data via `HUBTERM_HOME=/tmp/xxx`.

## How it compares

| | HubTerm | SecureCRT | Termius | Tabby / WindTerm |
|---|---|---|---|---|
| Menu-driven bastion + MFA | ✅ rules you can read | ✅ login scripts ($99) | ❌ | ❌ |
| Automation is transparent | ✅ per-session rules | ⚠️ opaque scripts | — | — |
| ZMODEM rz/sz | ✅ | ✅ | ❌ | ⚠️ |
| SFTP + port forwarding | ✅ | ✅ | ⚠️ paid tiers | ✅ |
| MCP for AI agents | ✅ built-in, auditable | ❌ | ❌ | ❌ |
| Price | free, MIT | $99+ | subscription | free |

## Roadmap

Done:

- [x] Windows / Intel-mac builds (`npm run package:win` / `package:intel`)
- [x] MCP server for local AI agents (list hosts / exec, audit, approval dialog)
- [x] English / 中文 UI language switch (Settings → Language)
- [x] Update checker: in-app check with release notes and a download shortcut
- [x] One-command release: `npm run release` builds macOS (arm64/x64) + Windows and uploads to GitHub Releases

Next:

- [ ] MCP: SFTP file tools (read/write/tail) + live agent-session terminal view
- [ ] Silent self-update (requires code signing on macOS)
- [ ] Full keyboard remapping
- [ ] Mosh, Telnet, Serial protocols
- [ ] Team sync (self-hosted, commercial edition)

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before
submitting; 80+ offline tests cover the login automation engine, ZMODEM, MCP
and the storage layer against a mock SSH server.

## Commercial

HubTerm is MIT-licensed and individual use stays free. A hosted team edition
(shared vault, sync, RBAC — self-hostable) is the planned commercial path.

## Credits

Built with [Electron](https://electronjs.org), [ssh2](https://github.com/mscdex/ssh2),
[xterm.js](https://xtermjs.org) and [zmodem.js](https://github.com/FGasper/zmodemjs)
(with lrzsz interop patches).
