'use strict';
// 主流终端工具会话导入解析器：SecureCRT(.ini) / Xshell(.xsh) / MobaXterm(.mxtsessions)
// / PuTTY(.reg) / CSV·主机清单。纯文本确定性解析，不猜不试连——认不出的文本明确报告「未识别」，
// 绝不硬凑会话。密码在各格式中均为密文且机器绑定，一律不解析（导入后用户首次连接时输入）。
const fs = require('fs');
const path = require('path');

/* ---------- 编码：SecureCRT=ANSI/UTF-8；Xshell 常见 UTF-16LE（带或不带 BOM） ---------- */
function decodeText(buf) {
  if (!buf || buf.length < 2) return String(buf || '');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf);
    le.swap16(); // 转成 LE 再解码
    return le.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').replace(/^\uFEFF/, '');
  // 无 BOM 的 UTF-16：NUL 字节密度判别（ASCII 段每字符隔一个 0）
  let nul = 0;
  const scan = Math.min(buf.length, 4096);
  for (let i = 1; i < scan; i += 2) if (buf[i] === 0) nul++;
  if (nul > scan / 8) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/* ---------- 通用 ini（含 Xshell 反斜杠子段）→ [{section, key, value}] ---------- */
function parseIni(text) {
  const out = [];
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[([^[\]]+)\]$/);
    if (sec) { section = sec[1]; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv) out.push({ section, key: kv[1].trim(), value: kv[2].trim() });
  }
  return out;
}

function iniGet(entries, section, key) {
  const hit = entries.find((e) => e.section === section && e.key.toLowerCase() === key.toLowerCase());
  return hit ? hit.value : '';
}

/* ---------- SecureCRT：单会话 .ini，S:"Key"=val / D:"Key"=hex ---------- */
function parseSecureCRT(text) {
  const dict = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^(S|D):"([^"]+)"=(.*)$/);
    if (m) dict[m[2]] = m[3].trim();
  }
  const host = dict['Hostname'];
  if (!host) return null;
  // D: 值为十六进制字符串（如 00000016=22）；异常回退 22
  let port = parseInt(dict['[SSH2] Port'], 16);
  if (!(port >= 1 && port <= 65535)) port = 22;
  const keyPath = dict['Identity File V2'] || dict['Identity File'] || '';
  return {
    name: '', // 由调用方用文件名补
    group: '',
    host,
    port,
    user: dict['Username'] || '',
    auth: keyPath ? 'key' : 'password',
    keyPath,
  };
}

/* ---------- Xshell .xsh：[Connection]Host/Port + [Connection\Authentication]UserName ---------- */
function parseXshell(text) {
  const entries = parseIni(text);
  const host = iniGet(entries, 'Connection', 'Host');
  if (!host) return null;
  let port = parseInt(iniGet(entries, 'Connection', 'Port'), 10);
  if (!(port >= 1 && port <= 65535)) port = 22;
  const protocol = iniGet(entries, 'Connection', 'Protocol') || 'SSH';
  if (!/^ssh$/i.test(protocol)) return null; // 只导 SSH（telnet/serial 不支持）
  const user = iniGet(entries, 'Connection\\Authentication', 'UserName')
    || iniGet(entries, 'CONNECTION_INFO', 'User') || '';
  const keyPath = iniGet(entries, 'Connection\\Authentication', 'UserKey') || '';
  return { name: '', group: '', host, port, user, auth: keyPath ? 'key' : 'password', keyPath };
}

/* ---------- MobaXterm .mxtsessions：SessionName= #109#0%host%port%user%... ---------- */
function parseMobaXterm(text) {
  const out = [];
  let group = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^\[(Bookmarks[^[\]]*)\]$/i);
    if (sec) {
      // Bookmarks / Bookmarks_N（N=数字）是默认书签集不算文件夹；命名段才作为分组
      const g = sec[1].replace(/^bookmarks[\s_-]?/i, '').replace(/_/g, ' ').trim();
      group = g && !/^\d+$/.test(g) ? g : '';
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (!kv) continue;
    const v = kv[2];
    const idx = v.indexOf('#109#0%'); // 109=SSH 会话类型
    if (idx < 0) continue;
    const f = v.slice(idx + 7).split('%'); // #109#0% 之后：host%port%user%...
    const host = (f[0] || '').trim();
    if (!host) continue;
    let port = parseInt(f[1], 10);
    if (!(port >= 1 && port <= 65535)) port = 22;
    out.push({
      name: kv[1].trim(),
      group,
      host,
      port,
      user: (f[2] || '').trim(),
      auth: 'password',
      keyPath: '',
    });
  }
  return out;
}

/* ---------- PuTTY .reg 导出：[...\Sessions\名字] + "HostName"="x" ---------- */
function parsePutty(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[[^\]]*[\\/]Sessions[\\/]([^\]/]+)\]$/i);
    if (sec) {
      if (cur && cur.host) out.push(cur); // reg 无块结束符：下一个段头即上一会话终点
      let name = sec[1];
      try { name = decodeURIComponent(name); } catch (e) { /* 保留原名 */ }
      cur = { name, group: '', host: '', port: 22, user: '', auth: 'password', keyPath: '' };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^"([^"]+)"="(.*)"$/);
    const dw = line.match(/^"([^"]+)"=dword:([0-9a-fA-F]+)$/);
    if (kv) {
      if (kv[1] === 'HostName') { cur.host = kv[2].trim(); if (kv[2].includes('@')) { const [u, h] = kv[2].split('@'); cur.user = u; cur.host = h; } }
      else if (kv[1] === 'UserName') cur.user = kv[2].trim();
      else if (kv[1] === 'Protocol' && !/^ssh$/i.test(kv[2].trim())) cur = null; // 只导 SSH
      else if (kv[1] === 'PublicKeyFile') { cur.keyPath = kv[2].trim(); cur.auth = 'key'; }
    } else if (dw && dw[1] === 'PortNumber') {
      const p = parseInt(dw[2], 16);
      if (p >= 1 && p <= 65535) cur.port = p;
    }
  }
  if (cur && cur.host) out.push(cur);
  return out.filter((s) => s.host);
}

/* ---------- CSV / 主机清单：host,port,user,name / user@host:port / 裸主机 ---------- */
function parseHostList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line) || /^(host|name|ip)\b/i.test(line)) continue; // 跳过表头行
    let m = line.match(/^ssh\s+(\S+)@([\w.-]+)(?:\s+-p\s+(\d+))?/i);
    if (m) { out.push(mkHost(m[2], m[3], m[1].split('@')[0])); continue; }
    m = line.match(/^([\w.-]+)@([\w.-]+):(\d+)$/);
    if (m) { out.push(mkHost(m[2], m[3], m[1])); continue; }
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length >= 1 && /^[\w.-]+$/.test(cols[0])) {
      const host = cols[0];
      const port = cols[1] && /^\d+$/.test(cols[1]) ? cols[1] : '';
      const user = cols[2] || '';
      const name = cols[3] || host;
      out.push({ name, group: '', host, port: toPort(port), user, auth: 'password', keyPath: '' });
    }
  }
  return out;
}
function mkHost(host, port, user) {
  return { name: host, group: '', host, port: toPort(port), user: user || '', auth: 'password', keyPath: '' };
}
function toPort(v) {
  const p = parseInt(v, 10);
  return p >= 1 && p <= 65535 ? p : 22;
}

/* ---------- 单文件解析：按扩展名定向，签名不符依次回退，最后落主机清单 ---------- */
function parseContent(fileName, text) {
  const ext = path.extname(fileName || '').toLowerCase();
  let items = null;
  let fmt = '';
  const single = (fn) => {
    try {
      const v = fn(text);
      return v ? [v] : null; // SecureCRT/Xshell 单会话格式：null=签名不符或非 SSH
    } catch (e) { return null; }
  };
  if (ext === '.ini' || text.includes('S:"')) {
    const v = single(parseSecureCRT);
    if (v) { items = v; fmt = 'securecrt'; }
  }
  if (!items && (ext === '.xsh' || text.includes('[Connection]'))) {
    const v = single(parseXshell);
    if (v) { items = v; fmt = 'xshell'; }
  }
  if (!items && (ext === '.mxtsessions' || text.includes('#109#0%'))) {
    items = parseMobaXterm(text); fmt = 'mobaxterm';
  }
  if (!items && (ext === '.reg' || /PuTTY\\Sessions/i.test(text))) {
    items = parsePutty(text); fmt = 'putty';
  }
  if (!items) { items = parseHostList(text); fmt = items.length ? 'csv' : 'text'; }
  return items.map((s) => ({ ...s, source: fmt, file: fileName }));
}

/* ---------- 目录/多文件入口：主进程 IPC import:parse 调用 ---------- */
const MAX_FILES = 200;
const MAX_SIZE = 1024 * 1024;

function walkDir(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, out);
    else if (/\.(ini|xsh|mxtsessions|reg|csv|txt)$/i.test(ent.name)) out.push(full);
  }
}

/** 解析一组文件/目录 → { items:[{name,group,host,port,user,auth,keyPath,source,file}], unrecognized:[{file,text}] } */
function parseFiles(paths) {
  const files = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    let st = null;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walkDir(p, files);
    else files.push(p);
    if (files.length >= MAX_FILES) break;
  }
  const items = [];
  const unrecognized = [];
  let truncated = false;
  for (const f of files.slice(0, MAX_FILES)) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { continue; }
    if (buf.length > MAX_SIZE) { truncated = true; continue; }
    const text = decodeText(buf);
    const parsed = parseContent(path.basename(f), text);
    if (parsed.length) items.push(...parsed);
    else unrecognized.push({ file: f, text: text.slice(0, 24000) });
  }
  // 文件内+跨文件去重（group/name 相同只留首条）
  const seen = new Set();
  const deduped = items.filter((s) => {
    const k = (s.group || '') + '/' + (s.name || s.host);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { items: deduped, unrecognized, warnings: truncated ? ['max-files'] : [] };
}

module.exports = { decodeText, parseSecureCRT, parseXshell, parseMobaXterm, parsePutty, parseHostList, parseContent, parseFiles };
