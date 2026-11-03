'use strict';
// i18n 字典一致性审计：中英 key 集合一致、值非空、占位符对齐且连续、回退链、
// 以及「代码里引用的 key 必须真实存在」的全量接线审计（main.js/lib/*.js/renderer/app.js 的
// t('…') 字面量 + index.html 的 data-i18n* 属性）。任何一侧漏译/错占位符/裸 key 在这里直接失败，
// 不等到界面上露馅。
const fs = require('fs');
const path = require('path');
const i18n = require('../lib/i18n');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? '✓ PASS ' : '✗ FAIL ') + name + (pass ? '' : `  (${detail || ''})`));
}

const zh = i18n.STRINGS['zh-CN'];
const en = i18n.STRINGS.en;

// 1. key 集合完全一致（双向）
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));
const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
ok('字典: 中英 key 集合一致', onlyZh.length === 0 && onlyEn.length === 0,
  `仅中文: ${onlyZh.slice(0, 5).join(',')} 仅英文: ${onlyEn.slice(0, 5).join(',')}`);

// 2. 值非空、类型为字符串
const empty = Object.keys(zh).filter((k) => !String(zh[k]).trim() || !String(en[k] || '').trim());
ok('字典: 无空值', empty.length === 0, empty.slice(0, 5).join(','));

// 3. 占位符集合一致（{0}{1}...），且序号从 0 连续
function placeholders(s) {
  return String(s).match(/\{(\d)\}/g) || [];
}
const phBad = [];
for (const k of zhKeys) {
  const a = new Set(placeholders(zh[k]).sort());
  const b = new Set(placeholders(en[k]).sort());
  if (a.size !== b.size || [...a].some((x) => !b.has(x))) phBad.push(k);
  const nums = [...a].map((x) => Number(x.slice(1, -1))).sort((x, y) => x - y);
  if (nums.some((n, i) => n !== i)) phBad.push(k + '(非连续)');
}
ok('字典: 占位符中英对齐且连续', phBad.length === 0, phBad.slice(0, 5).join(','));

// 4. t() 回退链与切换
ok('回退: 缺 key 返回 key 本身', i18n.t('__nonexistent_key__') === '__nonexistent_key__');
i18n.setLang('en');
ok('切换: setLang(en) 生效', i18n.getLang() === 'en' && i18n.t('menu.file') === en['menu.file']);
i18n.setLang('zh-CN');
ok('切回: setLang(zh-CN) 生效', i18n.getLang() === 'zh-CN' && i18n.t('menu.file') === zh['menu.file']);

// 5. 代码引用接线审计：main.js / lib/*.js / renderer/app.js 里 t('…') 字面量都必须在字典里
const root = path.join(__dirname, '..');
const codeFiles = [
  path.join(root, 'main.js'),
  // lib/i18n.js 是字典本身（头注释里有 t('key') 示例），不是消费方，排除
  ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => path.join(root, 'lib', f)),
  path.join(root, 'renderer', 'app.js'),
];
const usedKeys = new Set();
for (const f of codeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) usedKeys.add(m[1]);
}
const missingUsed = [...usedKeys].filter((k) => !zhKeys.has(k));
ok(`接线: 代码 t() 引用的 ${usedKeys.size} 个 key 全部存在`, missingUsed.length === 0, missingUsed.slice(0, 8).join(','));

// 6. 静态节点接线审计：index.html 的 data-i18n / -title / -placeholder / -html 全部在字典里
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const domKeys = new Set();
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-html)?="([^"]+)"/g)) domKeys.add(m[1]);
const missingDom = [...domKeys].filter((k) => !zhKeys.has(k));
ok(`接线: index.html data-i18n* 的 ${domKeys.size} 个 key 全部存在`, missingDom.length === 0, missingDom.slice(0, 8).join(','));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
