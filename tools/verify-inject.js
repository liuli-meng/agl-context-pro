#!/usr/bin/env node
/**
 * 校验 app.asar 里 dist/preload.js 的注入状态。
 *
 * asar 格式（实测读法，之前算错过一次）：
 *   readUInt32LE(4)  = headerSize
 *   readUInt32LE(12) = jsonSize
 *   JSON 从 offset 16 开始，长度 jsonSize
 *   blob 基准 = 8 + headerSize
 *
 *   node tools/verify-inject.js [app.asar 路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ASAR = process.argv[2] || 'D:\\Antigravity\\app\\resources\\app.asar';

const buf = fs.readFileSync(ASAR);
const headerSize = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize));
const blobBase = 8 + headerSize;

function readFile(p) {
  const node = p.split('/').reduce((acc, seg) => (acc && acc.files ? acc.files[seg] : null), header);
  if (!node || node.size == null) return null;
  const off = blobBase + parseInt(node.offset, 10);
  return buf.toString('utf8', off, off + node.size);
}

const preload = readFile('dist/preload.js');
if (!preload) {
  console.log('找不到 dist/preload.js');
  process.exit(1);
}

const count = (re) => (preload.match(re) || []).length;

const checks = [
  ['标记 START', count(/\[START\] Antigravity 上下文用量悬浮面板/g), 1],
  ['标记 END', count(/\[END\] Antigravity 上下文用量悬浮面板/g), 1],
  ['新代码 tailSteps', count(/function tailSteps\(/g), 1],
  ['新取数（单次调用）', count(/只调用一次\*\*，超长会话在尾部截断/g) >= 1 ? 1 : 0, 1],
  ['旧取数残留（分批 50 注释）', count(/拉一个轨迹的全部步骤：分批 50/g), 0],
  ['旧常量残留（BATCH/CONCURRENCY）', count(/var BATCH = 50, CONCURRENCY = 5;/g), 0],
  ['规则行新文案', count(/Rules \/ Skills（已计入）/g), 1],
];

let bad = 0;
console.log('preload.js 长度 :', preload.length, '字节');
console.log('');
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✔' : '✖'} ${name.padEnd(30, ' ')} ${got}（期望 ${want}）`);
}

// 顺带报一下 asar 里其余 ranges.push 是谁的（排除 AGL 之外的可疑残留）
if (count(/ranges\.push/g)) {
  console.log('\n注：preload.js 里 ranges.push 出现', count(/ranges\.push/g), '次（非 AGL 代码，应为宿主自带）');
}

console.log(bad ? `\n有 ${bad} 项不符` : '\n注入校验通过');
process.exit(bad ? 1 : 0);
