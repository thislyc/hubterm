# Changelog

## Unreleased — 更新检查 + 官网上线

- **修复认证弹窗被 15 秒握手超时掐断**：ssh2 内置 `readyTimeout` 从连接起一直计时到认证完成，MFA 验证码/键盘交互密码/host key 指纹变更确认三个弹窗只要开着就照计时——用户掏手机看验证码超过 15 秒，连接被销毁、再输入无效，且错误状态不触发自动重连（「输了 MFA 没反应」的根因）。改为引擎自管握手计时：`readyTimeout: 0` 停用内置计时，认证弹窗与 host key 确认未决期间暂停、提交后重新起算；`handshakeTimeoutMs` 可按会话覆盖（测试用），静默服务器兜底能力不变。
- **修复一次断线触发两次自动重连（并行僵尸连接）**：断线时 conn close 与 stream close 接连到达，`disconnected` 状态发两次——上层每次都累加 attempts 并各排一个重连定时器，两条新连接同时连同一主机、输出交错灌进同一终端。引擎侧终态去重只发一次；主进程侧 `wireSession` 换新连接后旧会话的 status/data 事件全部作废（`st.ssh !== s` 守卫），手动重连（⌘R）销毁旧连接引发的 disconnected 同理不再误排自动重连。
- **修复 MFA 判定正则把 `\s` 写成 `\\s`**：`6\s*digits` / `verification\s*code` 实际永远匹配不上，纯英文 "Verification code:" 提示会落进「未知提示先试密码」分支，把登录密码当验证码提交（真实堡垒机有锁号风险）。
- **修复认证弹窗互相顶掉**：MFA 弹窗不排队、直接顶掉正在显示的密码弹窗，被顶会话的 `askPassword` Promise 永远悬空、连接卡死。现在 MFA/密码共用一个弹窗队列依次展示。
- **修复 `st.mfaAsked` 一次置真终身有效**：MFA 会话重连后若发生普通密码错误，会被误报「MFA 验证失败」且不再弹密码重输框；改为每次连接尝试独立判定。
- 测试：automaton 新增 5 项（MFA 慢输入暂停计时 / hostKey 慢确认暂停计时 / 自管握手超时可配置生效 / 断线 disconnected 只发一次 / 纯英文验证码弹窗索码且密码零误交），mockserver 新增 `mfaen` 模式（服务端记录错误提交痕迹）。
- **官网上线**：https://thislyc.github.io/hubterm/ （GitHub Pages，gh-pages 分支，`scripts/deploy-website.sh` 一键同步）。README 徽章与官网入口指向线上地址。
- **截图随语言切换**：英文页配英文界面截图、中文页配中文界面截图（官网与 README 同步产出两套截图；顺带修复一个真 bug——渲染层此前不读 settings.json 保存的语言偏好，重装/换机后会丢）。
- **移除 GitHub Actions**：自动化构建下线（账户计费冻结 + 发版已走本地 `npm run release` 管线），删除 ci.yml；账单问题解决后可随时恢复。
- **更新检查**：HubTerm 菜单新增「检查更新…」，启动后也会静默检查一次（仅发现新版本时弹窗：附更新日志与「前往下载」直达 Releases；出错不打扰）。采用「检测 + 引导下载」而非静默自替换——macOS 的 Squirrel 自更新强制要求正式签名（当前 ad-hoc 签名），签名落地后再评估静默通道。测试：`test/updater.test.js` 12 项（版本比较 / 新版本·最新·出错三种结局 / 坏响应归一），共 90+ 断言。
- **官网**：Hero 手绘终端 mockup 换为真实主界面截图——原 mockup 的「« 自动应答 »」标注与手敲 ssh 入口在产品中并不存在（规则静默应答、连接走会话树），易误导访客；构建区改为首次启动欢迎页截图；Hero 主按钮直指 Releases 下载。

## 2.8.0 (2026-10-28) — 中英双语（i18n）+ MCP（AI Agent 接入）+ 跨平台 + 发布管线

- **中英双语全量支持**：新增 `lib/i18n.js`（UMD 字典，主进程/渲染层共用，`zh-CN` / `en` 双语 450+ 条）。应用内：设置 → 偏好 → 「语言 / Language」下拉即时切换，界面、菜单、对话框、错误与状态提示、MCP 工具描述全部随语言切换；选择持久化（渲染层 localStorage + 主进程 settings.json），默认跟随系统语言；主进程收到切换后即时重建应用菜单。README 拆分为 `README.md`（英文）+ `README.zh-CN.md`（中文），顶部互链切换；官网落地页 `website/index.html` 内置 中/EN 切换按钮（导航栏右侧），支持 `?lang=` 参数与 localStorage 记忆，默认跟随浏览器语言；标题、meta 描述、终端演示动画同步翻译。
- **发布管线去 Actions 化**：`scripts/release.sh`（`npm run release`）本地构建 macOS arm64/x64 + Windows x64 并直传 GitHub Releases（直连失败自动回退 Clash 代理）；本机 pre-push 钩子使「推 v* tag」即自动构建上传。GitHub Actions workflow（ci.yml）保留但手动停用（账户付款授权失败导致计量服务被暂停，公开仓库或解冻账户后可重新启用）。仓库身份统一为 `thislyc <thislyc@qq.com>`。
- **主界面截图**：演示数据自摄（`--screenshot` + `--eval` 钩子连本地演示 SSH 服务器：虚构主机名 + TEST-NET 文档 IP），不携带任何真实内网/账号信息。
- **官网落地页**：`website/index.html` 单文件纯静态页（无依赖、深色主题对齐应用外观），含特性总览、堡垒机自动化说明、MCP 安全模型、横向对比表与构建指引；发布渠道待定（GitHub Pages / Vercel 均可直接部署）。
- **仓库**：GitHub 仓库 `thislyc/hubterm`（先私有），`package.json` repository 字段同步更新；README 全面重写（能力总览表、登录规则示例、MCP 接入配置、横向对比、FAQ 式说明）。
- **MCP server：本地 AI Agent（Claude Code / Cursor / ZCode 等）可直连 HubTerm 执行运维命令**（`lib/mcp.js`，官方 MCP SDK streamable HTTP）。默认关闭；开启后只绑 `127.0.0.1`（随机端口 + Bearer token，端口被占自动换），设置 → 偏好新增「AI Agent 接入（MCP）」区块：开启开关、接入地址/Token 复制、Token 显隐与重置、执行审批模式。两个工具：`hubterm_list_hosts`（含 automatable 标记）、`hubterm_exec`（单命令、无 PTY、默认 30s/上限 300s 超时、stdout/stderr 各 256KB 截断、返回 exitCode）。仅「已保存凭据且登录无交互规则」的会话可执行（堡垒机菜单/MFA 会话明确拒绝，不做特例）；known_hosts 指纹变更直接拒绝执行。每次调用写 `~/.hubterm/mcp-audit.log`（JSONL）。**审批模式**：Agent 执行前弹窗显示目标主机与命令，30 秒无响应自动拒绝。引擎侧 `SshSession.runExec()` 复用现有认证/拨号逻辑新开 exec 通道，与交互 shell 流程互不影响。
- **跨平台：Intel macOS（x64）构建**——`assemble.sh` 支持 arch 参数（缺省跟随本机），Electron zip 缓存缺失时自动从镜像下载，版本号从 node_modules 推导不再硬编码；`npm run package:intel`。`HUBTERM_DEST` 可改安装目的地（非 /Applications 时不 pkill 旧实例，便于并行验证）。
- **跨平台：Windows x64 构建**——`npm run package:win`（`scripts/assemble-win.js`，在 macOS/Linux 上即可构建 win32 目标）：直接组装官方 electron zip + 裁剪依赖（排除 electron/electron-packager/cpu-features/nan/.bin），产出绿色目录 + zip；检测到 wine 时用 rcedit 嵌入 exe 图标与版本（未装则跳过，附 icon.ico）。未签名首跑有 SmartScreen 提示。
- **Windows 界面适配**：终端与界面字体栈加入 Cascadia Code/Consolas/Segoe UI/微软雅黑兜底；标题栏改条件化（macOS 融合红绿灯，Windows/Linux 走系统标题栏）；终端快捷键守卫与全局快捷键按平台识别修饰键（⌘/Ctrl）；静态与运行时快捷键提示在非 macOS 显示 Ctrl+；新增 `assets/icon.ico`（`scripts/make_ico.py` 由 icon-512.png 生成）。
- 测试：`test/mcp.test.js` 17 项（协议握手/401 鉴权/工具列表/exec 成功·退出码·超时·256KB 截断/审批拒绝/不可自动化/审计日志），mockserver 补 exec 通道；`HUBTERM_HOME` 环境变量隔离数据目录（测试/CI 不碰真实 `~/.hubterm`）；npm test 链纳入 mcp 测试。设计文档 `docs/mcp-design.md`。

## 2.7.0 (2026-10-26) — 主题打磨与复制粘贴修复

- **修复复制粘贴在应用内完全失效**：终端聚焦时全局快捷键把 xterm 的隐藏输入框误当普通输入框提前返回，⌘C/⌘V 从未生效；应用此前也没有「编辑」菜单兜底。现在新增「编辑」菜单（复制 ⌘C / 粘贴 ⌘V / 全选 ⌘A / 在终端中查找 ⌘F），复制粘贴按焦点统一路由：终端走选区与剪贴板（粘贴经 `term.paste`，支持括号粘贴与换行归一），输入框直接读写选区；终端右键新增 复制 / 粘贴 / 全选 / 搜索 / 清屏 菜单。剪贴板读写走主进程，不受窗口焦点限制。
- **浅色主题全面打磨**：浅色板重调（白底面板、更清晰的文字层级与边框），弹窗遮罩、错误/连接遮罩、阴影、拖拽高亮、状态点光晕全部收编为主题变量随主题切换；`color-scheme` 跟随主题，下拉框/复选框/滚动条等原生控件浅色下不再渲染成深色；欢迎页 logo 接入主题色。终端默认配色跟随界面主题（浅色 → Catppuccin Latte、深色 → Mocha），切换时已打开标签实时跟随；新增 Latte / Solarized Light 两套浅色终端方案，会话高级选项仍可单独指定。启动窗口底色随上次外观，浅色下不再先闪一帧深色。
- **主题切换出菜单**：顶栏新增外观按钮（自动⇄浅色⇄深色循环，图标随状态变化），不用再进 ⌘/ 设置；视图菜单与设置弹窗里的外观选项同步联动。
- **设置入口更直观**：顶栏「快捷键与设置」图标由键盘改为齿轮，弹窗加「设置」标题；关于面板版本号改取 package.json（原硬编码 2.5.0）。
- 自测钩子：`--screenshot` 支持 `--theme=light|dark` 预览对应外观（不写入配置）；截图路径退出不再被「退出恢复」弹窗卡住。
- **深浅色主题切换**：设置新增「外观」偏好（跟随系统 / 深色 / 浅色，默认跟随系统并监听系统实时切换）；浅色为 Catppuccin Latte。全部界面色值收编为 CSS token（新增 inset/line/scroll/pane-head 等），终端配色仍按会话独立设置不受影响。
- **会话树文件夹与拖拽**：右键分组或树空白处可新建文件夹（支持 / 分级、允许空文件夹）、重命名（其下会话与子文件夹一并迁移）、删除空文件夹；会话与文件夹均可拖拽，拖到目标分组即移入、拖到树空白处回到根，落点高亮反馈。空文件夹记录在本地（逐级归一化），不依附会话存在。
- **设置界面对齐统一**：弹窗表单内 input/select 统一 13px 字号与 32px 高度、右缘对齐（此前输入框 15px 带字距、下拉框自适应内容宽，同一表格大小不一）；偏好设置行统一「名称+说明靠左、控件列靠右」排版（此前复选框在左、下拉框在右两种排版混用），说明过长自动换行不再截断；帮助弹窗分区标题与编辑弹窗分区标题同一设计语言，去掉内联 margin 硬凑。
- **侧栏可拖拽调宽、拖到底整个收起，顶栏有开关按钮**：侧边栏右缘拖拽手柄（悬停显高亮线），宽度实时生效并记住（180–480px），拖到 120px 以下整个收起（记住收起前宽度）；顶栏新增侧栏开关按钮（图标随状态切换，⌘B / 菜单 / 拖拽共用同一状态）；收起后左缘留一条细拖出条，往右拖或双击即展开。修复 ⌘ 组合键在输入框聚焦时全部失灵的问题（⌘B/⌘P 等现在随处可用，⌘C/⌘V/⌘A 在输入框内保持原生语义）。
- **修复拖拽上传静默失效**：Electron 32 起 `File.path` 已移除，拖文件进 SFTP 抽屉什么都不发生；改用 `webUtils.getPathForFile`（preload 暴露）。
- **SFTP 传输可取消**：状态栏新增「取消传输」按钮——取消即关闭 SFTP 通道中止在途读写，错误归一为「已取消」，上传队列停止后续文件；个别服务端不回 CHANNEL_CLOSE 时 2 秒兜底返回。
- **修复断线后 SFTP 僵尸缓存**：连接断开/出错后不再拿已死通道操作（明确报「会话已断开」）；SFTP 通道被服务端单方面关闭时缓存自动失效、下次操作自动重开；抽屉随会话断开解绑并提示，重连成功且抽屉仍开着时自动重绑。
- **连接就绪语义对齐常规 SSH 客户端**：无任何自动化的会话（无规则、无登录后命令）在 shell 通道打开时即标记 connected、可交互——不再用 `$/#` 提示符正则猜测就绪（菜单式远端、zsh `%` 提示符等曾导致遮罩挂满 45 秒才由兜底超时撤掉）。带自动化的会话（规则 / post）仍等流程收尾，避免用户击键与自动应答交错（如命令被当成 sudo 密码提交）。
- **修复已连接会话被输出误杀**：connected 之后终端输出中出现 "Permission denied"（sudo 失败、命令回显）或横幅提到"验证码"，不再把状态打成 error/黄点——认证被拒与 MFA 提示只在登录阶段判定。
- **修复 post 无密码场景的死等**：post 注入后回到提示符即完成，不再补发 `\r` 等待一个不会再出现的回显。

## 2.5.0 (2026-10-26) — Design polish

- New app icon: vector-drawn terminal prompt (> _) with soft glow, two-tone
- Welcome screen: SVG logo, one-line pitch, primary actions (⌘P / ⌘⇧N), recents, tips
- All emoji icons replaced with crisp inline SVG (toolbar, overlays, transfer panel, SFTP file list)
- Edit dialog: three labeled sections (连接 / 认证 / 自动登录) with inline rule examples; single SSH type — type dropdown removed
- Session tree: click to connect (or focus open tab, Termius-style); status dot = idle/connected
- Connecting overlay: animated spinner instead of emoji

## 2.4.0 (2026-10-26) — Production trim

### Removed
- **Local terminal** (session type + node-pty dependency). It conflated "connection target" with "session type" and added a native build dependency for marginal value — use Terminal.app. All sessions are `ssh` now.
- ProxyJump had been removed in 2.2.0; dead code paths cleaned.

### Kept (audit result)
Core: session tree/CRUD, rules-only automation, password/agent/key auth, credential prompts (empty/rotated), ZMODEM, SFTP, port forwarding, snippets broadcast, palette, splits, known_hosts, logging, backup, ssh-config import, SecureCRT migration.

## 2.1.0 (2026-10-25) — No built-in login flows

### Removed / Changed (architecture)
- **All built-in bastion automation removed.** Per-session login rules are now the only automation mechanism — no more hardcoded company-specific flow, no black boxes.
- Session types simplified to `ssh` / `local` (legacy bastion/direct/raw are read as ssh).
- SecureCRT migration now restores each session's ORIGINAL Logon Actions (decrypted expect/send pairs) as that session's rules — first-principles fidelity.

### Added
- ZMODEM orthogonality guarantee & test: rz/sz works identically across rules/no-rules/jump sessions (transfer layer is independent of login automation).
- Rule variables `$PASSWORD` / `$TARGET`; post-login command applies to all types.
- Live verification against a real menu bastion via restored original rules.

## 2.0.0 (2026-10-25) — Open-source readiness

### Added
- Public key & SSH Agent authentication (per session)
- Standard ProxyJump: connect via another session as jump host
- Local terminal (real PTY via node-pty)
- `~/.ssh/config` import (Host blocks → sessions, IdentityFile detection)
- `$PASSWORD` / `$TARGET` variables in custom login rules
- Passwords encrypted at rest via OS Keychain (Electron safeStorage); legacy plaintext TSV dual-write is now a setting (`legacyTSV`)
- Repo: MIT LICENSE, bilingual README, CHANGELOG, CONTRIBUTING, CI workflow

### Changed
- Session types renamed to generic terms: SSH 直连 / 菜单式堡垒机（自动应答）/ SSH 入口 / 本地终端
- "目标用户" is now free-form (any bastion's menu answer), not a fixed root/yunwei choice
- Post-login command (`sudo -i` etc.) works for all session types

### Fixed
- Session names lost after v1.3 storage migration (palette/tree showed empty names)

## 1.4.0 (2026-10-25)

- Custom per-session expect→send login rules (SecureCRT Logon Actions equivalent); empty rules keep built-in flow.

## 1.3.x (2026-10-24/25)

- sessions.json as authoritative store (advanced per-session config: emulation, scrollback, font, color scheme, cursor, keepalive, auto-reconnect, logging)
- Screenshot comparison audit vs SecureCRT; name regression fix; free-form bastion user answer.

## 1.2.0 (2026-10-24)

- ⌘P quick-open palette, snippets panel with broadcast, split panes, SFTP browser, port forwarding, known_hosts pinning, backup export/import, tab drag-reorder & restore, clickable links, copy-on-select.

## 1.1.0 (2026-10-24)

- Session CRUD, ZMODEM (rz/sz) with lrzsz interop patches, fast-fail TCP (8s), connecting overlay, error overlays with reconnect.

## 1.0.0 (2026-10-24)

- Initial: session tree (67 sessions migrated from SecureCRT 9.1.1), bastion auto-login engine, MFA dialog, tabs, quick connect, terminal search.
