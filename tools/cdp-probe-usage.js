#!/usr/bin/env node
/**
 * CDP 探针：在 Antigravity 主界面（主世界）直接调 LS RPC，
 * dump 最近会话 modelUsage 的「完整字段」——用于判定
 * cacheReadTokens 到底是「prompt 缓存命中量」还是别的量。
 *
 *   node tools/cdp-probe-usage.js [tailSteps]
 */
'use strict';

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const TAIL = parseInt(process.argv[2] || '200', 10);

// 从 git bash 里 spawn 系统 exe 必须用绝对路径 + 固定 stdio，否则 EBUSY/ENOENT
const SYS = process.env.SystemRoot || 'C:\\Windows';
const TASKLIST = path.join(SYS, 'System32', 'tasklist.exe');
const NETSTAT = path.join(SYS, 'System32', 'netstat.exe');
const OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

// ---------------------------------------------------------------- 端口发现
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

function httpGetJson(port, path) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 3000 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function findCdp() {
  const pids = antigravityPids();
  const ports = listeningPorts(pids);
  for (const p of ports) {
    const v = await httpGetJson(p, '/json/version');
    if (v && v.Browser) return { port: p, pids, ports };
  }
  return { port: null, pids, ports };
}

// ---------------------------------------------------------------- CDP
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

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); });
  });
  return ws;
}

// ---------------------------------------------------------------- 页面内脚本
const PAGE_SCRIPT = `(async () => {
  const csrf = (window.__APP_CONFIG__ || {}).csrfToken || '';
  const API = '/exa.language_server_pb.LanguageServerService/';
  const call = async (m, b) => {
    const r = await fetch(API + m, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrf,
      },
      body: JSON.stringify(b || {}),
    });
    return r.json();
  };
  const out = { csrfLen: csrf.length, errors: [] };
  try {
    const traj = await call('GetAllCascadeTrajectories', { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } });
    const sums = (traj && traj.trajectorySummaries) || {};
    const ids = Object.keys(sums).sort((a, b) =>
      String(sums[b].lastModifiedTime || '').localeCompare(String(sums[a].lastModifiedTime || '')));
    out.convCount = ids.length;
    if (!ids.length) { out.errors.push('no traj'); return JSON.stringify(out); }
    const cid = ids[0];
    const sum = sums[cid];
    out.conv = {
      cid,
      summary: sum.summary || '',
      status: sum.status || '',
      stepCount: Number(sum.stepCount) || 0,
      lastModified: String(sum.lastModifiedTime || ''),
    };
    const sc = out.conv.stepCount;
    const start = Math.max(0, sc - ${'${TAIL}'});
    const sr = await call('GetCascadeTrajectorySteps', { cascadeId: cid, startIndex: start, endIndex: sc });
    const steps = (sr && sr.steps) || [];
    out.fetched = { start, end: sc, got: steps.length };

    // 1. modelUsage 的「全部键名」并集 —— 这是判定字段语义的关键
    const keySet = {};
    const rows = [];
    let idx = start;
    for (const st of steps) {
      const md = st.metadata || {};
      const mu = md.modelUsage;
      if (mu) {
        Object.keys(mu).forEach(k => { keySet[k] = (keySet[k] || 0) + 1; });
        const n = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };
        if (n(mu.inputTokens) || n(mu.cacheReadTokens) || n(mu.outputTokens)) {
          rows.push({
            idx,
            stepType: st.type || '',
            mu,
            gen: md.generatorModel || '',
            req: (md.requestedModel || {}).model || '',
            toolOut: n(md.toolCallOutputTokens),
          });
        }
      }
      idx++;
    }
    out.modelUsageKeys = keySet;
    out.usageRows = rows;

    // 2. 官方额度（对比用）
    try {
      const us = await call('GetUserStatus', { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } });
      const cfgs = (((us || {}).userStatus || {}).cascadeModelConfigData || {}).clientModelConfigs || [];
      const quota = (((us || {}).userStatus || {}).cascadeModelConfigData || {});
      out.userStatusKeys = Object.keys(us || {});
      out.userStatusSnippet = JSON.stringify(us).slice(0, 2200);
      out.modelConfigs = cfgs.map(c => ({
        label: c.label,
        model: (c.modelOrAlias || {}).model,
        alias: (c.modelOrAlias || {}).alias,
        quotaInfo: c.quotaInfo || null,
      }));
    } catch (e) { out.errors.push('GetUserStatus: ' + e); }

    // 3. 预算
    try {
      const tb = await call('GetTokenBase', {});
      out.tokenBaseSnippet = JSON.stringify(tb).slice(0, 1200);
    } catch (e) { out.errors.push('GetTokenBase: ' + e); }
  } catch (e) {
    out.errors.push('fatal: ' + (e && e.message || e));
  }
  return JSON.stringify(out);
})()`.replace("${TAIL}", String(TAIL));

// ---------------------------------------------------------------- main
(async () => {
  const { port, pids, ports } = await findCdp();
  console.log('Antigravity PIDs :', pids.join(', ') || '(none)');
  console.log('监听端口         :', ports.join(', ') || '(none)');
  if (!port) { console.log('未找到 CDP 端口'); process.exit(1); }
  console.log('CDP 端口         :', port);

  const list = await httpGetJson(port, '/json/list');
  const page = (list || []).find(t => t.type === 'page');
  if (!page) { console.log('没有 page 目标'); process.exit(1); }
  console.log('页面             :', page.url);

  const ws = await connect(page.webSocketDebuggerUrl);
  await cdp(ws, 'Runtime.enable');
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression: PAGE_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
    timeout: 90000,
  });
  ws.close();

  if (r && r.exceptionDetails) {
    console.log('页面内异常:', JSON.stringify(r.exceptionDetails).slice(0, 1500));
    process.exit(1);
  }
  const val = r && r.result && r.result.value;
  if (!val) { console.log('无返回', JSON.stringify(r).slice(0, 800)); process.exit(1); }

  const d = JSON.parse(val);
  console.log('\nCSRF len         :', d.csrfLen);
  console.log('会话数           :', d.convCount);
  console.log('当前会话         :', JSON.stringify(d.conv));
  console.log('拉取             :', JSON.stringify(d.fetched));
  console.log('\n--- modelUsage 全部键名（出现次数）---');
  console.log(d.modelUsageKeys);
  console.log('\n--- GetUserStatus 顶层键 ---');
  console.log(d.userStatusKeys);
  console.log('\n--- 模型配置 quotaInfo ---');
  console.log(JSON.stringify(d.modelConfigs, null, 1).slice(0, 3000));

  const rows = d.usageRows || [];
  console.log(`\n--- 有效 modelUsage 行（${rows.length}），末 12 行 ---`);
  for (const rw of rows.slice(-12)) {
    console.log(`#${rw.idx} [${rw.stepType}] toolOut=${rw.toolOut} gen=${rw.gen} req=${rw.req}`);
    console.log('     ' + JSON.stringify(rw.mu));
  }
  console.log('\n--- GetUserStatus 片段 ---');
  console.log(d.userStatusSnippet);
  console.log('\n--- GetTokenBase 片段 ---');
  console.log(d.tokenBaseSnippet);
  if ((d.errors || []).length) console.log('\n错误:', d.errors);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
