'use strict';
// 轻量 JSON 存储：snippets / forwards / known_hosts / 备份导出导入
const fs = require('fs');
const path = require('path');
const os = require('os');

// HUBTERM_HOME：测试/CI 隔离数据目录（默认 ~/.hubterm；与 sessions.js 保持一致）
const DATA_DIR = process.env.HUBTERM_HOME ? path.resolve(process.env.HUBTERM_HOME) : path.join(os.homedir(), '.hubterm');
const FILES = {
  snippets: path.join(DATA_DIR, 'snippets.json'),
  forwards: path.join(DATA_DIR, 'forwards.json'),
  knownHosts: path.join(DATA_DIR, 'known_hosts.json'),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // 原子写
}

/* ---------- snippets: [{id,name,command}] ---------- */
function listSnippets() { return readJson(FILES.snippets, []); }
function saveSnippets(list) { writeJson(FILES.snippets, list); }

/* ---------- forwards: { sessionKey: [{id, listen, host, port, enabled}] } ---------- */
function listForwards() { return readJson(FILES.forwards, {}); }
function saveForwards(map) { writeJson(FILES.forwards, map); }
function forwardsFor(key) { return listForwards()[key] || []; }

/* ---------- known hosts: { "host:port": fingerprint } ---------- */
function listKnownHosts() { return readJson(FILES.knownHosts, {}); }
function saveKnownHosts(map) { writeJson(FILES.knownHosts, map); }

/* ---------- 备份导出/导入（sessions 由调用方传入） ---------- */
function exportSessions(sessions) {
  return JSON.stringify({ app: 'hubterm', version: 1, exportedAt: new Date().toISOString(), sessions }, null, 2);
}
// 合并导入：同名 key 覆盖，其余保留。返回 {added, updated, total}
function importSessions(current, imported) {
  if (!imported || !Array.isArray(imported.sessions)) throw new Error('文件格式不正确');
  const byKey = new Map(current.map((s) => [s.key, s]));
  let added = 0, updated = 0;
  for (const s of imported.sessions) {
    if (!s || !s.key || !s.host) continue;
    if (byKey.has(s.key)) {
      const old = byKey.get(s.key);
      // 导入的密码为空则保留原密码
      byKey.set(s.key, { ...old, ...s, password: s.password || old.password });
      updated++;
    } else {
      byKey.set(s.key, s);
      added++;
    }
  }
  return { merged: [...byKey.values()], added, updated };
}

module.exports = {
  DATA_DIR, FILES,
  listSnippets, saveSnippets,
  listForwards, saveForwards, forwardsFor,
  listKnownHosts, saveKnownHosts,
  exportSessions, importSessions,
};
