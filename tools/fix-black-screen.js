/**
 * fix-black-screen.js — 修复 Antigravity「窗口全黑」问题
 *
 * 病因
 * ----
 * Antigravity 的界面不是子进程渲染的静态文件，而是由 language_server.exe
 * 通过 https://127.0.0.1:<随机端口>/ 提供的（日志里 "Serving UI bundle from
 * embedded assets"）。渲染进程加载这个 URL 有 **30 秒超时**。
 *
 * 而 LS 冷启动可能超过 30 秒 —— 尤其是没走代理启动时：
 * LS 是 Go 二进制，只认 HTTP_PROXY/HTTPS_PROXY 环境变量，不认 Windows
 * 系统代理。直连 oauth2.googleapis.com 会超时重试，把启动拖到 30s+。
 * 一旦超时，Chromium 就停在错误页 chrome-error://chromewebdata/，表现为全黑窗口。
 *
 * 这个脚本做的事
 * --------------
 * 通过 CDP 连上那个黑窗口，检测它是否停在错误页；等 LS 真正就绪后
 * 触发一次 Page.reload，窗口就恢复了。不用重启整个应用。
 *
 * 用法
 * ----
 *   node fix-black-screen.js           # 检测并修复
 *   node fix-black-screen.js --check   # 只报告，不重载
 *   node fix-black-screen.js --wait 60 # 最多等 LS 就绪 60 秒（默认 45）
 */
'use strict';

const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const path = require('path');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const wi = argv.indexOf('--wait');
const WAIT_SEC = wi >= 0 ? parseInt(argv[wi + 1], 10) || 45 : 45;

const SYS = process.env.SystemRoot || 'C:\\Windows';
const TASKLIST = path.join(SYS, 'System32', 'tasklist.exe');
const NETSTAT = path.join(SYS, 'System32', 'netstat.exe');
const OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- discovery

/** 找出所有 Antigravity.exe 的 PID */
function antigravityPids() {
  let out;
  try { out = execFileSync(TASKLIST, [], OPTS); } catch { return []; }
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/Antigravity\.exe/i.test(line)) continue;
    const m = line.match(/(\d+)\s+Console|(\d+)\s+Services/);
    const cols = line.trim().split(/\s+/);
    const pid = cols[1];
    if (pid && /^\d+$/.test(pid)) pids.push(pid);
  }
  return pids;
}

/** 找出指定 PID 正在监听的 127.0.0.1 端口 */
function listeningPorts(pids) {
  let out;
  try { out = execFileSync(NETSTAT, ['-ano'], OPTS); } catch { return []; }
  const set = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
    if (!m) continue;
    if (pids.includes(m[2])) set.add(parseInt(m[1], 10));
  }
  return [...set].sort((a, b) => a - b);
}

function httpGetJson(port, pathname, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', timeout },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
          catch { resolve({ status: res.statusCode, raw: b.slice(0, 200) }); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 在所有监听端口里找出 CDP 端口（/json/version 返回 Chrome 版本） */
async function findCdpPort() {
  const pids = antigravityPids();
  if (!pids.length) return { cdpPort: null, pids: [] };
  const ports = listeningPorts(pids);
  for (const p of ports) {
    const r = await httpGetJson(p, '/json/version');
    if (r && r.json && r.json.Browser) return { cdpPort: p, pids, ports };
  }
  return { cdpPort: null, pids, ports };
}

/** 探测 LS 的 UI 是否已就绪 */
function probeUi(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, port: u.port, path: u.pathname || '/', method: 'GET', rejectUnauthorized: false, timeout: 5000 },
      (res) => {
        let n = 0;
        res.on('data', (d) => (n += d.length));
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, bytes: n }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.end();
  });
}

// ---------------------------------------------------------------- CDP

let idSeq = 0;
function rpc(ws, method, params, timeoutMs = 15000) {
  const id = ++idSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('timeout ' + method)); }, timeoutMs);
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws connect timeout')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); });
  });
  return ws;
}

// ---------------------------------------------------------------- main

async function main() {
  log('============================================================');
  log('  fix-black-screen — Antigravity 黑窗口修复');
  log('============================================================');
  if (CHECK_ONLY) log('  [--check] 只检测，不重载');
  log('');

  log('[1] 查找 Antigravity 进程与 CDP 端口');
  const { cdpPort, pids, ports } = await findCdpPort();
  if (!pids.length) {
    log('    [!] 没找到 Antigravity.exe —— 应用没在运行，先启动它。');
    process.exit(1);
  }
  log('    Antigravity.exe PIDs :', pids.join(', '));
  log('    监听端口             :', (ports || []).join(', ') || '(无)');
  if (!cdpPort) {
    log('    [X] 没找到 CDP 端口，无法连接调试接口。');
    process.exit(1);
  }
  log('    CDP 端口             :', cdpPort);

  log('');
  log('[2] 获取页面目标');
  const list = await httpGetJson(cdpPort, '/json/list');
  const page = list && list.json && list.json.find((t) => t.type === 'page');
  if (!page) {
    log('    [X] 没有 page 目标');
    process.exit(1);
  }
  const appUrl = page.url;
  log('    目标 URL             :', appUrl);
  log('    WS                   :', page.webSocketDebuggerUrl);

  const ws = await connect(page.webSocketDebuggerUrl);
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  async function snapshot(label) {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        ready: document.readyState,
        title: document.title,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
        hasRoot: !!document.querySelector('#root, #app, [data-reactroot]'),
        panel: !!document.getElementById('agl-ctx')
      })`,
      returnByValue: true,
    });
    let v = null;
    try { v = JSON.parse(r.result.value); } catch {}
    if (label && v) {
      log(`    ${label}: href=${v.href}`);
      log(`              title=${JSON.stringify(v.title)} bodyLen=${v.bodyLen} hasRoot=${v.hasRoot} panel=${v.panel}`);
    }
    return v;
  }

  log('');
  log('[3] 检查窗口当前状态');
  const before = await snapshot('现状');

  const isErrorPage = !before || before.href.startsWith('chrome-error://') || before.bodyLen < 500 || !before.hasRoot;

  if (!isErrorPage) {
    log('');
    log('    [OK] 窗口已正常渲染，无需修复。');
    if (before && before.panel) log('         AGL 面板在位。');
    ws.close();
    return;
  }

  log('');
  log('    [!] 窗口停在错误页 / 空页面 —— 确认是黑屏。');

  if (CHECK_ONLY) {
    log('');
    log('    （--check 模式，未重载）');
    ws.close();
    return;
  }

  log('');
  log(`[4] 等待 language_server 就绪（最多 ${WAIT_SEC}s）`);
  let ui = null;
  const deadline = Date.now() + WAIT_SEC * 1000;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    ui = await probeUi(appUrl);
    if (ui.ok) { log(`    [OK] UI 已就绪 (第 ${tries} 次探测, ${ui.bytes} 字节)`); break; }
    log(`    [..] 第 ${tries} 次: ${ui.status || ui.err} —— 2s 后重试`);
    await sleep(2000);
  }
  if (!ui || !ui.ok) {
    log('    [X] 等不到 UI 就绪。');
    log('        多半是没走代理导致 LS 连不上 Google 端点，启动被拖慢。');
    log('        请关掉 Antigravity，改用 Antigravity-proxy.cmd 启动。');
    ws.close();
    process.exit(1);
  }

  log('');
  log('[5] 重载窗口');
  await rpc(ws, 'Page.reload', { ignoreCache: true });
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const p = await snapshot(null);
    if (p && !p.href.startsWith('chrome-error://') && p.hasRoot && p.bodyLen > 500) {
      log(`    [OK] 第 ${(i + 1) * 2}s 渲染成功`);
      log('');
      log('============================================================');
      log('  已修复。');
      log(`  界面     : ${p.href}`);
      log(`  标题     : ${p.title}`);
      log(`  AGL 面板 : ${p.panel ? '在位' : '未检测到'}`);
      log('============================================================');
      ws.close();
      return;
    }
    log(`    [..] +${(i + 1) * 2}s 仍在加载...`);
  }

  log('    [X] 重载后仍未渲染成功。');
  ws.close();
  process.exit(1);
}

main().catch((e) => { log('FATAL:', e.message); process.exit(1); });
