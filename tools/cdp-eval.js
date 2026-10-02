#!/usr/bin/env node
/**
 * 通用 CDP 求值器：连 Antigravity 主界面，跑一段表达式并返回结果。
 *   node tools/cdp-eval.js "expression"            # 主世界
 *   node tools/cdp-eval.js --iso "expression"      # 隔离世界（preload 所在）
 *   node tools/cdp-eval.js --dom                   # 打印面板 DOM 文本（快捷方式）
 */
'use strict';

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const SYS = process.env.SystemRoot || 'C:\\Windows';
const TASKLIST = path.join(SYS, 'System32', 'tasklist.exe');
const NETSTAT = path.join(SYS, 'System32', 'netstat.exe');
const OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

const argv = process.argv.slice(2);
const ISO = argv[0] === '--iso';
const DOM = argv[0] === '--dom';
const EXPR = DOM
  ? `(() => {
      const el = document.querySelector('#agl-ctx');
      if (!el) return 'NO_PANEL';
      return el.innerText + '\\n\\n[HTML]\\n' + el.outerHTML.slice(-6000);
    })()`
  : (ISO ? argv[1] : argv[0]) || "'no expr'";

function antigravityPids() {
  let out;
  try { out = execFileSync(TASKLIST, [], OPTS); } catch { return []; }
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/Antigravity\.exe/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols[1] && /^\d+$/.test(cols[1])) pids.push(Number(cols[1]));
  }
  return pids;
}

function listeningPorts(pids) {
  let out = '';
  try { out = execFileSync(NETSTAT, ['-ano'], OPTS); } catch { return []; }
  const set = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\sTCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && pids.includes(Number(m[2]))) set.add(Number(m[1]));
  }
  return [...set];
}

function httpGetJson(port, p) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 3000 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

let idSeq = 0;
function cdp(ws, method, params, timeoutMs = 60000) {
  const id = ++idSeq;
  return new Promise((resolve, reject) => {
    const onMsg = ev => {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const pids = antigravityPids();
  let cdpPort = null;
  for (const p of listeningPorts(pids)) {
    const v = await httpGetJson(p, '/json/version');
    if (v && v.Browser) { cdpPort = p; break; }
  }
  if (!cdpPort) { console.log('未找到 CDP 端口'); process.exit(1); }

  const list = await httpGetJson(cdpPort, '/json/list');
  const page = (list || []).find(t => t.type === 'page');
  if (!page) { console.log('无 page 目标'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); });
  });

  await cdp(ws, 'Runtime.enable');

  // 收集执行上下文
  const contexts = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
  });
  await sleep(400);

  let ctxId = undefined;
  if (ISO) {
    const iso = contexts.find(c => /isolated/i.test((c.auxData || {}).type || '') || /Isolated/.test(c.name || ''));
    if (iso) ctxId = iso.id;
  }
  console.log('CDP', cdpPort, '| contexts:', contexts.map(c => `${c.id}:${(c.auxData||{}).type||c.name}`).join(', '));

  const r = await cdp(ws, 'Runtime.evaluate', {
    expression: EXPR,
    awaitPromise: true,
    returnByValue: true,
    contextId: ctxId,
    timeout: 60000,
  });
  ws.close();

  if (r && r.exceptionDetails) { console.log('异常:', JSON.stringify(r.exceptionDetails).slice(0, 1200)); process.exit(1); }
  const v = r && r.result && r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
