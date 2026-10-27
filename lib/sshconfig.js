'use strict';
// ~/.ssh/config 解析与导入：Host 块 -> HubTerm 会话（直连，密钥/密码认证）
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseSSHConfig(text) {
  const hosts = [];
  let cur = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(Host|HostName|User|Port|IdentityFile|ProxyJump)\s+(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') {
      cur = { aliases: val.split(/\s+/).filter((a) => a && !/[*?!]/.test(a)) };
      if (cur.aliases.length) hosts.push(cur);
      else cur = null; // 纯通配块跳过
    } else if (cur) {
      cur[key] = val;
    }
  }
  return hosts;
}

/** 转为 HubTerm 会话（不落盘；密码留空由用户补充） */
function toSessions(parsed, existingKeys) {
  const out = [];
  for (const h of parsed) {
    const alias = h.aliases[0];
    const host = h.hostname || alias;
    if (!host) continue;
    let group = 'ssh-config';
    // ProxyJump 场景归入「跳板」分组并记录 jumpKey 线索（值为 host:port 字符串，导入后再关联）
    if (h.proxyjump) group = 'ssh-config/跳板';
    const key = `${group}/${alias}`;
    if (existingKeys && existingKeys.has(key)) continue;
    out.push({
      key,
      name: alias,
      group,
      type: 'direct',
      host,
      port: parseInt(h.port, 10) || 22,
      user: h.user || os.userInfo().username || 'root',
      target: host,
      tuser: '',
      post: '',
      password: '',
      auth: h.identityfile ? 'key' : 'password',
      keyPath: h.identityfile ? h.identityfile.replace(/^~(?=\/|$)/, os.homedir()) : '',
      keyPass: '',
      jumpKey: '', // ProxyJump 的机器建议先导入为普通会话，再在此会话编辑里选择跳板
      _proxyjump: h.proxyjump || '',
    });
  }
  return out;
}

/** 导入入口：读取文件 -> 解析 -> 合并入现有会话列表（同名跳过） */
function importFromFile(file, existing) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseSSHConfig(text);
  const existingKeys = new Set((existing || []).map((s) => s.key));
  return toSessions(parsed, existingKeys);
}

module.exports = { parseSSHConfig, toSessions, importFromFile };
