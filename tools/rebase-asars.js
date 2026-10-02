/**
 * rebase-asars.js — 把 app.asar 重新对齐到「主程序那个版本」的正确基准上，
 * 并在其上依次重打汉化 + AGL 面板。
 *
 * 为什么需要这个脚本
 * ------------------
 * 机器上有一个汉化哨兵 auto-repatch.pyw，它的 patch_now() 里写死了：
 *     shutil.copy2(ASAR, BAK)          // 把当前 asar 覆盖成 .bak
 *     再调 antigravity-cn install
 * 而 antigravity-cn 的 install() 又写死了：
 *     const sourceAsar = origBakPath;  // 永远以 app.asar.bak 为基准
 *
 * 于是出现死结：官方更新后 → 主程序变 2.19.1 → 哨兵重打汉化 →
 * 但基准是 2.18.1 的旧 .bak → 界面 asar 被拉回 2.18.1 →
 * 主程序 2.19.1 + 界面 2.18.1，版本错位 → 更新器永远认为没装好。
 *
 * 本脚本做的是：显式指定正确的基准版本，一次重建到位。
 *
 * 用法
 * ----
 *   node rebase-asars.js                 # 自动探测主程序版本并找对应官方 asar
 *   node rebase-asars.js --dry-run       # 只报告，不写任何文件
 *   node rebase-asars.js --base <path>   # 手动指定官方基准 asar
 *   node rebase-asars.js --no-panel      # 只打汉化，不注入 AGL 面板
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ------------------------------------------------------------------ config
const APP_DIR = 'D:\\Antigravity\\app';
const RES_DIR = path.join(APP_DIR, 'resources');
const LIVE_ASAR = path.join(RES_DIR, 'app.asar');
const CN_DIR = 'D:\\Antigravity\\zh-patch\\Antigravity-CN-main';
const CN_PATCHER = path.join(CN_DIR, 'src', 'patcher', 'precision-patcher.js');
const CN_SRC = path.join(CN_DIR, 'src');
const AGL_DIR = 'E:\\AGL Context Pro\\desktop-inject';

const CN_MARKER = '__ANTIGRAVITY_CN__';
const AGL_MARK_START = '/* === [START] Antigravity 上下文用量悬浮面板 === */';
const AGL_MARK_END = '/* === [END] Antigravity 上下文用量悬浮面板 === */';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const NO_PANEL = argv.includes('--no-panel');
const bi = argv.indexOf('--base');
const FORCED_BASE = bi >= 0 ? argv[bi + 1] : null;

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n[${n}] ${t}`);
const ok = (t) => log('   [OK] ' + t);
const info = (t) => log('   [i]  ' + t);
const warn = (t) => log('   [!]  ' + t);

// ------------------------------------------------------------------ asar utils
function readAsar(p) {
  const b = fs.readFileSync(p);
  const hs = b.readUInt32LE(4);
  const js = b.readUInt32LE(12);
  const header = JSON.parse(b.slice(16, 16 + js).toString('utf8'));
  return { buf: b, header, base: 8 + hs, fileSize: b.length };
}

function entry(o, rel) {
  let n = o.header;
  for (const part of rel.split('/')) {
    if (!n.files || !n.files[part]) return null;
    n = n.files[part];
  }
  if (n.offset === undefined) return null;
  const off = o.base + parseInt(n.offset, 10);
  return o.buf.slice(off, off + n.size);
}

function readText(p, rel) {
  const e = entry(readAsar(p), rel);
  return e ? e.toString('utf8') : null;
}

/** 返回 { version, preloadSize, cn, agl, sizeMB, mtime } */
function describe(p) {
  try {
    const o = readAsar(p);
    const pkg = JSON.parse(entry(o, 'package.json').toString('utf8'));
    const pre = entry(o, 'dist/preload.js');
    const preStr = pre ? pre.toString('utf8') : '';
    const st = fs.statSync(p);
    return {
      path: p,
      version: pkg.version,
      preloadSize: pre ? pre.length : 0,
      cn: preStr.includes(CN_MARKER),
      agl: preStr.includes(AGL_MARK_START),
      sizeMB: (o.fileSize / 1048576).toFixed(2),
      mtime: new Date(st.mtime).toISOString().replace('T', ' ').slice(0, 19),
    };
  } catch (e) {
    return { path: p, err: e.message };
  }
}

/** 从 Antigravity.exe 里抠出版本号（VS_VERSIONINFO 是 UTF-16LE） */
function exeVersion(exePath) {
  try {
    const b = fs.readFileSync(exePath);
    const u = b.toString('utf16le');
    // 版本号出现多次，取最长的合理匹配
    const m = u.match(/2\.\d+\.\d+/g);
    if (!m) return null;
    // 统计频次，取最高频的
    const freq = {};
    for (const v of m) freq[v] = (freq[v] || 0) + 1;
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    return null;
  }
}

/** 找出所有候选官方基准（无 CN 标记、无 AGL 标记） */
function findOfficialBases() {
  const out = [];
  for (const f of fs.readdirSync(RES_DIR)) {
    if (!f.startsWith('app.asar')) continue;
    const p = path.join(RES_DIR, f);
    if (!fs.statSync(p).isFile()) continue;
    const d = describe(p);
    if (d.err) continue;
    if (!d.cn && !d.agl) out.push(d);
  }
  return out.sort((a, b) => cmpVer(b.version, a.version)); // 版本高的在前
}

function cmpVer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ------------------------------------------------------------------ patching
function loadCnPatcher() {
  return require(CN_PATCHER);
}

function buildInjectionBlock() {
  const engineCode = fs.readFileSync(path.join(CN_SRC, 'core', 'i18n-engine.js'), 'utf8');
  const localeJson = fs.readFileSync(path.join(CN_SRC, 'locales', 'zh-CN.json'), 'utf8');
  return `
/* === [START] Antigravity-CN UI 汉化补丁注入代码 === */
(function() {
  try {
    ${engineCode}
    const __locale = ${localeJson};
    if (typeof window !== 'undefined' && window.__ANTIGRAVITY_CN__) {
      window.__ANTIGRAVITY_CN__.init(__locale);
    }
  } catch (e) {
    console.error('[Antigravity-CN] 注入失败:', e);
  }
})();
/* === [END] Antigravity-CN UI 汉化补丁注入代码 === */
`;
}

function loadPanelCode() {
  const read = (f) => {
    const s = fs.readFileSync(path.join(AGL_DIR, 'src', f), 'utf8');
    return s
      .replace(/^\s*\/\* === \[START\] Antigravity 上下文用量悬浮面板[^=]*=== \*\/\s*$/m, '')
      .replace(/^\s*\/\* === \[END\] Antigravity 上下文用量悬浮面板[^=]*=== \*\/\s*$/m, '')
      .trim();
  };
  return (
    AGL_MARK_START + '\n' +
    read('theme.js') + '\n\n' + read('panel.js') + '\n' +
    AGL_MARK_END
  );
}

// ------------------------------------------------------------------ main
log('============================================================');
log('  rebase-asars — 把界面 asar 对齐到主程序版本');
log('============================================================');
if (DRY) log('  [DRY-RUN] 只报告，不写任何文件');

step('0/6', '探测版本与基准');

const exePath = path.join(APP_DIR, 'Antigravity.exe');
const exeVer = exeVersion(exePath);
const candidates = findOfficialBases();
const live = describe(LIVE_ASAR);

info('主程序 Antigravity.exe : ' + (exeVer || '探测失败'));
info('当前 app.asar          : v' + live.version +
     ' | preload ' + live.preloadSize +
     ' | CN ' + (live.cn ? 'Y' : '-') +
     ' | AGL ' + (live.agl ? 'Y' : '-'));
info('可用官方基准:');
for (const c of candidates) {
  log(`      v${c.version}  ${c.path.split('\\').pop()}  (${c.sizeMB} MB, ${c.mtime})`);
}

if (!candidates.length) {
  warn('找不到任何干净官方基准，无法继续。');
  process.exit(1);
}

// 选基准：优先命令行指定 > 与主程序版本一致的 > 版本最高的
let base = null;
if (FORCED_BASE) {
  const found = candidates.find((c) => path.resolve(c.path) === path.resolve(FORCED_BASE));
  if (!found) { warn('--base 指定的文件不是干净官方基准: ' + FORCED_BASE); process.exit(1); }
  base = found;
} else if (exeVer) {
  base = candidates.find((c) => c.version === exeVer) || candidates[0];
  if (base.version !== exeVer) {
    warn(`没有与主程序 v${exeVer} 完全匹配的官方基准，退回 v${base.version}`);
  }
} else {
  base = candidates[0];
}

log('');
ok('选定基准: v' + base.version + '  (' + base.path + ')');

// 如果当前 asar 已经是「目标版本 + CN + AGL」，就不必重做
const alreadyGood = live.version === base.version && live.cn && (NO_PANEL || live.agl);
if (alreadyGood) {
  ok('当前 asar 已是目标状态（v' + base.version + ' + 汉化' + (NO_PANEL ? '' : ' + 面板') + '），无需重建。');
  process.exit(0);
}

if (DRY) {
  log('');
  log('  [DRY-RUN] 将要执行：');
  log('    1. 备份当前 app.asar');
  log('    2. 以 v' + base.version + ' 官方 asar 为基准重打汉化');
  if (!NO_PANEL) log('    3. 在汉化之上注入 AGL 面板');
  log('    4. 写回 app.asar 并校验');
  log('');
  log('  未做任何改动。');
  process.exit(0);
}

// 检查 Antigravity 是否在运行
function appRunning() {
  try {
    const out = execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
      [],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    return out.includes('Antigravity.exe');
  } catch {
    return false;
  }
}
if (appRunning()) {
  warn('Antigravity 正在运行，app.asar 可能被占用。');
  warn('请先完全关闭 Antigravity 再运行本脚本。');
  process.exit(1);
}
ok('Antigravity 未运行');

step('1/6', '备份当前 app.asar');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const manualBak = path.join(RES_DIR, `app.asar.rebase-${stamp}.bak`);
fs.copyFileSync(LIVE_ASAR, manualBak);
ok('已备份 -> ' + manualBak);

step('2/6', '重打汉化（基准 v' + base.version + '）');
const PrecisionPatcher = loadCnPatcher();
const injectionBlock = buildInjectionBlock();
const tmp1 = path.join(os.tmpdir(), `rebase-cn-${Date.now()}.asar`);
try {
  PrecisionPatcher.patch(base.path, tmp1, {
    'dist/preload.js': (origBuf) => {
      let s = origBuf.toString('utf8');
      if (s.includes(CN_MARKER)) {
        s = s.replace(/\/\* === \[START\] Antigravity-CN[\s\S]*?=== \[END\] Antigravity-CN[^\*]*\*\//, '');
      }
      return Buffer.from(s + '\n' + injectionBlock, 'utf8');
    },
  });
  const d = describe(tmp1);
  ok(`汉化完成 v${d.version} | preload ${d.preloadSize} | CN ${d.cn ? 'Y' : '-'}`);
  if (d.version !== base.version) throw new Error('版本漂移: ' + d.version);
  if (!d.cn) throw new Error('CN 标记未写入');
} catch (e) {
  warn('汉化阶段失败: ' + e.message);
  try { fs.unlinkSync(tmp1); } catch {}
  process.exit(1);
}

step('3/6', '注入 AGL 面板');
let finalTmp = tmp1;
if (NO_PANEL) {
  info('--no-panel 已指定，跳过');
} else {
  const panelCode = loadPanelCode();
  const tmp2 = path.join(os.tmpdir(), `rebase-panel-${Date.now()}.asar`);
  try {
    PrecisionPatcher.patch(tmp1, tmp2, {
      'dist/preload.js': (origBuf) => {
        let s = origBuf.toString('utf8');
        const re = /\/\* === \[START\] Antigravity 上下文用量悬浮面板[^=]*=== \*\/[\s\S]*?\/\* === \[END\] Antigravity 上下文用量悬浮面板[^=]*=== \*\//g;
        s = s.replace(re, '').trimEnd();
        return Buffer.from(s + '\n' + panelCode + '\n', 'utf8');
      },
    });
    const d = describe(tmp2);
    ok(`面板注入完成 v${d.version} | preload ${d.preloadSize} | CN ${d.cn ? 'Y' : '-'} | AGL ${d.agl ? 'Y' : '-'}`);
    if (!d.cn) throw new Error('注入面板后 CN 标记丢失！');
    if (!d.agl) throw new Error('AGL 标记未写入');
    if (d.version !== base.version) throw new Error('版本漂移: ' + d.version);
    fs.unlinkSync(tmp1);
    finalTmp = tmp2;
  } catch (e) {
    warn('面板注入失败: ' + e.message);
    try { fs.unlinkSync(tmp1); } catch {}
    try { fs.unlinkSync(tmp2); } catch {}
    process.exit(1);
  }
}

step('4/6', '写回 app.asar');
try {
  fs.copyFileSync(finalTmp, LIVE_ASAR);
  fs.unlinkSync(finalTmp);
  ok('已写回 ' + LIVE_ASAR);
} catch (e) {
  warn('写回失败: ' + e.message);
  warn('补丁已生成于: ' + finalTmp);
  warn('关闭 Antigravity 后手动复制覆盖即可。');
  process.exit(1);
}

step('5/6', '同步基准备份 app.asar.bak');
// 关键修复：让 .bak 等于真·官方基准，这样哨兵下次重打时不会拉回旧版本
try {
  const bakPath = LIVE_ASAR + '.bak';
  fs.copyFileSync(base.path, bakPath);
  ok('app.asar.bak 已更新为 v' + base.version + ' 官方原版');
} catch (e) {
  warn('同步 .bak 失败: ' + e.message);
}

step('6/6', '最终校验');
const fin = describe(LIVE_ASAR);
log('   app.asar    : v' + fin.version);
log('   preload.js  : ' + fin.preloadSize + ' bytes');
log('   汉化 CN     : ' + (fin.cn ? 'YES' : 'NO'));
log('   AGL 面板    : ' + (fin.agl ? 'YES' : 'NO'));
log('   文件大小    : ' + fin.sizeMB + ' MB');

const pass = fin.version === base.version && fin.cn && (NO_PANEL || fin.agl);
log('');
log('============================================================');
if (pass) {
  log('  完成。界面已对齐到 v' + base.version + (NO_PANEL ? '' : '，汉化与面板均在位。'));
  log('  重启 Antigravity 生效。');
  log('');
  log('  手动备份: ' + manualBak.split('\\').pop());
} else {
  log('  校验未通过，请检查上面的输出。');
  process.exitCode = 1;
}
log('============================================================');
