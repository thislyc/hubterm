'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  // 会话
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  restoreInfo: () => ipcRenderer.invoke('restore:info'),
  saveRestoreTabs: (keys) => ipcRenderer.send('restore:saveTabs', keys),
  setRestoreMode: (mode) => ipcRenderer.send('restore:setMode', mode),
  setTheme: (mode) => ipcRenderer.send('theme:set', mode),
  saveSession: (s) => ipcRenderer.invoke('session:save', s),
  deleteSession: (key) => ipcRenderer.invoke('session:delete', key),
  openSession: (key) => ipcRenderer.invoke('session:open', key),
  adhoc: (cfg) => ipcRenderer.invoke('adhoc:open', cfg),
  // 连接
  write: (id, data) => ipcRenderer.send('session:write', { id, data }),
  resize: (id, rows, cols) => ipcRenderer.send('session:resize', { id, rows, cols }),
  closeSession: (id) => ipcRenderer.send('session:close', { id }),
  reconnect: (id) => ipcRenderer.invoke('session:reconnect', { id }),
  mfaReply: (id, code) => ipcRenderer.send('mfa:reply', { id, code }),
  credReply: (id, password, remember) => ipcRenderer.send('cred:reply', { id, password, remember }),
  // 剪贴板（主进程实现，不受渲染层焦点限制）
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (t) => ipcRenderer.invoke('clip:write', t),
  // ZMODEM
  zmodemRz: (id) => ipcRenderer.send('zmodem:rz', { id }),
  zmodemCancel: (id) => ipcRenderer.send('zmodem:cancel', { id }),
  // Snippets
  listSnippets: () => ipcRenderer.invoke('snippets:list'),
  saveSnippets: (list) => ipcRenderer.invoke('snippets:save', list),
  // 端口转发
  listForwards: (key) => ipcRenderer.invoke('forwards:list', key),
  saveForwards: (key, rules) => ipcRenderer.invoke('forwards:save', { key, rules }),
  // SFTP
  sftpList: (id, p) => ipcRenderer.invoke('sftp:list', { id, p }),
  sftpRealpath: (id, p) => ipcRenderer.invoke('sftp:realpath', { id, p }),
  sftpMkdir: (id, p) => ipcRenderer.invoke('sftp:mkdir', { id, p }),
  sftpRm: (id, p) => ipcRenderer.invoke('sftp:rm', { id, p }),
  sftpRmdir: (id, p) => ipcRenderer.invoke('sftp:rmdir', { id, p }),
  sftpRename: (id, from, to) => ipcRenderer.invoke('sftp:rename', { id, from, to }),
  sftpUpload: (id, local, remote) => ipcRenderer.invoke('sftp:upload', { id, local, remote }),
  sftpDownload: (id, remote, local) => ipcRenderer.invoke('sftp:download', { id, remote, local }),
  sftpCancel: (id) => ipcRenderer.send('sftp:cancel', { id }),
  pathForFile: (file) => webUtils.getPathForFile(file), // Electron 32 起 File.path 已移除
  pickUploadFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  pickSavePath: (defaultName) => ipcRenderer.invoke('dialog:saveFile', { defaultName }),
  revealFile: (p) => ipcRenderer.send('sftp:reveal', p),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  // MCP（本地 AI Agent 接入）
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpSetEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  mcpSetMode: (mode) => ipcRenderer.invoke('mcp:set-mode', mode),
  mcpRegenToken: () => ipcRenderer.invoke('mcp:regen-token'),
  mcpApprovalReply: (id, approved) => ipcRenderer.send('mcp:approval:reply', { id, approved }),
  onMcpApproval: (cb) => ipcRenderer.on('mcp:approval:ask', (e, d) => cb(d)),
  onMcpApprovalCancel: (cb) => ipcRenderer.on('mcp:approval:cancel', (e, d) => cb(d)),
  onMcpStatus: (cb) => ipcRenderer.on('mcp:status', (e, d) => cb(d)),
  // 语言（渲染层切换时同步主进程：菜单/对话框 + settings.json 持久化）
  setLang: (lang) => ipcRenderer.send('lang:set', lang),
  // 事件
  onData: (cb) => ipcRenderer.on('session:data', (e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('session:status', (e, d) => cb(d)),
  onMfa: (cb) => ipcRenderer.on('mfa:ask', (e, d) => cb(d)),
  onCred: (cb) => ipcRenderer.on('cred:ask', (e, d) => cb(d)),
  onZmodem: (cb) => ipcRenderer.on('zmodem:progress', (e, d) => cb(d)),
  onSftpProgress: (cb) => ipcRenderer.on('sftp:progress', (e, d) => cb(d)),
  onSnippets: (cb) => ipcRenderer.on('snippets:updated', (e, d) => cb(d)),
  onSessionsUpdated: (cb) => ipcRenderer.on('sessions:updated', (e, d) => cb(d)),
  onSessionsError: (cb) => ipcRenderer.on('sessions:error', (e, d) => cb(d)),
  onMenu: (cb) => ipcRenderer.on('menu:action', (e, d) => cb(d)),
});
