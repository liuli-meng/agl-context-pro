/**
 * Antigravity 上下文用量悬浮面板 —— 注入器
 *
 * 把 src/panel.js 追加进 app.asar 内的 dist/preload.js。
 * 复用 Antigravity-CN 的 PrecisionPatcher（字节级补丁，保留 SHA-256 校验头），
 * 与汉化补丁互不干扰（各自有独立的 START/END 标记）。
 *
 * 用法：
 *   node inject.js install [--path <app.asar>]
 *   node inject.js uninstall [--path <app.asar>]
 *   node inject.js status [--path <app.asar>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PrecisionPatcher = require('./precision-patcher');

const MARK_START = '/* === [START] Antigravity 上下文用量悬浮面板 === */';
const MARK_END = '/* === [END] Antigravity 上下文用量悬浮面板 === */';

const CANDIDATES = [
  'D:\\Antigravity\\app\\resources\\app.asar',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar')
    : null,
  process.env.PROGRAMFILES
    ? path.join(process.env.PROGRAMFILES, 'Antigravity', 'resources', 'app.asar')
    : null,
].filter(Boolean);

function resolveAsar(custom) {
  if (custom) return fs.existsSync(custom) ? custom : null;
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) { /* ignore */ }
  }
  return null;
}

/** 从 asar 里读出 dist/preload.js 的文本 */
function readPreload(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const pre = Buffer.alloc(16);
    fs.readSync(fd, pre, 0, 16, 0);
    const headerSize = pre.readUInt32LE(4);
    const jsonSize = pre.readUInt32LE(12);
    const baseOffset = 8 + headerSize;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const dist = (header.files || {}).dist || {};
    const entry = (dist.files || {})['preload.js'];
    if (!entry) return null;
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, baseOffset + parseInt(entry.offset, 10));
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function stripBlock(text) {
  const re = new RegExp(
    MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '[\\s\\S]*?'
    + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(re, '').trimEnd();
}

function status(customPath) {
  const asar = resolveAsar(customPath);
  if (!asar) return { found: false };
  const text = readPreload(asar) || '';
  return {
    found: true,
    asar,
    panel: text.includes(MARK_START),
    i18n: text.includes('__ANTIGRAVITY_CN__'),
  };
}

function install(customPath) {
  const asar = resolveAsar(customPath);
  if (!asar) {
    console.error('❌ 未找到 app.asar，请用 --path 指定');
    process.exit(1);
  }
  console.log('📦 目标: ' + asar);

  const origBak = asar + '.bak';
  const prevBak = asar + '.prev.bak';

  if (!fs.existsSync(origBak)) {
    console.log('🛡️ 创建官方基准备份 app.asar.bak ...');
    fs.copyFileSync(asar, origBak);
  }
  try {
    fs.copyFileSync(asar, prevBak);
    console.log('📸 快照 app.asar.prev.bak');
  } catch (e) { /* ignore */ }

  // 面板依赖 theme.js（设计 token 层），按顺序拼接后一起注入。
  // 两个文件各自带 START/END 标记，stripBlock 会一起清掉，幂等不受影响。
  const read = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
  const panelCode = read('theme.js').trimEnd() + '\n\n' + read('panel.js');

  // 关键：以「当前 asar」为基准（而非 .bak），才能在汉化补丁之上叠加。
  // 若当前 asar 已含本面板块则先剥离，保证幂等。
  const sourceAsar = asar;
  const temp = path.join(os.tmpdir(), 'agl-ctx-panel.asar');

  try {
    PrecisionPatcher.patch(sourceAsar, temp, {
      'dist/preload.js': function (origBuf) {
        let s = origBuf.toString('utf8');
        if (s.includes(MARK_START)) s = stripBlock(s);
        return Buffer.from(s + '\n' + panelCode + '\n', 'utf8');
      },
    });
    try {
      fs.copyFileSync(temp, asar);
      fs.unlinkSync(temp);
      console.log('🎉 注入成功！重启 Antigravity 即可看到右下角悬浮面板');
    } catch (lockErr) {
      console.log('ℹ️ 补丁已生成但文件被占用（Antigravity 正在运行）:');
      console.log('   ' + temp);
      console.log('   关闭 Antigravity 后手动复制覆盖即可。');
    }
  } catch (err) {
    console.error('❌ 注入失败: ' + err.message);
    process.exit(1);
  }
}

function uninstall(customPath) {
  const asar = resolveAsar(customPath);
  if (!asar) {
    console.error('❌ 未找到 app.asar');
    process.exit(1);
  }
  const origBak = asar + '.bak';
  if (!fs.existsSync(origBak)) {
    console.error('❌ 没有基准备份，无法还原');
    process.exit(1);
  }
  const bakText = readPreload(origBak) || '';
  const src = bakText.includes('__ANTIGRAVITY_CN__') ? asar + '.prev.bak' : origBak;
  console.log('🔄 还原自: ' + src);
  try {
    fs.copyFileSync(src, asar);
    console.log('✅ 已还原（汉化补丁保留情况取决于快照）');
  } catch (e) {
    console.error('❌ 还原失败: ' + e.message + '（Antigravity 可能正在运行）');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
let customPath = null;
const pi = argv.indexOf('--path');
if (pi >= 0 && argv[pi + 1]) customPath = argv[pi + 1];

if (cmd === 'install') {
  install(customPath);
} else if (cmd === 'uninstall') {
  uninstall(customPath);
} else {
  const st = status(customPath);
  if (!st.found) {
    console.log('未找到 app.asar');
  } else {
    console.log('asar        : ' + st.asar);
    console.log('上下文面板  : ' + (st.panel ? '已注入 ✅' : '未注入'));
    console.log('汉化补丁    : ' + (st.i18n ? '已注入 ✅' : '未注入'));
  }
}
