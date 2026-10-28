# Security Policy / 安全策略

## Supported versions / 支持版本

| Version | Supported |
| --- | --- |
| 2.8.x | ✅ |
| < 2.8 | ❌ (please upgrade / 请升级) |

## Reporting a vulnerability / 报告漏洞

**Please do not open a public issue for security problems.**
**请不要用公开 Issue 报告安全问题。**

Use GitHub's [private vulnerability reporting](https://github.com/thislyc/hubterm/security/advisories/new),
or email **thislyc@qq.com** with:

- A description of the issue / 问题描述
- Steps to reproduce (a minimal session config helps) / 复现步骤（附最小会话配置更好）
- Affected version and platform / 版本与平台

You will get a response within a few days. Fixes land in the next patch release,
and you will be credited in the changelog unless you prefer otherwise.

几天内会回复；修复将随下一个补丁版本发布，除非你另有要求，否则会在更新日志中致谢。

## Scope notes / 范围说明

- HubTerm stores everything locally under `~/.hubterm/`; passwords are encrypted
  with the OS keychain (Electron `safeStorage`). / 数据均在本地，密码走系统钥匙串加密。
- The built-in MCP server binds `127.0.0.1` only and is **off by default**.
  Reports about weakening these defaults are especially welcome.
  / 内置 MCP server 默认关闭且仅绑本机回环；削弱这些默认设计的问题尤其欢迎报告。
