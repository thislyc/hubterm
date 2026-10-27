# Contributing

## Setup

```bash
npm install
npm test
npm start        # dev run
npm run package  # assemble & install release build (macOS arm64)
```

If `npm install` is blocked, use npmmirror: `npm install --registry=https://registry.npmmirror.com` and `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.

## Rules

1. **All engine changes need tests.** Connection logic lives in `lib/connect.js` and is tested against a mock SSH server (`lib/mockserver.js`, no network needed). ZMODEM is tested against real `lrzsz` binaries.
2. **Never break the watcher principle**: user keystrokes always pass through to the remote; automation only reacts to recognized prompts. Anything unrecognized must degrade to manual typing, never block the terminal.
3. **Passwords never appear in code, logs, or test output.**
4. Run `npm test` before committing. CI runs it on every push.
5. Packaging is manual-assemble (`scripts/assemble.sh`) because electron-packager hits GitHub for checksums; keep that script working.

## Layout

- `lib/connect.js` — SSH engine (auth, bastion automaton, rules, jump, verify)
- `lib/sessions.js` — session store (sessions.json, codec hooks for safeStorage)
- `lib/store.js` — snippets / forwards / known_hosts / backup
- `lib/sshconfig.js` — ~/.ssh/config importer
- `main.js` — Electron main: session lifecycle, ZMODEM, SFTP, port-forward engine, local PTY
- `renderer/` — UI (no framework; plain JS + CSS)

## License

MIT — see LICENSE.
