'use strict';
/* HubTerm 渲染层
   模型：Tab(标签) -> rows[] -> pane(窗格, 独立终端+独立SSH会话)
   tabs: Map<tabId, tab>; panesById: Map<sid, pane>
*/

const $ = (sel) => document.querySelector(sel);

/* 平台差异：快捷键提示与终端字体（macOS ⌘ / 其它 Ctrl+；与 main.js 菜单的 CmdOrCtrl 对应） */
const IS_MAC = /Mac/i.test(navigator.platform);
const MOD_LBL = IS_MAC ? '⌘' : 'Ctrl+';
const TERM_FONT = "'SF Mono', ui-monospace, Menlo, 'Cascadia Code', 'Cascadia Mono', Consolas, monospace";

/* ================= i18n（lib/i18n.js 提供，主/渲染进程共用字典） ================= */
const i18n = window.HubI18N;
const t = i18n.t;
i18n.init(navigator.language); // localStorage 记忆优先，否则跟随系统
document.documentElement.lang = i18n.getLang();
i18n.applyDOM(document); // 静态文案先翻好，再进入各渲染流程

let sessions = [];
let snippets = [];
const tabs = new Map();          // tabId -> tab
const panesById = new Map();      // sid -> pane
let activeTabId = null;
let mfaFor = null;
let credFor = null;
const authQueue = []; // 认证弹窗统一排队（MFA/密码共用）：互相顶掉会让被顶会话的 Promise 永远悬空
function showNextAuth() {
  if (mfaFor != null || credFor != null) return; // 已有弹窗在展示
  if (!$('#mfa-modal').classList.contains('hidden')) return;
  const next = authQueue.shift();
  if (!next) return;
  if (next.type === 'mfa') showMfa(next.id, next.prompt, next.mfa);
  else showCred(next.id, next.prompt, next.kind);
}
function showCred(id, prompt, kind) {
  credFor = id;
  mfaFor = null;
  $('#cred-title').textContent = kind === 'rejected' ? t('mfa.rejected') : t('mfa.enterPassword');
  $('#mfa-prompt').textContent = prompt || t('mfa.enterPassword');
  const input = $('#mfa-input');
  input.value = '';
  input.type = 'password';
  input.inputMode = 'text';
  $('#cred-remember-row').style.display = '';
  $('#cred-remember').checked = true;
  $('#mfa-modal').classList.remove('hidden');
  input.focus();
}
let editKey = null;
let confirmFn = null;
let promptFn = null;
const closedGroups = new Set(JSON.parse(localStorage.getItem('hubterm.closedGroups') || '[]'));
const extraGroups = new Set((() => { // 存量数据归一化：逐级补齐父路径，保证中间层级可见
  const set = new Set();
  for (const p of JSON.parse(localStorage.getItem('hubterm.extraGroups') || '[]')) {
    const parts = String(p).split('/');
    for (let i = 1; i <= parts.length; i++) if (parts[i - 1]) set.add(parts.slice(0, i).join('/'));
  }
  return set;
})());
const saveExtraGroups = () => localStorage.setItem('hubterm.extraGroups', JSON.stringify([...extraGroups]));
let fontSize = parseInt(localStorage.getItem('hubterm.fontSize'), 10) || 13;
const prefs = {
  copySelect: localStorage.getItem('hubterm.copySelect') !== '0',
  bell: localStorage.getItem('hubterm.bell') === '1',
};

/* 外观主题：auto 跟随系统 / dark / light（存 localStorage）。
   未显式指定配色的终端跟随「当前生效」外观：浅色 → Latte，深色 → Mocha */
let appliedTheme = 'dark'; // 折算后的生效外观（auto 按系统折算），applyTheme 启动即写入
function currentThemeMode() { return localStorage.getItem('hubterm.theme') || 'auto'; }
function uiLight(mode) {
  const m = mode || currentThemeMode();
  return m === 'light' || (m !== 'dark' && matchMedia('(prefers-color-scheme: light)').matches);
}
function applyTheme(mode) {
  appliedTheme = uiLight(mode) ? 'light' : 'dark';
  document.documentElement.dataset.theme = appliedTheme === 'light' ? 'light' : '';
  refreshPaneSchemes();
}
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentThemeMode() === 'auto') applyTheme();
});

const TERMINAL_STATUSES = ['connecting', 'logging-in', 'mfa-wait'];

/* 配色方案（每会话可覆盖；未指定时跟随界面主题） */
const SCHEMES = {
  mocha: { label: 'Catppuccin Mocha', bg: '#111118',
    palette: { background: '#111118', foreground: '#cdd3e0', cursor: '#f5e0dc', selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8' } },
  latte: { label: 'Catppuccin Latte', bg: '#eff1f5',
    palette: { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selectionBackground: '#acb0be',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
      blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
      brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb',
      brightCyan: '#179299', brightWhite: '#bcc0cc' } },
  dracula: { label: 'Dracula', bg: '#282a36',
    palette: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff' } },
  solarized: { label: 'Solarized Dark', bg: '#002b36',
    palette: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3' } },
  'solarized-light': { label: 'Solarized Light', bg: '#fdf6e3',
    palette: { background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#839496', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3' } },
  classic: { label: '经典黑', bg: '#000000',
    palette: { background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#3a3a3a',
      black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00',
      blue: '#0000ee', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5',
      brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00',
      brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff',
      brightCyan: '#00ffff', brightWhite: '#ffffff' } },
};
function defaultScheme() { return appliedTheme === 'light' ? SCHEMES.latte : SCHEMES.mocha; }
function schemeOf(info) { const k = info && info.colorScheme; return (k && SCHEMES[k]) || defaultScheme(); }
/* 界面主题变化时，未显式指定配色的窗格同步切换终端配色（启动早期 SCHEMES 尚未初始化，跳过） */
function refreshPaneSchemes() {
  if (!panesById.size) return;
  const s = defaultScheme();
  for (const [, p] of panesById) {
    if (p.info && p.info.colorScheme && SCHEMES[p.info.colorScheme]) continue;
    p.term.options.theme = s.palette;
    p.paneEl.style.background = s.bg;
  }
}

/* ================= 通用 ================= */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, kind = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function showCtx(e, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    const mi = document.createElement('div');
    mi.className = 'mi';
    mi.textContent = it.label;
    mi.onclick = () => { menu.classList.add('hidden'); it.fn(); };
    menu.appendChild(mi);
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
function hideCtx() { $('#ctx-menu').classList.add('hidden'); }
function askConfirm(title, msg, fn, okLabel) {
  $('#cf-title').textContent = title;
  $('#cf-msg').textContent = msg;
  $('#cf-ok').textContent = okLabel || t('common.ok');
  confirmFn = fn;
  $('#confirm-modal').classList.remove('hidden');
}
function askPrompt(title, msg, def, fn) {
  $('#pm-title').textContent = title;
  $('#pm-msg').textContent = msg || '';
  $('#pm-input').value = def || '';
  promptFn = fn;
  $('#prompt-modal').classList.remove('hidden');
  setTimeout(() => { $('#pm-input').focus(); $('#pm-input').select(); }, 30);
}

/* ================= 初始化 ================= */
async function init() {
  sessions = (await window.hub.listSessions()) || [];
  snippets = (await window.hub.listSnippets()) || [];
  console.log('[hubterm] sessions:', sessions.length, 'snippets:', snippets.length);
  renderTree($('#search').value);
  renderRecents();
  renderSnippets();
  loadPrefsUI();

  window.hub.onData(({ id, data }) => {
    const p = panesById.get(id);
    if (p) p.term.write(new Uint8Array(data));
  });
  window.hub.onStatus(({ id, status, msg }) => onStatus(id, status, msg));
  window.hub.onMfa(({ id, prompt, mfa }) => { authQueue.push({ type: 'mfa', id, prompt, mfa }); showNextAuth(); });
  window.hub.onCred(({ id, prompt, kind }) => {
    authQueue.push({ type: 'cred', id, prompt, kind });
    showNextAuth();
  });
  window.hub.onZmodem(onZmodem);
  window.hub.onSftpProgress(({ id, name, bytes, op }) => {
    if (sftpState.sid === id) {
      $('#sf-status').textContent = `${op === 'upload' ? '↑' : '↓'} ${name} ${fmtBytes(bytes)}`;
    }
  });
  window.hub.onSnippets(({ snippets: list }) => { snippets = list || []; renderSnippets(); });
  window.hub.onSessionsUpdated(({ sessions: list }) => {
    sessions = list || [];
    renderTree($('#search').value);
  });
  window.hub.onSessionsError(({ message }) => toast(message, 'err', 6000));
  window.hub.onMenu(({ action }) => menuAction(action));
  window.hub.onMcpApproval(showMcpApproval);
  window.hub.onMcpApprovalCancel(({ id }) => {
    if ($('#mcp-approval-modal').dataset.id === id) {
      clearInterval(mcpCountdown);
      $('#mcp-approval-modal').classList.add('hidden');
      toast(t('mcp.ap.timeoutDenied'), 'warn');
    }
  });
  window.hub.onMcpStatus(() => mcpRefreshUI());

  wireUI();
  localizeShortcutHints();
  mcpRefreshUI();

  // 启动恢复：auto=恢复并连接；manual=恢复为未连接标签（点击再连）；off=不恢复
  try {
    const info = await window.hub.restoreInfo();
    // 语言偏好以主进程 settings.json 为准（UI 里切换时两边同步写入，正常情况下本就一致）
    if (info.lang && info.lang !== i18n.getLang()) {
      setLanguage(info.lang);
    }
    if (info.mode !== 'off') {
      for (const key of info.keys || []) {
        const s = sessions.find((x) => x.key === key);
        if (!s) continue;
        if (info.mode === 'auto') await openSession(s);
        else addGhostTab(s);
      }
    }
  } catch (e) { /* 恢复失败不影响启动 */ }
}

/* 恢复的未连接标签（幽灵标签）：只有 UI，点击才真正连接 */
const ghostTabs = new Map(); // key -> {el, view}
function addGhostTab(s) {
  if (tabs.size + ghostTabs.size >= 12) return;
  removeGhost(s.key);
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="overlay ghost" style="position:absolute;inset:0">
      <div class="ov-title">${t('ghost.title')}</div>
      <div class="ov-msg">${esc(s.name)}</div>
      <div class="ov-btns">
        <button class="btn-ghost">${t('common.closeTab')}</button>
        <button class="btn-primary">${t('common.connect')}</button>
      </div>
    </div>`;
  const [bClose, bConn] = view.querySelectorAll('button');
  bClose.onclick = () => { removeGhost(s.key); persistOpenTabs(); };
  bConn.onclick = () => openSession(s);
  $('#views').appendChild(view);
  $('#welcome').style.display = 'none';

  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.ghost = s.key;
  el.innerHTML = `<span class="t-dot disconnected"></span><span class="t-name">${esc(s.name)}</span><span class="t-close">✕</span>`;
  el.title = s.name;
  el.onclick = (e) => { if (!e.target.classList.contains('t-close')) activateGhost(s.key); };
  el.querySelector('.t-close').onclick = (e) => { e.stopPropagation(); removeGhost(s.key); persistOpenTabs(); };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    showCtx(e, [
      { label: t('common.connect'), fn: () => openSession(s) },
      { label: t('common.closeTab'), fn: () => { removeGhost(s.key); persistOpenTabs(); } },
      { label: t('tab.closeOthers'), fn: closeOthers },
      { label: t('tab.closeRight'), fn: () => closeRightOf(el) },
    ]);
  };
  $('#tabs').appendChild(el);
  ghostTabs.set(s.key, { el, view });
  activateGhost(s.key);
}
function removeGhost(key) {
  const g = ghostTabs.get(key);
  if (!g) return;
  g.el.remove();
  g.view.remove();
  ghostTabs.delete(key);
  if (!tabs.size && !ghostTabs.size) {
    activeTabId = null;
    $('#welcome').style.display = '';
    renderRecents();
  }
}
function activateGhost(key) {
  const g = ghostTabs.get(key);
  if (!g) return;
  activeTabId = null;
  for (const [tid, t] of tabs) {
    t.view.classList.remove('active');
    t.tabEl?.classList.remove('active');
  }
  for (const [, og] of ghostTabs) og.el.classList.remove('active');
  g.el.classList.add('active');
  g.view.classList.add('active');
  g.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/* ================= 会话树 ================= */
function openSessionKeys() {
  const keys = new Set();
  for (const [, p] of panesById) if (p.info && p.info.key) keys.add(p.info.key);
  return keys;
}
function buildTree(list) {
  const root = { name: '', children: new Map(), sessions: [] };
  for (const s of list) {
    let node = root;
    for (const part of (s.group || '').split('/').filter(Boolean)) {
      if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), sessions: [] });
      node = node.children.get(part);
    }
    node.sessions.push(s);
  }
  // 手动创建的空文件夹：不依附会话存在，路径逐级补进树里
  for (const g of extraGroups) {
    let node = root;
    for (const part of g.split('/').filter(Boolean)) {
      if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), sessions: [] });
      node = node.children.get(part);
    }
  }
  return root;
}
function addExtraGroup(p) {
  const parts = p.split('/');
  for (let i = 1; i <= parts.length; i++) extraGroups.add(parts.slice(0, i).join('/'));
  saveExtraGroups();
}
/* 整体移动文件夹：其下会话逐个改 group（走 session:save 广播刷新），空文件夹路径一并改写 */
async function moveGroup(oldP, newP) {
  const rx = new RegExp('^' + oldP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|/)');
  const affected = sessions.filter((s) => rx.test(s.group || ''));
  for (const s of affected) {
    const r = await window.hub.saveSession({ ...s, group: newP + s.group.slice(oldP.length) });
    if (r.error) { toast(t('tree.moveFailed', r.error), 'err'); return; }
  }
  for (const gp of [...extraGroups]) {
    if (rx.test(gp)) { extraGroups.delete(gp); extraGroups.add(newP + gp.slice(oldP.length)); }
  }
  saveExtraGroups();
  if (!affected.length) renderTree($('#search').value); // 无会话时没有广播，手动刷新
}
async function dropIntoGroup(e, p) {
  const d = e.dataTransfer.getData('text/plain');
  if (d.startsWith('session:')) {
    const s = sessions.find((x) => x.key === d.slice(8));
    if (!s || (s.group || '') === p) return;
    const r = await window.hub.saveSession({ ...s, group: p });
    if (r.error) toast(r.error, 'err'); else toast(t('tree.moved', s.name, p || t('tree.root')), 'ok');
  } else if (d.startsWith('group:')) {
    const src = d.slice(6);
    const target = p ? p + '/' + src.split('/').pop() : src.split('/').pop();
    if (src !== target && !p.startsWith(src + '/')) moveGroup(src, target);
  }
}
function groupCtx(e, p, g) {
  const items = [
    { label: t('tree.newSubfolder'), fn: () => askPrompt(t('tree.newSubfolderTitle'), t('tree.newSubfolderMsg', p), '', (v) => {
      const name = v.trim();
      if (!name || name.split('/').some((x) => !x)) return toast(t('tree.badName'), 'warn');
      addExtraGroup(p + '/' + name);
      renderTree($('#search').value);
    }) },
    { label: t('tree.renameFolder'), fn: () => askPrompt(t('tree.renameFolderTitle'), t('tree.renameFolderMsg'), g.name, async (v) => {
      const name = v.trim();
      if (!name || name === g.name) return;
      if (name.includes('/')) return toast(t('tree.nameNoSlash'), 'warn');
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      await moveGroup(p, parent ? parent + '/' + name : name);
    }) },
  ];
  if (!g.sessions.length && !g.children.size) {
    items.push({ label: t('tree.deleteFolder'), fn: () => { extraGroups.delete(p); saveExtraGroups(); renderTree($('#search').value); } });
  }
  showCtx(e, items);
}
function renderTree(query) {
  const tree = $('#tree');
  tree.innerHTML = '';
  const q = (query || '').trim().toLowerCase();
  const match = (s) =>
    !q || s.name.toLowerCase().includes(q) ||
    (s.target || '').toLowerCase().includes(q) ||
    (s.user || '').toLowerCase().includes(q) ||
    (s.group || '').toLowerCase().includes(q);
  const openKeys = openSessionKeys();

  const renderNode = (node, container, gPath, searching) => {
    for (const g of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const collect = (n, acc) => { acc.push(...n.sessions); n.children.forEach((c) => collect(c, acc)); return acc; };
      const all = collect(g, []);
      const p = gPath ? gPath + '/' + g.name : g.name;
      const visible = searching ? all.filter(match).length : all.length;
      if (!visible && (searching || !extraGroups.has(p))) continue; // 空文件夹仅在非搜索时显示
      const closed = !searching && closedGroups.has(p);
      const head = document.createElement('div');
      head.className = 'group' + (closed ? ' closed' : '');
      head.innerHTML = `<span class="chev">▾</span><span>${esc(g.name)}</span><span class="count">${visible}</span>`;
      head.onclick = () => {
        closedGroups.has(p) ? closedGroups.delete(p) : closedGroups.add(p);
        localStorage.setItem('hubterm.closedGroups', JSON.stringify([...closedGroups]));
        renderTree($('#search').value);
      };
      head.draggable = true;
      head.ondragstart = (e) => e.dataTransfer.setData('text/plain', 'group:' + p);
      head.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); head.classList.add('drop-target'); };
      head.ondragleave = () => head.classList.remove('drop-target');
      head.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); head.classList.remove('drop-target'); dropIntoGroup(e, p); };
      head.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); groupCtx(e, p, g); };
      container.appendChild(head);
      const kids = document.createElement('div');
      kids.className = 'group-children' + (closed && !searching ? ' hidden' : '');
      container.appendChild(kids);
      renderNode(g, kids, p, searching);
    }
    for (const s of node.sessions) {
      if (!match(s)) continue;
      const row = document.createElement('div');
      row.className = 'sess';
      const ip = s.target && s.target !== s.host ? s.target : '';
      const on = openKeys.has(s.key);
      row.innerHTML = `<span class="dot${on ? ' on' : ''}"></span><span class="nm">${esc(s.name)}</span>` +
        (ip ? `<span class="ip">${esc(ip)}</span>` : '');
      row.title = `${s.group} · ${s.user}@${s.host}` + (s.target ? ` → ${s.target}` : '') + '\n' + t('tree.rowHint');
      row.onclick = () => {
        row.classList.add('match');
        // 已打开（含未连接的恢复标签）→ 聚焦其标签；否则仅选中
        for (const [tid, t] of tabs) {
          const p = t.rows.flat()[0];
          if (p && p.info && p.info.key === s.key) return setActiveTab(tid);
        }
        if (ghostTabs.has(s.key)) return activateGhost(s.key);
      };
      row.ondblclick = () => openSession(s);
      row.draggable = true;
      row.ondragstart = (e) => e.dataTransfer.setData('text/plain', 'session:' + s.key);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showCtx(e, [
          { label: t('common.connect'), fn: () => openSession(s) },
          { label: t('common.edit'), fn: () => showEdit(s) },
          { label: t('common.duplicate'), fn: () => showEdit({ ...s, name: s.name + t('common.copySuffix') }, true) },
          { label: t('common.delete'), fn: () => askConfirm(t('sess.deleteTitle'), t('sess.deleteMsg', s.name), async () => {
            const r = await window.hub.deleteSession(s.key);
            if (r.error) toast(r.error, 'err'); else toast(t('sess.deleted', s.name), 'ok');
          }, t('common.delete')) },
        ]);
      };
      container.appendChild(row);
    }
  };
  renderNode(buildTree(sessions), tree, '', !!q);
}

/* ================= 最近使用 / 恢复 ================= */
function getRecents() { return JSON.parse(localStorage.getItem('hubterm.recents') || '[]'); }
function pushRecent(key) {
  const r = getRecents().filter((k) => k !== key);
  r.unshift(key);
  localStorage.setItem('hubterm.recents', JSON.stringify(r.slice(0, 8)));
  renderRecents();
}
function renderRecents() {
  const box = $('#recents');
  const r = getRecents().slice(0, 8).map((k) => sessions.find((s) => s.key === k)).filter(Boolean); // 读取侧同样截断，兼容历史脏数据
  box.innerHTML = r.length ? `<div style="width:100%;text-align:center;color:var(--text-dim);font-size:11.5px;margin-bottom:2px">${t('recents.title')}</div>` : '';
  for (const s of r) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = s.name;
    chip.onclick = () => openSession(s);
    box.appendChild(chip);
  }
}
function persistOpenTabs() {
  const keys = [];
  for (const [, tab] of tabs) {
    const p = tab.rows.flat()[0];
    if (p && p.info && p.info.key && !p.info.key.startsWith('adhoc:')) keys.push(p.info.key);
  }
  for (const [key] of ghostTabs) if (!keys.includes(key)) keys.push(key);
  localStorage.setItem('hubterm.openTabs', JSON.stringify(keys));
  window.hub.saveRestoreTabs(keys);
}

/* ================= 终端窗格 ================= */
function makeTerminal(boxEl, info = {}) {
  const scheme = schemeOf(info);
  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: info.fontOverride > 0 ? info.fontOverride : fontSize,
    cursorBlink: info.cursorBlink === '' ? true : info.cursorBlink === '1',
    cursorStyle: info.cursor || 'block',
    scrollback: info.scrollback > 0 ? info.scrollback : 10000,
    theme: scheme.palette,
  });
  const fit = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(searchAddon);
  term.attachCustomKeyEventHandler((e) => {
    // 带修饰键的组合键交给应用层（菜单/全局快捷键），xterm 不往 pty 里写
    const appMod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (appMod && ['a','c','v','f','w','r','k','t','n','b','e','p','l','d','=','-','0','/'].includes(e.key.toLowerCase())) return false;
    if (e.key === 'Escape') return false;
    return true;
  });
  term.open(boxEl);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => { e.preventDefault(); window.hub.openExternal(uri); })); } catch (err) { /* ignore */ }
  try { term.loadAddon(new WebGLAddon.WebGLAddon()); } catch (err) { /* DOM 回退 */ }
  return { term, fit, searchAddon };
}

function createPane(tab, info, sid, { vertical = true, rowIndex = null } = {}) {
  const ri = rowIndex != null && tab.rows[rowIndex] ? rowIndex : tab.rows.length - 1;
  const rowEl = tab.rowsEl.children[ri];
  const paneEl = document.createElement('div');
  paneEl.className = 'pane' + (tab.rows[ri].length > 0 && vertical ? ' vertical' : '');
  paneEl.innerHTML = `
    <div class="pane-head"><span class="p-dot">●</span><span class="p-name">${esc(info.name)}</span><button class="p-close" title="${t('pane.close')}">✕</button></div>
    <div class="term-box"></div>`;
  rowEl.appendChild(paneEl);

  const scheme = schemeOf(info);
  paneEl.style.background = scheme.bg;
  const { term, fit, searchAddon } = makeTerminal(paneEl.querySelector('.term-box'), info);
  const pane = { sid, tabId: tab.id, info, term, fit, searchAddon, paneEl, status: 'connecting', elapsedTimer: null };
  panesById.set(sid, pane);
  tab.rows[ri].push(pane);

  paneEl.addEventListener('mousedown', () => { setActiveTab(tab.id); setActivePane(pane); });
  paneEl.querySelector('.p-close').onclick = (e) => { e.stopPropagation(); closePane(pane); };
  // 终端右键：常规终端客户端标配（有选区给复制，否则只给粘贴等）
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = pane.term.getSelection();
    showCtx(e, [
      ...(sel ? [{ label: t('common.copyVerb'), fn: () => { clipWrite(sel); toast(t('clip.copied'), 'ok', 900); } }] : []),
      { label: t('common.paste'), fn: pasteClipboard },
      { label: t('common.selectAll'), fn: selectAll },
      { label: t('term.findIn'), fn: showFind },
      { label: t('term.clear'), fn: () => pane.term.clear() },
    ]);
  });

  term.onData((d) => {
    if (/^\s*rz\b/.test(d) && d.includes('\r')) {
      window.hub.zmodemRz(sid);
      term.write('\r\n');
      return;
    }
    window.hub.write(sid, d);
  });
  if (prefs.copySelect) {
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) Promise.resolve(clipWrite(sel)).catch(() => {});
    });
  }
  if (prefs.bell) {
    term.onBell(() => toast(t('term.bell'), 'warn', 2000));
  }
  term.onResize(({ rows, cols }) => window.hub.resize(sid, rows, cols));

  const ro = new ResizeObserver(() => {
    if (paneEl.clientWidth > 60) requestAnimationFrame(() => { try { fit.fit(); } catch (e) {} });
  });
  ro.observe(paneEl);

  showPaneOverlay(pane);
  return pane;
}

function paneDotEl(pane) { return pane.paneEl.querySelector('.p-dot'); }
function setPaneStatus(pane, status) {
  pane.status = status;
  const colors = { connected: 'var(--green)', error: 'var(--red)', disconnected: 'var(--text-dim)', manual: 'var(--orange)' };
  paneDotEl(pane).style.color = colors[status] || 'var(--yellow)';
  // 标签点跟随主窗格状态
  if (tabs.get(pane.tabId)?.rows.flat()[0] === pane) setTabDot(pane.tabId, status);
  renderTree($('#search').value);
}

function showPaneOverlay(pane) {
  clearPaneOverlay(pane);
  const box = pane.paneEl.querySelector('.term-box');
  const ov = document.createElement('div');
  ov.className = 'overlay connecting';
  ov.style.position = 'absolute';
  ov.style.inset = '0';
  ov.innerHTML = `
    <div class="ov-spinner"></div>
    <div class="ov-title">${t('pane.connecting', esc(pane.info.name))}</div>
    <div class="ov-elapsed">${t('pane.waited')} <span class="secs">0</span> ${t('pane.secs')}</div>
    <div class="ov-btns"><button class="btn-ghost">${t('common.cancel')}</button></div>`;
  const s0 = Date.now();
  const span = ov.querySelector('.secs');
  clearInterval(pane.elapsedTimer);
  pane.elapsedTimer = setInterval(() => { span.textContent = Math.round((Date.now() - s0) / 1000); }, 500);
  ov.querySelector('button').onclick = () => closePane(pane);
  box.appendChild(ov);
}
function clearPaneOverlay(pane) {
  clearInterval(pane.elapsedTimer);
  pane.paneEl.querySelector('.term-box .overlay')?.remove();
}
function showPaneError(pane, title, msg) {
  clearPaneOverlay(pane);
  const box = pane.paneEl.querySelector('.term-box');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.style.position = 'absolute';
  ov.style.inset = '0';
  ov.innerHTML = `
    <div class="ov-icon"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="none" stroke="#f38ba8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3 2.5 20h19zM12 9.5v5M12 17.6v.4"/></svg></div>
    <div class="ov-title">${esc(title)}</div>
    <div class="ov-msg">${esc(msg || '')}</div>
    <div class="ov-btns">
      <button class="btn-ghost">${t('pane.close')}</button>
      <button class="btn-primary">${t('common.reconnect')}</button>
    </div>`;
  const [b1, b2] = ov.querySelectorAll('button');
  b1.onclick = () => closePane(pane);
  b2.onclick = () => reconnectPane(pane);
  box.appendChild(ov);
}

function reconnectPane(pane) {
  pane.term.reset();
  setPaneStatus(pane, 'connecting');
  window.hub.reconnect(pane.sid);
  showPaneOverlay(pane);
}

function closePane(pane) {
  const tab = tabs.get(pane.tabId);
  if (!tab) return;
  clearInterval(pane.elapsedTimer);
  window.hub.closeSession(pane.sid);
  pane.term.dispose();
  pane.paneEl.remove();
  panesById.delete(pane.sid);
  for (const row of tab.rows) {
    const i = row.indexOf(pane);
    if (i >= 0) row.splice(i, 1);
  }
  tab.rows = tab.rows.filter((r) => r.length > 0);
  // 重建 DOM 行结构（简单可靠）
  relayoutTab(tab);
  if (!tab.rows.length) closeTab(tab.id);
  else setActiveTab(tab.id);
  renderTree($('#search').value);
  persistOpenTabs();
}

function relayoutTab(tab) {
  // 删除已无窗格的空行（按 DOM 实际内容判断，避免索引错位）
  [...tab.rowsEl.querySelectorAll('.row')].forEach((rowEl) => {
    if (!rowEl.querySelector('.pane')) rowEl.remove();
  });
  const flat = tab.rows.flat();
  if (flat.length === 1) flat[0].paneEl.classList.remove('vertical', 'horizontal');
}

/* ================= 标签 ================= */
async function openSession(s, opts = {}) {
  const res = await window.hub.openSession(s.key);
  if (res.error) return toast(res.error, 'err');
  removeGhost(s.key);
  const tab = createTab(res.id, res.session);
  setActiveTab(tab.id);
  pushRecent(s.key);
  persistOpenTabs();
  return tab;
}

function createTab(primarySid, info) {
  const viewEl = document.createElement('div');
  viewEl.className = 'view';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'panes';
  const rowEl = document.createElement('div');
  rowEl.className = 'row';
  rowEl.style.cssText = 'display:flex;flex:1;min-height:0;';
  rowsEl.appendChild(rowEl);
  viewEl.appendChild(rowsEl);
  $('#views').appendChild(viewEl);

  const tab = { id: primarySid, info, viewEl, rowsEl, rows: [] };
  tab.rows.push([]);
  tabs.set(primarySid, tab);

  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.dataset.id = primarySid;
  el.innerHTML = `<span class="t-dot connecting"></span><span class="t-name">${esc(info.name)}</span><span class="t-close">✕</span>`;
  el.title = info.name;
  el.onclick = (e) => { if (!e.target.classList.contains('t-close')) setActiveTab(primarySid); };
  el.querySelector('.t-close').onclick = (e) => { e.stopPropagation(); closeTab(primarySid); };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    const thisTab = () => tabs.get(primarySid);
    const multi = tabOrder().length > 1;
    showCtx(e, [
      { label: t('tab.splitV'), fn: () => { const t2 = thisTab(); if (t2) { setActiveTab(primarySid); splitPane('right'); } } },
      { label: t('tab.splitH'), fn: () => { const t2 = thisTab(); if (t2) { setActiveTab(primarySid); splitPane('down'); } } },
      { label: t('common.reconnect'), fn: () => { thisTab()?.rows.flat().forEach(reconnectPane); } },
      ...(multi ? [
        { label: t('tab.closeOthers'), fn: () => { setActiveTab(primarySid); closeOthers(); } },
        { label: t('tab.closeRight'), fn: () => closeRightOf(el) },
        { label: t('tab.closeLeft'), fn: () => closeLeftOf(el) },
      ] : []),
      { label: t('common.closeTab'), fn: () => closeTab(primarySid) },
    ]);
  };
  // 标签拖拽排序
  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', primarySid));
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = e.dataTransfer.getData('text/plain');
    if (from === primarySid) return;
    const fromEl = $(`#tabs .tab[data-id="${from}"]`);
    if (!fromEl) return;
    const ref = el.getBoundingClientRect();
    const after = e.clientX > ref.left + ref.width / 2;
    $('#tabs').insertBefore(fromEl, after ? el.nextSibling : el);
  });
  $('#tabs').appendChild(el);

  $('#welcome').style.display = 'none';
  createPane(tab, info, primarySid);
  return tab;
}

function primaryTab() { return activeTabId; }
function activePaneOf(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  return tab.activePane || tab.rows.flat()[0] || null;
}
function activePane() { return activePaneOf(activeTabId); }

function setActiveTab(id) {
  activeTabId = id;
  for (const [tid, t] of tabs) {
    const on = tid === id;
    t.viewEl.classList.toggle('active', on);
    t.tabEl = $(`#tabs .tab[data-id="${tid}"]`);
    t.tabEl?.classList.toggle('active', on);
  }
  const p = activePaneOf(id);
  if (p) setActivePane(p);
  $(`#tabs .tab[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function setActivePane(pane) {
  const tab = tabs.get(pane.tabId);
  if (!tab) return;
  tab.activePane = pane;
  for (const row of tab.rows) for (const pp of row) pp.paneEl.classList.toggle('focused', pp === pane);
  requestAnimationFrame(() => { try { pane.fit.fit(); } catch (e) {} pane.term.focus(); });
}
function setTabDot(tabId, status) {
  const el = $(`#tabs .tab[data-id="${tabId}"] .t-dot`);
  if (el) el.className = 't-dot ' + (status || 'disconnected');
}

function tabOrder() {
  return [...$('#tabs').children]
    .map((el) => tabs.get(el.dataset.id) || ghostTabs.get(el.dataset.ghost))
    .filter(Boolean);
}
function closeOthers() {
  const order = tabOrder();
  const keep = activeTabId != null ? tabs.get(activeTabId) : (order.find((t) => t.el?.classList.contains('active')) || order[0]);
  for (const t of order) {
    if (t === keep) continue;
    if (t.id != null) closeTab(t.id);
    else removeGhost(t.el.dataset.ghost);
  }
  persistOpenTabs();
}
function closeRightOf(refEl) {
  const els = [...$('#tabs').children];
  const idx = els.indexOf(refEl);
  for (const el of els.slice(idx + 1)) {
    if (el.dataset.id) closeTab(+el.dataset.id);
    else if (el.dataset.ghost) removeGhost(el.dataset.ghost);
  }
  persistOpenTabs();
}
function closeLeftOf(refEl) {
  const els = [...$('#tabs').children];
  const idx = els.indexOf(refEl);
  for (const el of els.slice(0, idx)) {
    if (el.dataset.id) closeTab(+el.dataset.id);
    else if (el.dataset.ghost) removeGhost(el.dataset.ghost);
  }
  persistOpenTabs();
}
function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  for (const p of tab.rows.flat()) {
    clearInterval(p.elapsedTimer);
    window.hub.closeSession(p.sid);
    p.term.dispose();
    panesById.delete(p.sid);
  }
  tab.viewEl.remove();
  const el = $(`#tabs .tab[data-id="${id}"]`);
  el?.remove();
  tabs.delete(id);
  renderTree($('#search').value);
  persistOpenTabs();
  if (activeTabId === id) {
    const next = tabOrder().pop();
    if (next) setActiveTab(next.id);
    else { activeTabId = null; $('#welcome').style.display = ''; renderRecents(); }
  }
}

async function splitPane(dir) {
  const pane = activePane();
  const tab = pane && tabs.get(pane.tabId);
  if (!tab || !pane.info.key) return toast(t('split.adhocOnly'), 'warn');
  const res = await window.hub.openSession(pane.info.key);
  if (res.error) return toast(res.error, 'err');
  if (dir === 'down') {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.style.cssText = 'display:flex;flex:1;min-height:0;';
    tab.rowsEl.appendChild(rowEl);
    tab.rows.push([]);
    createPane(tab, res.session, res.id, { vertical: false, rowIndex: tab.rows.length - 1 });
    tab.rows[tab.rows.length - 1][0]?.paneEl.classList.add('horizontal');
  } else {
    // 加到当前活动窗格所在的行
    const ri = Math.max(0, tab.rows.findIndex((r) => r.includes(pane)));
    createPane(tab, res.session, res.id, { vertical: true, rowIndex: ri });
  }
  setActiveTab(tab.id);
  const newPane = panesById.get(res.id);
  if (newPane) setActivePane(newPane);
  toast(t('split.done'), 'ok', 1500);
}

/* ================= 状态 ================= */
function onStatus(id, status, msg) {
  const pane = panesById.get(id);
  if (!pane) return;
  const prev = pane.status; // 前态先存：setPaneStatus 之后 pane.status 已是本次状态
  setPaneStatus(pane, status);
  // SFTP 抽屉与该会话的绑定：断开即停用，重连成功且抽屉仍开着则自动重绑
  if (sftpState.sid === id && (status === 'disconnected' || status === 'error')) {
    sftpState.sid = null;
    sftpState.cancelFlag = false;
    setSftpBusy(false);
    $('#sf-list').innerHTML = '';
    sftpStatus(t('sftp.sessionClosed'));
  } else if (status === 'connected' && !sftpState.sid && !$('#sftp-drawer').classList.contains('hidden')) {
    const p = activePane();
    if (p && p.sid === id && p.info.type !== 'bastion') { sftpState.sid = id; sftpLs('.'); }
  }
  if (status === 'connected') {
    clearPaneOverlay(pane);
    toast(t('pane.connected', pane.info.name), 'ok');
  } else if (status === 'connecting') {
    showPaneOverlay(pane); // 首连与自动重连都会走到这里
  } else if (TERMINAL_STATUSES.includes(status)) {
    // 登录中/MFA：保持现有遮罩
  } else if (status === 'manual') {
    clearPaneOverlay(pane);
    toast(t('pane.manual', msg || ''), 'warn', 6000);
  } else if (status === 'reauth') {
    // 密码被拒正在重输：不显示错误遮罩，仅状态点变黄 + 轻提示
    clearPaneOverlay(pane);
    setPaneStatus(pane, 'mfa-wait');
    toast(t('pane.reauth', pane.info.name), 'warn', 5000);
  } else if (status === 'auth-failed') {
    showPaneError(pane, t('pane.authFailed'), msg);
  } else if (status === 'error') {
    showPaneError(pane, t('pane.connectFailed'), msg);
  } else if (status === 'disconnected') {
    if (prev !== 'error') showPaneError(pane, t('pane.disconnected'), msg || '');
  }
}

/* ================= MFA ================= */
function showMfa(id, prompt, mfa) {
  mfaFor = id;
  credFor = null;
  $('#cred-title').textContent = mfa ? t('mfa.codeTitle') : t('mfa.credTitle');
  $('#mfa-prompt').textContent = mfa
    ? t('mfa.mfaPrompt')
    : (prompt || t('mfa.prompt'));
  $('#mfa-input').value = '';
  $('#mfa-input').type = 'text';
  $('#mfa-input').inputMode = mfa ? 'numeric' : 'text';
  $('#cred-remember-row').style.display = 'none';
  $('#mfa-modal').classList.remove('hidden');
  $('#mfa-input').focus();
}
function replyMfa(code) {
  const isMfa = mfaFor != null;
  if (isMfa && code && !/^\d{6}$/.test(code)) {
    toast(t('mfa.notSixDigits'), 'err', 6000);
    $('#mfa-input').focus();
    $('#mfa-input').select();
    return; // 不关闭弹窗，让用户重填
  }
  if (credFor != null) {
    window.hub.credReply(credFor, code, $('#cred-remember').checked);
    credFor = null;
  } else if (mfaFor != null) {
    window.hub.mfaReply(mfaFor, code);
    mfaFor = null;
  }
  $('#mfa-modal').classList.add('hidden');
  showNextAuth();
}

/* ================= 快速打开面板 ================= */
let palSelected = 0;
let palItems = [];
function fuzzyScore(s, q) {
  const hay = `${s.name} ${s.group || ''} ${s.target || ''} ${s.user || ''}`.toLowerCase();
  let score = 0, hi = 0;
  for (const ch of q) {
    const i = hay.indexOf(ch, hi);
    if (i < 0) return -1;
    score += (i === hi ? 3 : 1) + (i === 0 || hay[i - 1] === ' ' || hay[i - 1] === '/' ? 2 : 0);
    hi = i + 1;
  }
  return score + Math.max(0, 20 - s.name.length);
}
function openPalette() {
  $('#palette-mask').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  renderPalette('');
}
function renderPalette(q) {
  const list = $('#palette-list');
  let items;
  if (!q) {
    const recentKeys = getRecents();
    items = recentKeys.map((k) => sessions.find((s) => s.key === k)).filter(Boolean);
    const seen = new Set(items.map((s) => s.key));
    items = items.concat(sessions.filter((s) => !seen.has(s.key)).slice(0, 20));
  } else {
    items = sessions
      .map((s) => ({ s, score: fuzzyScore(s, q.toLowerCase()) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.s);
  }
  palItems = items;
  palSelected = 0;
  list.innerHTML = items.length ? '' : `<div class="pal-item" style="color:var(--text-dim)">${t('palette.noMatch')}</div>`;
  items.forEach((s, i) => {
    const it = document.createElement('div');
    it.className = 'pal-item' + (i === 0 ? ' sel' : '');
    it.innerHTML = `<span class="dot"></span><span class="nm">${esc(s.name)}</span><span class="grp">${esc(s.group || '')}</span>`;
    it.onclick = () => { closePalette(); openSession(s); };
    list.appendChild(it);
  });
}
function palMove(d) {
  if (!palItems.length) return;
  palSelected = (palSelected + d + palItems.length) % palItems.length;
  [...$('#palette-list').children].forEach((el, i) => el.classList.toggle('sel', i === palSelected));
  $('#palette-list').children[palSelected]?.scrollIntoView({ block: 'nearest' });
}
function closePalette() { $('#palette-mask').classList.add('hidden'); }

/* ================= 快捷命令 ================= */
function renderSnippets() {
  const list = $('#sn-list');
  if (!snippets.length) {
    list.innerHTML = `<div class="sn-empty">${t('snippets.emptyDyn')}</div>`;
    return;
  }
  list.innerHTML = '';
  const broadcast = $('#sn-broadcast').checked;
  for (const sn of snippets) {
    const b = document.createElement('button');
    b.className = 'sn-btn' + (broadcast ? ' broadcast' : '');
    b.textContent = sn.name;
    b.title = sn.command;
    b.onclick = () => sendSnippet(sn);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      showCtx(e, [
        { label: t('common.edit'), fn: () => showSnippetModal(sn) },
        { label: t('common.delete'), fn: () => askConfirm(t('snippets.deleteTitle'), t('snippets.deleteMsg', sn.name), () => {
          snippets = snippets.filter((x) => x.id !== sn.id);
          window.hub.saveSnippets(snippets);
          renderSnippets();
        }, t('common.delete')) },
      ]);
    };
    list.appendChild(b);
  }
}
async function sendSnippet(sn) {
  const cmd = sn.command.trim() + '\n';
  if ($('#sn-broadcast').checked) {
    const targets = [...panesById.values()].filter((p) => p.status === 'connected');
    if (!targets.length) return toast(t('snippets.noConnected'), 'warn');
    askConfirm(t('snippets.broadcastTitle'), t('snippets.broadcastMsg', targets.length, cmd), () => {
      for (const p of targets) window.hub.write(p.sid, cmd);
      toast(t('snippets.broadcastDone', targets.length), 'ok');
    }, t('snippets.broadcast'));
  } else {
    const p = activePane();
    if (!p) return toast(t('snippets.noPane'), 'warn');
    window.hub.write(p.sid, cmd);
  }
}
function showSnippetModal(sn) {
  editingSnippetId = sn?.id || null;
  $('#snm-title').textContent = sn ? t('snippets.editTitle') : t('snippets.newTitle');
  $('#snm-name').value = sn?.name || '';
  $('#snm-cmd').value = sn?.command || '';
  $('#snippet-modal').classList.remove('hidden');
  $('#snm-name').focus();
}
let editingSnippetId = null;
async function saveSnippetModal() {
  const name = $('#snm-name').value.trim();
  const command = $('#snm-cmd').value.trim();
  if (!name || !command) return toast(t('snippets.nameCmdRequired'), 'err');
  if (editingSnippetId) {
    const i = snippets.findIndex((x) => x.id === editingSnippetId);
    if (i >= 0) snippets[i] = { ...snippets[i], name, command };
  } else {
    snippets.push({ id: 'sn' + Date.now(), name, command });
  }
  await window.hub.saveSnippets(snippets);
  renderSnippets();
  $('#snippet-modal').classList.add('hidden');
  toast(t('common.saved'), 'ok');
}

/* ================= SFTP 抽屉 ================= */
const sftpState = { sid: null, cwd: '', cancelFlag: false };
function setSftpBusy(busy) { $('#sf-cancel').classList.toggle('hidden', !busy); }
function toggleSftp(force) {
  const drawer = $('#sftp-drawer');
  const show = force !== undefined ? force : drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !show);
  if (show) {
    const p = activePane();
    if (!p) { sftpStatus(t('sftp.connectFirst')); return; }
    if (p.info.type === 'bastion') { sftpState.sid = null; sftpStatus(t('sftp.bastionUnsupported', MOD_LBL)); $('#sf-list').innerHTML = ''; return; }
    sftpState.sid = p.sid;
    sftpLs('.');
  }
}
function sftpStatus(t) { $('#sf-status').textContent = t; }
async function sftpLs(p) {
  if (!sftpState.sid) return;
  sftpStatus(t('sftp.reading'));
  const list = $('#sf-list');
  list.innerHTML = `<div class="sf-loading"><div class="sf-spin"></div><span>${t('sftp.reading')}</span></div>`;
  try {
    const abs = await window.hub.sftpRealpath(sftpState.sid, p);
    const { path, entries } = await window.hub.sftpList(sftpState.sid, abs);
    sftpState.cwd = path;
    $('#sf-path').value = path;
    list.innerHTML = '';
    for (const en of entries) {
      const row = document.createElement('div');
      row.className = 'sf-row';
      const icon = en.isDir
        ? '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="#89b4fa" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 2h5.5A1.5 1.5 0 0 1 14.5 5.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>'
        : en.isLink ? '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="#94e2d5" stroke-width="1.5" stroke-linecap="round" d="M6.5 9.5 9.5 6.5M4 12a3 3 0 0 1 0-4.2l1.8-1.8M12 4a3 3 0 0 1 0 4.2l-1.8 1.8"/></svg>'
        : '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="#6c7086" d="M4 1.5h5L13 5.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1zm5 1v3.5h3.5z"/></svg>';
      row.innerHTML = `<span class="sf-icon">${icon}</span><span class="sf-nm">${esc(en.name)}</span><span class="sf-meta">${en.isDir ? '' : fmtBytes(en.size)}</span>`;
      row.ondblclick = () => { if (en.isDir) sftpLs(joinPath(path, en.name)); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        const full = joinPath(path, en.name);
        showCtx(e, [
          { label: t('sftp.download'), fn: () => downloadRemote(full, en.name, en.isDir) },
          { label: t('sftp.rename'), fn: () => askPrompt(t('sftp.renameTitle'), en.name, en.name, async (nv) => {
            if (!nv || nv === en.name) return;
            try { await window.hub.sftpRename(sftpState.sid, full, joinPath(path, nv)); sftpLs(path); } catch (err) { toast(t('sftp.renameFailed', err.message), 'err'); }
          }) },
          { label: en.isDir ? t('sftp.deleteFolder') : t('common.delete'), fn: () => askConfirm(t('common.delete'), t('sftp.deleteMsg', en.isDir ? t('sftp.folder') : t('sftp.file'), en.name), async () => {
            try {
              await (en.isDir ? window.hub.sftpRmdir(sftpState.sid, full) : window.hub.sftpRm(sftpState.sid, full));
              sftpLs(path); toast(t('sftp.deleted'), 'ok');
            } catch (err) { toast(t('sftp.deleteFailed', err.message), 'err'); }
          }, t('common.delete')) },
        ]);
      };
      list.appendChild(row);
    }
    sftpStatus(t('sftp.pathCount', path, entries.length));
  } catch (e) {
    list.innerHTML = `<div class="sf-loading sf-error"><span>${t('sftp.readFailed', esc(e.message))}</span></div>`;
    sftpStatus(t('common.failedWith', e.message));
  }
}
function joinPath(dir, name) {
  if (name === '..') return dir.replace(/\/[^/]+\/?$/, '') || '/';
  return dir.replace(/\/$/, '') + '/' + name;
}
async function downloadRemote(full, name, isDir) {
  if (isDir) return toast(t('sftp.noFolderDownload'), 'warn');
  const local = await window.hub.pickSavePath(name);
  if (!local) return;
  sftpStatus(t('sftp.downloading', name));
  sftpState.cancelFlag = false;
  setSftpBusy(true);
  try {
    await window.hub.sftpDownload(sftpState.sid, full, local);
    toast(t('sftp.downloaded', name), 'ok');
    window.hub.revealFile(local);
    sftpLs(sftpState.cwd);
  } catch (e) {
    if (sftpState.cancelFlag || e.message === t('sftp.cancelled')) { toast(t('sftp.downloadCancelled'), 'warn'); sftpStatus(t('sftp.cancelled')); }
    else { toast(t('sftp.downloadFailed', e.message), 'err'); sftpStatus(''); }
  }
  setSftpBusy(false);
}
async function uploadFiles(files) {
  if (!sftpState.sid) return;
  sftpState.cancelFlag = false;
  setSftpBusy(true);
  for (const local of files) {
    if (sftpState.cancelFlag) break;
    const name = local.split('/').pop();
    sftpStatus(t('sftp.uploading', name));
    try {
      await window.hub.sftpUpload(sftpState.sid, local, sftpState.cwd + '/' + name);
      toast(t('sftp.uploaded', name), 'ok');
    } catch (e) {
      if (sftpState.cancelFlag || e.message === t('sftp.cancelled')) { toast(t('sftp.uploadCancelled'), 'warn'); break; }
      toast(t('sftp.uploadFailed', name, e.message), 'err');
    }
  }
  setSftpBusy(false);
  if (sftpState.sid) sftpLs(sftpState.cwd);
}

/* ================= 端口转发 ================= */
const fwdState = { key: null, rules: [] };
async function openForwards() {
  const p = activePane();
  if (!p || !p.info.key || p.info.key.startsWith('adhoc:')) return toast(t('fwd.savedOnly'), 'warn');
  fwdState.key = p.info.key;
  $('#fwd-session-name').textContent = '· ' + p.info.name;
  fwdState.rules = (await window.hub.listForwards(fwdState.key)) || [];
  renderForwards();
  $('#fwd-modal').classList.remove('hidden');
}
function renderForwards() {
  const list = $('#fwd-list');
  list.innerHTML = fwdState.rules.length ? '' : `<div class="sn-empty">${t('fwd.noRules')}</div>`;
  fwdState.rules.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'fwd-rule' + (r.enabled ? '' : ' disabled');
    el.innerHTML = `
      <span>127.0.0.1:${r.listen}</span><span class="arrow">→</span>
      <span>${esc(r.host)}:${r.port}</span><span class="spacer"></span>
      <button class="f-toggle" title="${r.enabled ? t('fwd.disable') : t('fwd.enable')}">${r.enabled ? '⏸' : '▶'}</button>
      <button class="f-del" title="${t('common.delete')}">✕</button>`;
    el.querySelector('.f-toggle').onclick = async () => { fwdState.rules[i].enabled = !r.enabled; await saveForwardsUI(); };
    el.querySelector('.f-del').onclick = async () => { fwdState.rules.splice(i, 1); await saveForwardsUI(); };
    list.appendChild(el);
  });
}
async function saveForwardsUI() {
  await window.hub.saveForwards(fwdState.key, fwdState.rules);
  renderForwards();
}
async function addForward() {
  const listen = parseInt($('#fwd-listen').value, 10);
  const host = $('#fwd-host').value.trim();
  const port = parseInt($('#fwd-port').value, 10);
  if (!listen || !host || !port) return toast(t('fwd.allRequired'), 'err');
  fwdState.rules.push({ id: 'f' + Date.now(), listen, host, port, enabled: true });
  $('#fwd-listen').value = ''; $('#fwd-host').value = ''; $('#fwd-port').value = '';
  await saveForwardsUI();
  toast(t('fwd.savedApplied'), 'ok');
}

/* ================= MCP（AI Agent 接入） ================= */
let mcpTokenShown = false;
let mcpLastToken = '';
let mcpCountdown = null;
async function mcpRefreshUI() {
  let st;
  try { st = await window.hub.mcpStatus(); } catch (e) { return; }
  const state = $('#mcp-state');
  state.textContent = st.enabled ? t('mcp.onWithUrl', st.url) : t('mcp.off');
  state.title = st.enabled ? st.url : '';
  state.classList.toggle('on', !!st.enabled);
  $('#mcp-toggle').textContent = st.enabled ? t('common.off2') : t('mcp.enable');
  $('#mcp-extra').style.display = st.enabled ? '' : 'none';
  if (st.enabled) {
    mcpLastToken = st.token || '';
    $('#mcp-url').textContent = st.url;
    $('#mcp-url').title = st.url;
    $('#mcp-token').textContent = mcpTokenShown ? st.token : '••••••••';
    $('#mcp-token').title = mcpTokenShown ? st.token : '';
    $('#mcp-mode').value = st.approvalMode;
  }
}
function mcpToggle() {
  window.hub.mcpStatus().then((st) => {
    if (st.enabled) {
      window.hub.mcpSetEnabled(false).then((r) => {
        if (r && r.error) return toast(r.error, 'err');
        toast(t('mcp.disabledToast'), 'ok');
        mcpRefreshUI();
      });
      return;
    }
    askConfirm(t('mcp.enableTitle'),
      t('mcp.enableMsg'),
      async () => {
        const r = await window.hub.mcpSetEnabled(true);
        if (r && r.error) return toast(r.error, 'err');
        toast(t('mcp.enabledToast'), 'ok');
        mcpRefreshUI();
      }, t('mcp.enable'));
  });
}
function showMcpApproval(req) {
  const modal = $('#mcp-approval-modal');
  modal.dataset.id = req.id;
  $('#mcp-ap-host').textContent = t('mcp.ap.host', req.host);
  $('#mcp-ap-cmd').textContent = req.command;
  $('#mcp-ap-count').textContent = 30;
  clearInterval(mcpCountdown);
  let left = 30;
  mcpCountdown = setInterval(() => { left -= 1; $('#mcp-ap-count').textContent = Math.max(0, left); }, 1000);
  modal.classList.remove('hidden');
  $('#mcp-ap-approve').focus();
}
function replyMcpApproval(approved) {
  const modal = $('#mcp-approval-modal');
  const id = modal.dataset.id;
  clearInterval(mcpCountdown);
  modal.classList.add('hidden');
  if (id) window.hub.mcpApprovalReply(id, approved);
}

/* 非 macOS：把静态 ⌘/⇧ 提示替换为 Ctrl/Shift（运行时生成的提示用 MOD_LBL 拼接） */
function localizeShortcutHints() {
  if (IS_MAC) return;
  const swap = (s) => s.replace(/⌘⇧/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+');
  document.querySelectorAll('kbd, option').forEach((el) => {
    if (/[⌘⇧]/.test(el.textContent)) el.textContent = swap(el.textContent);
  });
  document.querySelectorAll('[title]').forEach((el) => {
    const t = el.getAttribute('title');
    if (t && /[⌘⇧]/.test(t)) el.setAttribute('title', swap(t));
  });
}

/* ================= 快速连接 / 编辑会话 ================= */
function showQuick() { $('#quick-modal').classList.remove('hidden'); $('#qc-host').focus(); }
async function doQuickConnect() {
  const host = $('#qc-host').value.trim();
  const user = $('#qc-user').value.trim() || 'root';
  const port = parseInt($('#qc-port').value, 10) || 22;
  const password = $('#qc-pass').value;
  if (!host) return toast(t('quick.hostRequired'), 'err');
  $('#quick-modal').classList.add('hidden');
  const res = await window.hub.adhoc({ host, port, user, password });
  if (res.error) return toast(res.error, 'err');
  const tab = createTab(res.id, res.session);
  setActiveTab(tab.id);
}
function showEdit(s, isCopy) {
  editKey = s && s.key && !isCopy ? s.key : null;
  $('#edit-title').textContent = editKey ? t('edit.titleEdit') : (isCopy ? t('edit.titleCopy') : t('edit.titleNew'));
  $('#ed-name').value = s?.name || '';
  $('#ed-group').value = s?.group || '';
  $('#ed-host').value = s?.host || '';
  $('#ed-port').value = s?.port || 22;
  $('#ed-user').value = s?.user || '';
  $('#ed-pass').value = '';
  $('#ed-pass').placeholder = editKey ? t('edit.pass.keep') : t('edit.pass.ph');
  $('#ed-target').value = s?.target || '';
  $('#ed-post').value = s?.post || '';
  // 高级选项
  $('#ed-emulation').value = s?.emulation || '';
  $('#ed-scrollback').value = String(s?.scrollback || 0);
  $('#ed-font').value = String(s?.fontOverride || 0);
  $('#ed-scheme').value = s?.colorScheme || '';
  $('#ed-cursor').value = s?.cursor || '';
  $('#ed-blink').checked = s?.cursorBlink !== '0';
  $('#ed-reconnect').value = String(s?.autoReconnect || 0);
  $('#ed-keepalive').value = String(s?.keepalive || 0);
  $('#ed-logmode').value = s?.logMode || '';
  renderRulesEditor(Array.isArray(s?.rules) ? s.rules : []);
  $('#ed-auth').value = s?.auth || 'password';
  $('#ed-keypath').value = s?.keyPath || '';
  $('#ed-keypass').value = s?.keyPass || '';
  $('#ed-advanced').open = false;
  syncEditFields();
  $('#edit-modal').classList.remove('hidden');
  $('#ed-name').focus();
}
function syncEditFields() {
  const auth = $('#ed-auth').value;
  for (const [el, show] of [
    ['ed-l-keypath', auth === 'key'], ['ed-keypath', auth === 'key'],
    ['ed-l-keypass', auth === 'key'], ['ed-keypass', auth === 'key'],
  ]) $('#' + el).style.display = show ? '' : 'none';
}

/* ---------------- 自动登录规则编辑器 ---------------- */
function renderRulesEditor(rules) {
  const list = $('#ed-rules-list');
  list.innerHTML = '';
  (rules && rules.length ? rules : []).forEach((r) => list.appendChild(ruleRowEl(r)));
}
function ruleRowEl(r = {}) {
  const row = document.createElement('div');
  row.className = 'rule-row';
  row.innerHTML = `
    <input class="rx" placeholder="${t('edit.rule.expectPh')}" value="${esc(r.expect ?? '')}" spellcheck="false">
    <span class="arrow">→</span>
    <input class="rs" placeholder="${t('edit.rule.sendPh')}" value="${esc(r.send ?? '')}" spellcheck="false">
    <label title="${t('edit.rule.enterTip')}"><input type="checkbox" class="r-enter" ${r.enter === '0' ? '' : 'checked'}>${t('edit.rule.enter')}</label>
    <button class="r-del" type="button" title="${t('edit.rule.delTip')}">✕</button>`;
  row.querySelector('.r-del').onclick = () => row.remove();
  return row;
}
function collectRules() {
  return [...document.querySelectorAll('#ed-rules-list .rule-row')]
    .map((row) => ({
      expect: row.querySelector('.rx').value.trim(),
      send: row.querySelector('.rs').value,
      enter: row.querySelector('.r-enter').checked ? '1' : '0',
      hide: '0',
    }))
    .filter((r) => r.expect || r.send);
}

async function doSaveSession() {
  const name = $('#ed-name').value.trim();
  const host = $('#ed-host').value.trim();
  if (!name) return toast(t('edit.nameRequired'), 'err');
  if (!host) return toast(t('edit.hostRequired'), 'err');

  const r = await window.hub.saveSession({
    key: editKey || undefined,
    name, group: $('#ed-group').value.trim(), type: 'ssh',
    host, port: parseInt($('#ed-port').value, 10) || 22,
    user: $('#ed-user').value.trim() || 'root',
    password: $('#ed-pass').value || undefined,
    target: $('#ed-target').value.trim(), post: $('#ed-post').value.trim(),
    // 高级选项
    emulation: $('#ed-emulation').value,
    scrollback: parseInt($('#ed-scrollback').value, 10) || 0,
    fontOverride: parseInt($('#ed-font').value, 10) || 0,
    colorScheme: $('#ed-scheme').value,
    cursor: $('#ed-cursor').value,
    cursorBlink: $('#ed-blink').checked ? '1' : '0',
    autoReconnect: parseInt($('#ed-reconnect').value, 10) || 0,
    keepalive: parseInt($('#ed-keepalive').value, 10) || 0,
    logMode: $('#ed-logmode').value,
    rules: collectRules(),
    auth: $('#ed-auth').value,
    keyPath: $('#ed-keypath').value.trim(),
    keyPass: $('#ed-keypass').value,
  });
  if (r.error) return toast(r.error, 'err');
  $('#edit-modal').classList.add('hidden');
  toast(editKey ? t('common.saved') : t('edit.created', name), 'ok');
}

/* ================= ZMODEM 面板 ================= */
function onZmodem(p) {
  const panel = $('#zmodem-panel');
  if (p.phase === 'fail') {
    panel.classList.remove('hidden');
    $('#zm-title').textContent = t('zmodem.failed');
    $('#zm-detail').textContent = p.msg || '';
    setTimeout(hideZmodem, 3000);
    return;
  }
  if (p.phase === 'done' || p.phase === 'saved') {
    if (p.phase === 'saved') {
      panel.classList.remove('hidden');
      $('#zm-title').textContent = t('zmodem.saved');
      $('#zm-detail').textContent = `${p.name}（${fmtBytes(p.bytes)}）`;
      $('#zm-progress').style.width = '100%';
    }
    setTimeout(hideZmodem, 1200);
    return;
  }
  panel.classList.remove('hidden');
  $('#zm-icon').innerHTML = p.direction === 'send'
    ? '<svg viewBox="0 0 16 16" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M8 13V3M4.5 6.5 8 3l3.5 3.5M2.5 13.5h11"/></svg>'
    : '<svg viewBox="0 0 16 16" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M8 3v10M4.5 9.5 8 13l3.5-3.5M2.5 13.5h11"/></svg>';
  if (p.phase === 'wait') {
    $('#zm-title').textContent = t('zmodem.waitRz');
    $('#zm-detail').textContent = p.name || '';
    $('#zm-progress').style.width = '0%';
  } else {
    $('#zm-title').textContent = (p.direction === 'send' ? t('zmodem.uploading') : t('zmodem.downloading')) + (p.name || '');
    const pct = p.total ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : 0;
    $('#zm-progress').style.width = pct + '%';
    $('#zm-detail').textContent = `${fmtBytes(p.bytes)} / ${fmtBytes(p.total)}（${pct}%）`;
  }
}
function hideZmodem() { $('#zmodem-panel').classList.add('hidden'); }

/* ================= 终端内搜索 ================= */
function showFind() {
  if (!activePane()) return;
  $('#findbar').classList.remove('hidden');
  $('#find-input').focus();
  $('#find-input').select();
}
function doFind(dir) {
  const p = activePane();
  if (!p || !$('#find-input').value) return;
  try { dir === 'next' ? p.searchAddon.findNext() : p.searchAddon.findPrevious(); } catch (e) {}
}
function findFirst() {
  const p = activePane();
  const q = $('#find-input').value;
  if (!p || !q) return;
  try {
    p.searchAddon.find(q, {
      caseSensitive: false,
      decorations: { matchOverviewRuler: '#89b4fa', activeMatchColorOverviewRuler: '#f9e2af' },
    });
  } catch (e) {}
}

/* ================= 字号 / 偏好 ================= */
function applyFontSize(deltaOrValue, mode) {
  fontSize = mode === 'set' ? deltaOrValue : Math.max(9, Math.min(22, fontSize + deltaOrValue));
  localStorage.setItem('hubterm.fontSize', String(fontSize));
  for (const [, p] of panesById) {
    if (p.info.fontOverride > 0) continue; // 每会话字号覆盖优先于全局调整
    p.term.options.fontSize = fontSize;
    try { p.fit.fit(); } catch (e) {}
  }
}
function loadPrefsUI() {
  $('#set-copy-select').checked = prefs.copySelect;
  $('#set-bell').checked = prefs.bell;
  $('#set-theme').value = localStorage.getItem('hubterm.theme') || 'auto';
  $('#set-lang').value = i18n.getLang();
  window.hub.restoreInfo().then((info) => { const el = $('#set-restore-mode'); if (el) el.value = info.mode || 'manual'; }).catch(() => {});
}
function savePref(k, v) {
  prefs[k] = v;
  localStorage.setItem('hubterm.' + k, v ? '1' : '0');
}

/* ================= 复制 / 粘贴 / 全选 =================
   统一入口：焦点在真实输入框时直接读写其选区；焦点在终端（xterm 的隐藏
   textarea）时走终端选区 / 剪贴板。⌘C/⌘V 由「编辑」菜单与本文件快捷键双路触发 */
function inEditableField(el) {
  if (!el) return false;
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false; // 终端输入区不算
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}
/* 剪贴板读写优先走主进程（无焦点/权限限制），navigator.clipboard 兜底 */
function clipWrite(text) {
  return window.hub.clipWrite ? window.hub.clipWrite(text) : navigator.clipboard.writeText(text);
}
function clipRead() {
  return window.hub.clipRead ? window.hub.clipRead() : navigator.clipboard.readText();
}
function copySelection() {
  const el = document.activeElement;
  if (inEditableField(el)) {
    const s = el.selectionStart, e = el.selectionEnd;
    if (s != null && e != null && s !== e) Promise.resolve(clipWrite(el.value.slice(s, e))).catch(() => {});
    return;
  }
  const p = activePane();
  const sel = p && p.term.getSelection();
  if (!sel) return toast(t('clip.noSelection'), 'info', 1200);
  Promise.resolve(clipWrite(sel))
    .then(() => toast(t('clip.copiedN', sel.length), 'ok', 1000))
    .catch(() => toast(t('clip.copyFailed'), 'err'));
}
async function pasteClipboard() {
  const el = document.activeElement;
  if (inEditableField(el)) {
    const text = await Promise.resolve(clipRead()).catch(() => '');
    if (!text || el.readOnly) return;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.setSelectionRange(s + text.length, s + text.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const p = activePane();
  if (!p) return toast(t('clip.noActiveTerm'), 'warn', 1200);
  const text = await Promise.resolve(clipRead()).catch(() => '');
  if (text) p.term.paste(text); // term.paste 处理括号粘贴与换行归一，经 onData 落到会话
}
function selectAll() {
  const el = document.activeElement;
  if (inEditableField(el)) { el.select(); return; }
  const p = activePane();
  if (p) { p.term.selectAll(); toast(t('clip.selectedAll', MOD_LBL), 'info', 1500); }
}

/* ================= 外观主题切换 ================= */
const THEME_ORDER = ['auto', 'light', 'dark'];
const themeLabel = (m) => ({ auto: t('theme.auto'), light: t('theme.light'), dark: t('theme.dark') })[m];
const THEME_ICON = {
  auto: '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M8 1.3v1.5M8 13.2v1.5M1.3 8h1.5M13.2 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/></svg>',
  dark: '<svg viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M13.8 10.2A6 6 0 0 1 5.8 2.2a.55.55 0 0 0-.73-.7 6.9 6.9 0 1 0 9.4 9.4.55.55 0 0 0-.67-.7z"/></svg>',
};
function updateThemeBtn() {
  const mode = currentThemeMode();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  const btn = $('#btn-theme');
  btn.innerHTML = THEME_ICON[mode] || THEME_ICON.auto;
  btn.title = t('theme.btnTitle', themeLabel(mode), themeLabel(next));
}
function setThemePref(mode) {
  localStorage.setItem('hubterm.theme', mode);
  applyTheme();
  const sel = $('#set-theme');
  if (sel) sel.value = mode;
  updateThemeBtn();
  window.hub.setTheme && window.hub.setTheme(mode); // 主进程记住，下次启动窗口底色直接对
}
function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentThemeMode()) + 1) % THEME_ORDER.length];
  setThemePref(next);
  toast(t('theme.cycled', themeLabel(next)), 'ok', 1200);
}

/* ================= 语言切换 =================
   字典在 lib/i18n.js（与主进程共用）。切换时：静态 DOM 重翻 + 动态区域重渲染
   + 主进程同步（菜单/对话框，settings.json 持久化）。 */
function setLanguage(lang) {
  if (!i18n.setLang(lang)) return;
  document.documentElement.lang = lang;
  i18n.applyDOM(document);
  // 动态生成的常驻 DOM 全部重建
  renderTree($('#search').value);
  renderRecents();
  renderSnippets();
  loadPrefsUI();
  updateThemeBtn();
  updateSidebarBtn();
  mcpRefreshUI();
  for (const [, p] of panesById) {
    p.paneEl.querySelector('.p-close').title = t('pane.close');
    if (p.status === 'connecting' || TERMINAL_STATUSES.includes(p.status)) showPaneOverlay(p);
  }
  for (const [key] of [...ghostTabs]) { const s = sessions.find((x) => x.key === key); if (s) { removeGhost(key); addGhostTab(s); } }
  localizeShortcutHints(); // 翻译后的 ⌘ 提示在非 macOS 上再替换一次
  window.hub.setLang && window.hub.setLang(lang);
  toast(t('lang.switched'), 'ok', 1500);
}

/* ================= 侧栏开关 ================= */
const SIDEBAR_ICON = {
  on: '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3v10" stroke="currentColor" stroke-width="1.3"/><rect x="3" y="5" width="2" height="6" rx=".8" fill="currentColor"/></svg>',
  off: '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3v10" stroke="currentColor" stroke-width="1.3"/><path fill="currentColor" d="M3.1 5.4 5.9 8l-2.8 2.6z"/></svg>',
};
function updateSidebarBtn() {
  const hidden = $('#sidebar').classList.contains('hidden');
  const btn = $('#btn-sidebar');
  btn.innerHTML = hidden ? SIDEBAR_ICON.off : SIDEBAR_ICON.on;
  btn.title = hidden ? t('sidebar.expand', MOD_LBL) : t('sidebar.collapse', MOD_LBL);
}
function toggleSidebar() {
  $('#sidebar').classList.toggle('hidden');
  updateSidebarBtn();
}

/* ================= 菜单/快捷键 ================= */
/* Escape 关闭最上层弹层（各弹窗自己的 keydown 只在焦点位于其内部时才触发，
   全局必须兜底，否则 esc 会失灵并吞掉后续快捷键） */
function closeTopLayer() {
  const order = [
    ['#mcp-approval-modal', () => replyMcpApproval(false)],
    ['#confirm-modal', () => $('#cf-cancel').click()],
    ['#prompt-modal', () => $('#pm-cancel').click()],
    ['#mfa-modal', () => $('#mfa-cancel').click()],
    ['#snippet-modal', () => $('#snm-cancel').click()],
    ['#fwd-modal', () => $('#fwd-close').click()],
    ['#quick-modal', () => $('#qc-cancel').click()],
    ['#edit-modal', () => $('#ed-cancel').click()],
    ['#palette-mask', () => closePalette()],
    ['#help-modal', () => $('#help-modal').classList.add('hidden')],
    ['#findbar', () => $('#findbar').classList.add('hidden')],
    ['#sftp-drawer', () => toggleSftp(false)],
    ['#snippets-panel', () => $('#snippets-panel').classList.add('hidden')],
  ];
  for (const [sel, close] of order) {
    const el = $(sel);
    if (el && !el.classList.contains('hidden')) { close(); return true; }
  }
  return false;
}

function menuAction(action) {
  if (action === 'palette') openPalette();
  else if (action === 'quick-connect') showQuick();
  else if (action === 'new-session') showEdit(null);
  else if (action === 'edit-session') {
    const p = activePane();
    const s = p && sessions.find((x) => x.key === p.info.key);
    if (s) showEdit(s); else toast(t('edit.noSavedSession'), 'warn');
  }
  else if (action === 'close-tab' && activeTabId != null) closeTab(activeTabId);
  else if (action === 'reconnect' && activeTabId != null) tabs.get(activeTabId)?.rows.flat().forEach(reconnectPane);
  else if (action === 'find') showFind();
  else if (action === 'toggle-sidebar') toggleSidebar();
  else if (action === 'clear') { const p = activePane(); if (p) p.term.clear(); }
  else if (action === 'split-right') splitPane('right');
  else if (action === 'split-down') splitPane('down');
  else if (action === 'forwards') openForwards();
  else if (action === 'sftp') toggleSftp();
  else if (action === 'snippets') $('#snippets-panel').classList.toggle('hidden');
  else if (action === 'help') { mcpRefreshUI(); $('#help-modal').classList.remove('hidden'); }
  else if (action === 'font-inc') applyFontSize(1);
  else if (action === 'font-dec') applyFontSize(-1);
  else if (action === 'font-reset') applyFontSize(13, 'set');
  else if (action === 'copy') copySelection();
  else if (action === 'paste') pasteClipboard();
  else if (action === 'select-all') selectAll();
  else if (action === 'theme-cycle') cycleTheme();
}

function wireUI() {
  $('#search').addEventListener('input', (e) => renderTree(e.target.value));

  // 树空白处：右键新建根级文件夹；拖放会话/文件夹到空白处 = 移到根
  const treeEl = $('#tree');
  treeEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.group') || e.target.closest('.sess')) return;
    e.preventDefault();
    showCtx(e, [{ label: t('tree.newFolder'), fn: () => askPrompt(t('tree.newFolderTitle'), t('tree.newFolderMsg'), '', (v) => {
      const name = v.trim();
      if (!name || name.split('/').some((x) => !x)) return toast(t('tree.badName'), 'warn');
      addExtraGroup(name);
      renderTree($('#search').value);
    }) }]);
  });
  treeEl.addEventListener('dragover', (e) => e.preventDefault());
  treeEl.addEventListener('drop', (e) => {
    if (e.target.closest('.group') || e.target.closest('.sess')) return; // 分组行自己处理落点
    e.preventDefault();
    const d = e.dataTransfer.getData('text/plain');
    if (d.startsWith('session:')) {
      const s = sessions.find((x) => x.key === d.slice(8));
      if (s && s.group) dropIntoGroup(e, '');
    } else if (d.startsWith('group:')) {
      const src = d.slice(6);
      if (src.includes('/')) moveGroup(src, src.split('/').pop()); // 提为根级
    }
  });
  $('#btn-new').onclick = () => showEdit(null);
  $('#btn-quick').onclick = showQuick;
  $('#btn-snippets').onclick = () => $('#snippets-panel').classList.toggle('hidden');
  $('#btn-sftp').onclick = () => toggleSftp();
  $('#btn-forwards').onclick = openForwards;
  $('#btn-help').onclick = () => $('#help-modal').classList.remove('hidden');

  // MFA
  $('#mfa-ok').onclick = () => replyMfa($('#mfa-input').value.trim());
  $('#mfa-cancel').onclick = () => replyMfa('');
  $('#mfa-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') replyMfa($('#mfa-input').value.trim());
    if (e.key === 'Escape') replyMfa('');
  });

  // 快速连接
  $('#qc-ok').onclick = doQuickConnect;
  $('#qc-cancel').onclick = () => $('#quick-modal').classList.add('hidden');
  for (const id of ['qc-host', 'qc-port', 'qc-user', 'qc-pass']) {
    $('#' + id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doQuickConnect();
      if (e.key === 'Escape') $('#quick-modal').classList.add('hidden');
    });
  }

  // 编辑会话
  $('#ed-auth').addEventListener('change', syncEditFields);
  $('#w-open').onclick = () => openPalette();
  $('#w-new').onclick = () => showEdit(null);
  $('#ed-rule-add').onclick = () => $('#ed-rules-list').appendChild(ruleRowEl({}));
  $('#ed-ok').onclick = doSaveSession;
  $('#ed-cancel').onclick = () => $('#edit-modal').classList.add('hidden');
  $('#edit-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#edit-modal').classList.add('hidden');
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') doSaveSession();
  });

  // 快捷命令
  $('#sn-add').onclick = () => showSnippetModal(null);
  $('#sn-close').onclick = () => $('#snippets-panel').classList.add('hidden');
  $('#sn-broadcast').addEventListener('change', renderSnippets);
  $('#snm-ok').onclick = saveSnippetModal;
  $('#snm-cancel').onclick = () => $('#snippet-modal').classList.add('hidden');
  $('#snm-cmd').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#snippet-modal').classList.add('hidden'); });

  // SFTP
  $('#sf-close').onclick = () => toggleSftp(false);
  $('#sf-up').onclick = () => sftpState.cwd && sftpLs('..');
  $('#sf-refresh').onclick = () => sftpState.cwd && sftpLs(sftpState.cwd);
  $('#sf-mkdir').onclick = () => askPrompt(t('sftp.newFolder'), t('sftp.folderName'), '', async (name) => {
    if (!name) return;
    try { await window.hub.sftpMkdir(sftpState.sid, sftpState.cwd + '/' + name); sftpLs(sftpState.cwd); } catch (e) { toast(t('sftp.mkdirFailed', e.message), 'err'); }
  });
  $('#sf-upload').onclick = async () => {
    const files = await window.hub.pickUploadFiles();
    if (files.length) uploadFiles(files);
  };
  $('#sf-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpLs($('#sf-path').value.trim()); });
  $('#sf-cancel').onclick = () => {
    if (!sftpState.sid) return;
    sftpState.cancelFlag = true;
    sftpStatus(t('sftp.cancelling'));
    window.hub.sftpCancel(sftpState.sid);
  };
  const drawer = $('#sftp-drawer');
  drawer.addEventListener('dragover', (e) => { e.preventDefault(); drawer.classList.add('sf-dropping'); });
  drawer.addEventListener('dragleave', () => drawer.classList.remove('sf-dropping'));
  drawer.addEventListener('drop', async (e) => {
    e.preventDefault();
    drawer.classList.remove('sf-dropping');
    const files = [...(e.dataTransfer.files || [])].map((f) => window.hub.pathForFile(f)).filter(Boolean);
    if (files.length) uploadFiles(files);
  });

  // 端口转发
  $('#fwd-add-btn').onclick = addForward;
  $('#fwd-close').onclick = () => $('#fwd-modal').classList.add('hidden');
  for (const id of ['fwd-listen', 'fwd-host', 'fwd-port']) {
    $('#' + id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addForward(); });
  }

  // 帮助/设置
  $('#help-close').onclick = () => $('#help-modal').classList.add('hidden');
  $('#btn-help').onclick = () => { mcpRefreshUI(); $('#help-modal').classList.remove('hidden'); };
  $('#set-copy-select').addEventListener('change', (e) => savePref('copySelect', e.target.checked));
  $('#set-bell').addEventListener('change', (e) => savePref('bell', e.target.checked));
  $('#set-restore-mode').addEventListener('change', (e) => window.hub.setRestoreMode(e.target.value));
  $('#set-theme').addEventListener('change', (e) => setThemePref(e.target.value));
  $('#set-lang').addEventListener('change', (e) => setLanguage(e.target.value));

  // MCP（AI Agent 接入）
  $('#mcp-toggle').onclick = mcpToggle;
  $('#mcp-copy-url').onclick = () => { clipWrite($('#mcp-url').textContent).then(() => toast(t('mcp.urlCopied'), 'ok', 1200)); };
  $('#mcp-copy-token').onclick = () => { clipWrite(mcpLastToken).then(() => toast(t('mcp.tokenCopied'), 'ok', 1200)); };
  $('#mcp-show-token').onclick = () => {
    mcpTokenShown = !mcpTokenShown;
    $('#mcp-show-token').textContent = mcpTokenShown ? t('mcp.info.hide') : t('mcp.info.show');
    mcpRefreshUI();
  };
  $('#mcp-regen-token').onclick = () => askConfirm(t('mcp.regenTitle'), t('mcp.regenMsg'), async () => {
    await window.hub.mcpRegenToken();
    toast(t('mcp.regenDone'), 'ok');
    mcpRefreshUI();
  }, t('mcp.info.regen'));
  $('#mcp-mode').addEventListener('change', async (e) => {
    await window.hub.mcpSetMode(e.target.value);
    toast(t('mcp.modeUpdated'), 'ok', 1200);
  });
  $('#mcp-ap-approve').onclick = () => replyMcpApproval(true);
  $('#mcp-ap-deny').onclick = () => replyMcpApproval(false);

  $('#btn-theme').onclick = cycleTheme;
  updateThemeBtn();
  $('#btn-sidebar').onclick = toggleSidebar;
  updateSidebarBtn();

  // 确认/输入弹窗
  $('#cf-ok').onclick = () => { $('#confirm-modal').classList.add('hidden'); confirmFn && confirmFn(); confirmFn = null; };
  $('#cf-cancel').onclick = () => { $('#confirm-modal').classList.add('hidden'); confirmFn = null; };
  $('#pm-ok').onclick = () => { $('#prompt-modal').classList.add('hidden'); promptFn && promptFn($('#pm-input').value.trim()); promptFn = null; };
  $('#pm-cancel').onclick = () => { $('#prompt-modal').classList.add('hidden'); promptFn = null; };
  $('#pm-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { $('#prompt-modal').classList.add('hidden'); promptFn && promptFn($('#pm-input').value.trim()); promptFn = null; }
  });

  // 快速打开面板
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value.trim()));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
    else if (e.key === 'Enter') { const s = palItems[palSelected]; if (s) { closePalette(); openSession(s); } }
    else if (e.key === 'Escape') closePalette();
  });
  $('#palette-mask').addEventListener('mousedown', (e) => { if (e.target === $('#palette-mask')) closePalette(); });

  // ZMODEM
  $('#zm-cancel').onclick = () => { const p = activePane(); if (p) window.hub.zmodemCancel(p.sid); };

  // 搜索条
  $('#find-input').addEventListener('input', findFirst);
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.shiftKey ? doFind('prev') : doFind('next'); }
    if (e.key === 'Escape') $('#findbar').classList.add('hidden');
  });
  $('#find-next').onclick = () => doFind('next');
  $('#find-prev').onclick = () => doFind('prev');
  $('#find-close').onclick = () => $('#findbar').classList.add('hidden');

  document.addEventListener('click', (e) => { if (!$('#ctx-menu').contains(e.target)) hideCtx(); });

  // 侧栏拖拽调宽：悬停手柄高亮，松手记住宽度，双击复位
  {
    const sidebar = $('#sidebar'), resizer = $('#side-resizer');
    const SIDE_MIN = 180, SIDE_MAX = 480, SIDE_DEFAULT = 250, COLLAPSE_AT = 120;
    let fitPending = false;
    const refitPanes = () => { // 拖动过程中按帧节流，终端跟随 reflow
      if (fitPending) return;
      fitPending = true;
      requestAnimationFrame(() => {
        fitPending = false;
        for (const [, p] of panesById) { try { p.fit.fit(); } catch (e) {} }
      });
    };
    const setSideWidth = (w, persist) => {
      w = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));
      sidebar.style.width = w + 'px';
      refitPanes();
      if (persist) localStorage.setItem('hubterm.sideWidth', String(w));
    };
    const savedW = parseInt(localStorage.getItem('hubterm.sideWidth'), 10);
    if (savedW) setSideWidth(savedW);
    // 拖到阈值以下整个收起（记住收起前宽度）；收起后左缘留 5px 拖出条，往右拖即展开
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      document.body.classList.add('side-resizing');
      let collapsed = false;
      const onMove = (ev) => {
        const w = ev.clientX; // 侧栏贴着窗口左缘，光标 x 即目标宽度
        if (w < COLLAPSE_AT) {
          if (!collapsed) {
            collapsed = true;
            setSideWidth(Math.max(SIDE_MIN, sidebar.offsetWidth), true); // 先记下收起前宽度
            sidebar.classList.add('hidden');
            updateSidebarBtn();
            refitPanes();
          }
          return;
        }
        if (collapsed) { collapsed = false; sidebar.classList.remove('hidden'); updateSidebarBtn(); }
        setSideWidth(w);
      };
      const onUp = () => {
        resizer.classList.remove('dragging');
        document.body.classList.remove('side-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!collapsed) setSideWidth(sidebar.offsetWidth, true);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    resizer.addEventListener('dblclick', () => {
      sidebar.classList.remove('hidden');
      updateSidebarBtn();
      setSideWidth(SIDE_DEFAULT, true);
    });
  }

  // 标签条溢出：滚动条已隐藏，这里补齐滚动入口与状态提示
  {
    const tabsEl = $('#tabs');
    const updateFade = () => {
      tabsEl.classList.toggle('can-left', tabsEl.scrollLeft > 1);
      tabsEl.classList.toggle('can-right', tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 1);
    };
    tabsEl.addEventListener('scroll', updateFade, { passive: true });
    // 尺寸变化（窗口缩放、侧栏拖宽）与标签增删/排序都要重算渐隐
    new ResizeObserver(updateFade).observe(tabsEl);
    new MutationObserver(updateFade).observe(tabsEl, { childList: true });
    // 鼠标滚轮映射为横滚（原生 deltaY→deltaX 的 shift+滚轮场景直接放行）
    tabsEl.addEventListener('wheel', (e) => {
      if (!e.deltaY || tabsEl.scrollWidth <= tabsEl.clientWidth + 1) return;
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
    // 拖拽排序时悬停条缘自动横滚，保证能拖到首尾标签
    tabsEl.addEventListener('dragover', (e) => {
      const r = tabsEl.getBoundingClientRect();
      if (e.clientX < r.left + 28) tabsEl.scrollLeft -= 10;
      else if (e.clientX > r.right - 28) tabsEl.scrollLeft += 10;
    });
    updateFade();
  }


  // 全局快捷键
  window.addEventListener('keydown', async (e) => {
    const inModal = !$('#mfa-modal').classList.contains('hidden') ||
                    !$('#quick-modal').classList.contains('hidden') ||
                    !$('#edit-modal').classList.contains('hidden') ||
                    !$('#snippet-modal').classList.contains('hidden') ||
                    !$('#fwd-modal').classList.contains('hidden') ||
                    !$('#confirm-modal').classList.contains('hidden') ||
                    !$('#prompt-modal').classList.contains('hidden') ||
                    !$('#mcp-approval-modal').classList.contains('hidden') ||
                    !$('#palette-mask').classList.contains('hidden');
    if (e.key === 'Escape') { closeTopLayer(); hideCtx(); return; }
    // 只有弹窗内不抢（各弹窗自带 Enter/Esc 处理）；SELECT 聚焦留给原生键盘导航。
    // 终端与输入框都放行 ⌘ 组合键：⌘C/⌘V/⌘A 在处理器内按焦点各自路由，其余快捷键随处可用
    if (inModal || e.target.tagName === 'SELECT') return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'p' || k === 't') { e.preventDefault(); openPalette(); }
    else if (k === 'n' && e.shiftKey) { e.preventDefault(); showEdit(null); }
    else if (k === 'n') { e.preventDefault(); showQuick(); }
    else if (k === 'e') { e.preventDefault(); menuAction('edit-session'); }
    else if (k === 'w') { e.preventDefault(); if (activeTabId != null) closeTab(activeTabId); }
    else if (k === 'r') { e.preventDefault(); if (activeTabId != null) tabs.get(activeTabId)?.rows.flat().forEach(reconnectPane); }
    else if (k === 'f' && e.shiftKey) { e.preventDefault(); toggleSftp(); }
    else if (k === 'f') { e.preventDefault(); showFind(); }
    else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (k === 'k' && e.shiftKey) { e.preventDefault(); $('#snippets-panel').classList.toggle('hidden'); }
    else if (k === 'k') { e.preventDefault(); const p = activePane(); if (p) p.term.clear(); }
    else if (k === 'l') { e.preventDefault(); openForwards(); }
    else if (k === 'd' && e.shiftKey) { e.preventDefault(); splitPane('down'); }
    else if (k === 'd') { e.preventDefault(); splitPane('right'); }
    else if (k === '=' || k === '+') { e.preventDefault(); applyFontSize(1); }
    else if (k === '-') { e.preventDefault(); applyFontSize(-1); }
    else if (k === '0') { e.preventDefault(); applyFontSize(13, 'set'); }
    else if (k === '/' ) { e.preventDefault(); $('#help-modal').classList.remove('hidden'); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (k === 'a') { e.preventDefault(); selectAll(); }
    else if (/^[1-9]$/.test(k)) {
      const t = tabOrder()[parseInt(k, 10) - 1];
      if (t) { e.preventDefault(); setActiveTab(t.id); }
    }
  });
}

init();
