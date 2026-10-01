/**
 * Antigravity 上下文预算 - 纯 Node 实现的 LS 客户端（扩展核心模块）
 *
 * 发现链路（全部本地、只读）：
 *   1. PowerShell CIM 找到所有 language_server.exe 进程 -> 命令行里的 --csrf_token
 *   2. netstat 按 PID 反查监听端口（IDE / 桌面版谁起的 LS 都能找到）
 *   3. 对候选 (端口, CSRF) 探活 HTTPS RPC，首个 200 即命中
 *
 * 为什么不用日志解析端口：IDE 和桌面版的日志目录不同，而 netstat 与谁启动无关。
 * 为什么探活能选对端口：LS 开两个口（HTTPS gRPC + HTTP），
 * 只有 HTTPS 口能完成 TLS 握手，HTTP 口连接直接失败，天然筛选。
 */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const SERVICE = 'exa.language_server_pb.LanguageServerService';
const CSRF_RE = /--csrf_token[= ]+([0-9a-fA-F-]{36})/;
const APPDIR_RE = /--app_data_dir[= ]+(\S+)/;

// 对话级用量相关（逆向自官方 trajectory 结构）
const STEP_TYPE_CHECKPOINT = 'CORTEX_STEP_TYPE_CHECKPOINT';
const COMPRESSION_MIN_DROP = 5000; // 相邻 checkpoint input 下降超此值判定发生过压缩
const STEP_TAIL = 400;             // 只拉会话尾部 400 步：覆盖用量 + 压缩检测，避免大会话拖慢轮询

// ---------------------------------------------------------------- 基础工具

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: timeoutMs || 8000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

function rpc(port, csrf, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = https.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/' + SERVICE + '/' + method,
      // Node 的 https 默认不走系统代理，天然避开「本地请求被代理劫持 502」的坑
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': csrf,
        'Connect-Protocol-Version': '1',
        'Content-Length': data.length,
      },
      timeout: timeoutMs || 8000,
      rejectUnauthorized: false, // LS 用自签证书
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + buf.slice(0, 160)));
          return;
        }
        try {
          resolve(buf ? JSON.parse(buf) : {});
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------- 进程发现

/** 所有 language_server.exe 进程：[{pid, csrf, appDataDir}] */
async function listLsProcesses() {
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" " +
    '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const out = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script], 10000);
  if (!out.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    return [];
  }
  // 只有一个结果时 PowerShell 返回对象而非数组
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  const found = [];
  for (const p of arr) {
    const cmd = String(p.CommandLine || '');
    const csrf = cmd.match(CSRF_RE);
    if (!csrf) continue;
    const appdir = cmd.match(APPDIR_RE);
    found.push({
      pid: p.ProcessId,
      csrf: csrf[1],
      appDataDir: appdir ? appdir[1] : '?',
    });
  }
  return found;
}

/** netstat 按 PID 反查 LISTENING 端口 */
async function listeningPorts(pid) {
  const out = await run('netstat.exe', ['-ano'], 8000);
  const ports = new Set();
  const re = new RegExp('\\sTCP\\s+\\S*:(\\d+)\\s+\\S+\\s+LISTENING\\s+' + pid + '\\s*$');
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (m && m[1] !== '0') ports.add(Number(m[1]));
  }
  return [...ports];
}

// ---------------------------------------------------------------- 发现 + 会话

let session = null; // {port, csrf, pid, appDataDir}

/** 探活所有候选，返回首个可用的会话；全失败返回 null */
async function discover() {
  const procs = await listLsProcesses();
  for (const proc of procs) {
    const ports = await listeningPorts(proc.pid);
    for (const port of ports) {
      try {
        await rpc(port, proc.csrf, 'GetAuthStatus', {}, 2500);
        session = { port, csrf: proc.csrf, pid: proc.pid, appDataDir: proc.appDataDir };
        return session;
      } catch (e) {
        // TLS 握手失败（那是 HTTP 口）或 CSRF 不匹配，继续试下一个
      }
    }
  }
  return null;
}

/** 取当前会话；失效自动重新发现一次。
 *  测试钩子：设置环境变量 AGL_MOCK_SESSION='{"port":n,"csrf":"x"}' 可跳过进程发现。 */
async function getSession() {
  if (session) return session;
  if (process.env.AGL_MOCK_SESSION) {
    try {
      session = JSON.parse(process.env.AGL_MOCK_SESSION);
      return session;
    } catch (e) { /* 非法值则走正常发现 */ }
  }
  return discover();
}

// ---------------------------------------------------------------- 业务封装

/**
 * 拉一次 GetTokenBase 并整理成友好结构。
 * 返回 { ok, total, budget, remaining, percent, truncated, groups, session }
 * 失败返回 { ok:false, error }
 */
async function getContext() {
  let s = await getSession();
  if (!s) return { ok: false, error: '未发现运行中的 language_server（Antigravity / IDE 未启动？）' };

  let raw;
  try {
    raw = await rpc(s.port, s.csrf, 'GetTokenBase', {}, 8000);
  } catch (e) {
    // 会话可能已失效（LS 重启换了端口），重新发现一次再试
    session = null;
    s = await discover();
    if (!s) return { ok: false, error: 'LS 连接失效且重新发现失败' };
    try {
      raw = await rpc(s.port, s.csrf, 'GetTokenBase', {}, 8000);
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }

  const base = (raw && raw.customizationTokenBase) || {};
  const total = base.totalTokens || 0;
  const budget = raw.customizationBudget || 0;
  return {
    ok: true,
    total,
    budget,
    remaining: raw.remainingBudget || 0,
    percent: budget ? (100.0 * total / budget) : 0,
    truncated: !!(raw.truncatedCustomizationTokenBase
      && Object.keys(raw.truncatedCustomizationTokenBase).length),
    rulesBudget: raw.rulesBudget || 0,
    rulesRemaining: raw.remainingRulesBudget || 0,
    groups: base.groups || [],
    session: { port: s.port, pid: s.pid, appDataDir: s.appDataDir },
  };
}

// ---------------------------------------------------------------- 对话级用量

/**
 * 按模型名猜测上下文上限（简化自社区实测表）：
 * Claude 系 160k / Gemini Pro 128k / Gemini 3.5+ Flash 256k / GPT-OSS 80k，未知兜底 160k。
 * placeholder ID（MODEL_PLACEHOLDER_Mxx）无语义，提取编号精确比对。
 */
function guessContextLimit(modelId) {
  const id = String(modelId || '').toLowerCase();
  const ph = id.match(/model_placeholder_(m\d+)/);
  if (ph) {
    const n = ph[1];
    if (n === 'm35' || n === 'm26') return 160000;               // Claude Sonnet/Opus
    if (n === 'm18' || n === 'm16' || n === 'm37' || n === 'm36') return 128000; // Gemini Pro
    return 256000; // 其余已知 placeholder 均为 Gemini Flash 系（3.5+）
  }
  if (id.includes('claude') || id.includes('opus') || id.includes('sonnet')) return 160000;
  if (id.includes('pro')) return 128000;
  if (id.includes('flash') || id.includes('lite') || id.includes('unspecified')) {
    const m = id.match(/(\d+\.\d+)/);
    const ver = m ? parseFloat(m[1]) : NaN;
    return (!Number.isNaN(ver) && ver < 3.5) ? 128000 : 256000;
  }
  if (id.includes('gpt') || id.includes('oss')) return 80000;
  return 160000;
}

/** 解析 GetAllCascadeTrajectories 响应 → 按最近修改降序的会话数组（纯函数，可测） */
function parseTrajectories(summaries) {
  return Object.entries(summaries || {}).map(([cascadeId, d]) => {
    let model = '';
    for (const latest of [d.latestTaskBoundaryStep, d.latestNotifyUserStep]) {
      const meta = latest && latest.step && latest.step.metadata;
      if (meta) {
        if (meta.generatorModel) model = meta.generatorModel;
        if (meta.requestedModel && meta.requestedModel.model) model = meta.requestedModel.model;
      }
    }
    return {
      cascadeId,
      summary: d.summary || cascadeId,
      status: d.status || '',
      stepCount: d.stepCount || 0,
      lastModifiedTime: d.lastModifiedTime || '',
      model,
    };
  }).sort((a, b) => (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || ''));
}

/** 解析 steps 数组 → 对话用量（纯函数，可测） */
function parseConversationSteps(steps) {
  let lastUsage = null;
  let prevInput = -1;
  let compressed = false;
  let compressionDrop = 0;
  let checkpointCount = 0;
  let toolOutputTokens = 0;
  for (const step of steps || []) {
    const type = step.type || '';
    const meta = step.metadata || {};
    if (type === STEP_TYPE_CHECKPOINT) {
      const mu = meta.modelUsage;
      if (mu) {
        const inputTokens = parseInt(String(mu.inputTokens || '0'), 10) || 0;
        const outputTokens = parseInt(String(mu.outputTokens || '0'), 10) || 0;
        if (prevInput > 0 && inputTokens < prevInput
            && (prevInput - inputTokens) > COMPRESSION_MIN_DROP) {
          compressed = true;
          compressionDrop = prevInput - inputTokens;
        }
        prevInput = inputTokens;
        lastUsage = { inputTokens, outputTokens, model: mu.model || '' };
        checkpointCount++;
      }
    } else if (meta.toolCallOutputTokens) {
      toolOutputTokens += meta.toolCallOutputTokens;
    }
  }
  return { lastUsage, compressed, compressionDrop, checkpointCount, toolOutputTokens };
}

/**
 * 拉取对话级用量：最新 cascade 会话 + 其余会话摘要。
 * 返回 { ok, conversation, others, session }，失败 { ok:false, error }。
 * conversation: { cascadeId, summary, status, stepCount, lastModifiedTime,
 *                 model, used, limit, percent, checkpoints,
 *                 inputTokens, outputTokens, toolOutputTokens,
 *                 compressed, compressionDrop }
 */
async function getConversation() {
  let s = await getSession();
  if (!s) return { ok: false, error: '未发现运行中的 language_server' };

  let list;
  try {
    // 请求体必须带 metadata，否则返回空 {}（官方扩展同样如此）
    list = await rpc(s.port, s.csrf, 'GetAllCascadeTrajectories',
      { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } }, 10000);
  } catch (e) {
    session = null;
    s = await discover();
    if (!s) return { ok: false, error: 'LS 连接失效且重新发现失败' };
    try {
      list = await rpc(s.port, s.csrf, 'GetAllCascadeTrajectories',
        { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } }, 10000);
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }

  const convs = parseTrajectories(list && list.trajectorySummaries);
  if (!convs.length) {
    return { ok: true, conversation: null, others: [], session: { port: s.port } };
  }

  const cur = convs[0];
  let stepsResp;
  try {
    const start = Math.max(0, cur.stepCount - STEP_TAIL);
    stepsResp = await rpc(s.port, s.csrf, 'GetCascadeTrajectorySteps',
      { cascadeId: cur.cascadeId, startIndex: start, endIndex: cur.stepCount }, 15000);
  } catch (e) {
    return { ok: false, error: 'GetCascadeTrajectorySteps: ' + String(e.message || e) };
  }

  const p = parseConversationSteps((stepsResp && stepsResp.steps) || []);
  const model = (p.lastUsage && p.lastUsage.model) ? p.lastUsage.model : cur.model;
  const limit = guessContextLimit(model);
  const inputTokens = p.lastUsage ? p.lastUsage.inputTokens : 0;
  const outputTokens = p.lastUsage ? p.lastUsage.outputTokens : 0;
  const used = inputTokens + outputTokens;

  return {
    ok: true,
    conversation: {
      cascadeId: cur.cascadeId,
      summary: cur.summary,
      status: cur.status,
      stepCount: cur.stepCount,
      lastModifiedTime: cur.lastModifiedTime,
      model,
      used,
      limit,
      percent: limit ? (100.0 * used / limit) : 0,
      checkpoints: p.checkpointCount,
      inputTokens,
      outputTokens,
      toolOutputTokens: p.toolOutputTokens,
      compressed: p.compressed,
      compressionDrop: p.compressionDrop,
    },
    others: convs.slice(1, 9),
    session: { port: s.port },
  };
}

// ---------------------------------------------------------------- 展示格式化

/** 1673 -> "1.7k"，20000 -> "20k" */
function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** 状态点：<65 蓝 / <85 橙 / 其余红 */
function statusDot(percent) {
  if (percent >= 85) return '🔴';
  if (percent >= 65) return '🟠';
  return '🔵';
}

module.exports = {
  getContext, getConversation, discover, rpc,
  parseTrajectories, parseConversationSteps, guessContextLimit,
  fmtNum, statusDot, SERVICE,
};

// 直接 node lsclient.js 时自测
if (require.main === module) {
  (async () => {
    console.log('发现 LS…');
    const ctx = await getContext();
    if (!ctx.ok) {
      console.log('失败:', ctx.error);
      return;
    }
    console.log(`会话: 端口 ${ctx.session.port}, PID ${ctx.session.pid}, app_data_dir=${ctx.session.appDataDir}`);
    console.log(`上下文: ${ctx.total} / ${ctx.budget} (${ctx.percent.toFixed(1)}%), 剩余 ${ctx.remaining}${ctx.truncated ? ' ⚠已截断' : ''}`);
    for (const g of ctx.groups) {
      console.log(`  [${g.name}] ${g.numTokens}`);
      for (const ch of (g.children || [])) {
        console.log(`      ${String(ch.numTokens).padStart(6)}  ${ch.name}`);
      }
    }
    console.log('\n---- 对话级用量 ----');
    const conv = await getConversation();
    if (!conv.ok) {
      console.log('失败:', conv.error);
      return;
    }
    if (!conv.conversation) {
      console.log('尚无任何 cascade 会话');
      return;
    }
    const c = conv.conversation;
    console.log(`会话: ${c.summary} (${c.cascadeId.slice(0, 8)}…, 状态 ${c.status}, ${c.stepCount} 步)`);
    console.log(`模型: ${c.model || '?'} → 上限 ${c.limit}`);
    console.log(`用量: ${c.used} / ${c.limit} (${c.percent.toFixed(1)}%)`
      + ` [input ${c.inputTokens} + output ${c.outputTokens} + 工具输出≈${c.toolOutputTokens}]`);
    console.log(`checkpoints: ${c.checkpoints}${c.compressed ? ` · ⚠检测到压缩（回落 ${c.compressionDrop}）` : ''}`);
    if (conv.others.length) {
      console.log(`其他会话 ${conv.others.length} 个:`);
      for (const o of conv.others) {
        console.log(`  - ${o.summary.slice(0, 40)} (${o.status}, ${o.stepCount} 步, ${o.lastModifiedTime.slice(0, 16)})`);
      }
    }
  })();
}
