#!/usr/bin/env node
/**
 * i18n 体检：确认中英两套文案没有漏、没漂移。
 *
 * 跑法：node tools/i18n-check.js
 *
 * 🔴 为什么需要这个脚本（而不是靠人肉检查）：
 *   漏翻译最危险的地方不是「英文界面里出现一个 key」——
 *   那个反而一眼看得见。真正危险的是**词典里根本没有那个 key**：
 *   `t()` 会静默回退到中文，于是英文界面里悄悄夹着中文，
 *   而所有检查（语法、启动、点按钮）都是绿的。
 *   这类问题只能靠机械比对发现。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const problems = [];
function bad(msg) { fail++; problems.push(msg); }

// ---------------------------------------------------------------- 词典解析
const i18nSrc = readFileSync(join(ROOT, 'web/js/i18n.js'), 'utf8');
const zhBody = i18nSrc.split('zh: {')[1]?.split('\n  },\n\n  en: {')[0] || '';
const enBody = i18nSrc.split('\n  en: {')[1]?.split('\n  },\n};')[0] || '';

const grab = (s) => {
  const m = new Map();
  const re = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  let g;
  while ((g = re.exec(s))) m.set(g[1], g[2]);
  return m;
};
const ZH = grab(zhBody);
const EN = grab(enBody);

console.log(`词典：中文 ${ZH.size} 条 / 英文 ${EN.size} 条`);

if (ZH.size === 0 || EN.size === 0) bad('词典解析失败——i18n.js 结构变了？');
for (const k of ZH.keys()) if (!EN.has(k)) bad(`英文缺翻译: ${k}`);
for (const k of EN.keys()) if (!ZH.has(k)) bad(`中文缺翻译: ${k}`);

// 占位符一致性：{name} 在两边必须都存在，且名字相同。
// 不一致的后果是「英文界面里露出 {speed} 这种原始占位符」。
for (const [k, zhV] of ZH) {
  const enV = EN.get(k);
  if (enV === undefined) continue;
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  if (ph(zhV) !== ph(enV)) {
    bad(`占位符不一致 ${k}: 中[${ph(zhV)}] vs 英[${ph(enV)}]`);
  }
  if (zhV.includes('{{host}}') !== enV.includes('{{host}}')) {
    bad(`{{host}} 占位符不成对: ${k}`);
  }
}

// ---------------------------------------------------------------- HTML 引用
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const used = new Set();
for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1].trim());
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of m[1].split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) used.add(pair.slice(i + 1).trim());
  }
}
for (const k of used) if (!ZH.has(k)) bad(`index.html 引用了词典里没有的 key: ${k}`);
console.log(`index.html 引用 ${used.size} 个 key`);

// ---------------------------------------------------------------- JS 引用
const jsFiles = ['app.js', 'render.js', 'transform.js']
  .map((f) => join(ROOT, 'web/js', f));
let tCalls = 0;
for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  // t('key') 调用（排除 t() 定义与 tr 别名）
  for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
    tCalls++;
    if (!ZH.has(m[1])) bad(`${f.split('/').pop()} 用了不存在的 key: ${m[1]}`);
  }
}
console.log(`JS 中 t() 调用 ${tCalls} 处`);

// ---------------------------------------------------------------- 残留中文
// 只扫「会显示给用户的字符串字面量」，不扫注释、不扫词典本身。
//
// ⚠️ i18n.js 本身要排除：它的中文**就是正确内容**（中文词典），
//    把它算进来会报 230 条假问题。
// ⚠️ render.js 的 console.* 与 debug 提示也排除：那是给开发者看的，
//    不是给操作者看的，翻译它没有收益、只会增加维护面。
const CJK = /[一-鿿]/;
const SKIP_FILE = new Set(['i18n.js']);
for (const f of jsFiles) {
  const base = f.split('/').pop();
  if (SKIP_FILE.has(base)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  let inBlock = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; return; }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    // 开发调试输出不面向操作者，跳过
    if (/console\.(log|error|warn|debug)\s*\(/.test(line)) return;
    const code = line.replace(/\/\/.*$/, '');
    if (!CJK.test(code)) return;
    for (const m of code.matchAll(/(['"`])([^'"`]*)\1/g)) {
      if (CJK.test(m[2])) {
        bad(`${base}:${i + 1} 字符串里仍有中文: "${m[2].slice(0, 46)}"`);
      }
    }
  });
}

// ---------------------------------------------------------------- 汇总
console.log('');
if (fail) {
  console.log('═══════════════════════════════════════');
  console.log(`  i18n 体检未通过：${fail} 处问题`);
  console.log('───────────────────────────────────────');
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('═══════════════════════════════════════');
  process.exit(1);
}
console.log(`  ✓ i18n 体检通过：${ZH.size} 条文案，中英完全对齐，无残留中文`);
console.log('═══════════════════════════════════════');
