'use strict';
// 渲染层静态审计：app.js 引用的 DOM id 必须都在 index.html 中存在。
// 背景：v2.0 曾因 syncEditFields 引用了未定义的 label id 导致"编辑弹窗打不开"，
// 而这类错误 JS 语法检查和引擎测试都发现不了。
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');

const ids = new Set();
for (const m of js.matchAll(/\$\('#([a-zA-Z0-9-]+)'\)/g)) ids.add(m[1]);          // $('#id') 形式
for (const m of js.matchAll(/\['([a-zA-Z0-9-]+-[a-zA-Z0-9-]+)',/g)) ids.add(m[1]); // 数组元素形式 ['ed-xxx', ...]

const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
if (missing.length) {
  console.error(`✗ FAIL  DOM id 审计: app.js 引用了 HTML 中不存在的 id → ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✓ PASS  DOM id 审计（${ids.size} 个引用全部存在）`);
