/**
 * 模拟 Antigravity language_server 的 HTTPS RPC 端点，用于离线 E2E 测试。
 *
 * 只实现扩展用到的 4 个方法，返回结构与真实 LS 一致：
 *   GetAuthStatus / GetTokenBase / GetAllCascadeTrajectories / GetCascadeTrajectorySteps
 *
 * GetTokenBase 带状态：第 1 次返回未截断，第 2 次返回已截断（测告警用）。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const CSRF = 'mock-csrf-token';
const SERVICE_PATH = '/exa.language_server_pb.LanguageServerService/';

// ---- 固定数据 ------------------------------------------------------------

const tokenBase = {
  customizationTokenBase: {
    totalTokens: 1673,
    groups: [
      { name: 'Rules', numTokens: 182, children: [{ name: 'GEMINI.md', numTokens: 182 }] },
      {
        name: 'Skills', numTokens: 1491,
        children: [
          { name: 'modern-web-guidance', numTokens: 364 },
          { name: 'frontend-design', numTokens: 312 },
        ],
      },
    ],
  },
  customizationBudget: 20000,
  remainingBudget: 18327,
  rulesBudget: 2000,
  remainingRulesBudget: 1818,
};

const tokenBaseTruncated = {
  ...tokenBase,
  truncatedCustomizationTokenBase: { groups: [{ name: 'Skills', numTokens: 1491 }] },
};

// 两个会话：conv-2 更新（当前），conv-1 较旧
const trajectories = {
  'conv-2-aaaa': {
    summary: '当前会话：重构上下文监控扩展',
    status: 'RUNNING',
    stepCount: 9,
    lastModifiedTime: '2026-10-01T16:00:00Z',
    latestNotifyUserStep: {
      step: {
        metadata: {
          generatorModel: 'gemini-3.8-flash-high',
          requestedModel: { model: 'claude-sonnet-4-6' },
        },
      },
    },
  },
  'conv-1-bbbb': {
    summary: '旧会话：调研 GetTokenBase',
    status: 'FINISHED',
    stepCount: 40,
    lastModifiedTime: '2026-09-30T09:00:00Z',
  },
};

// 9 步序列：3 个 checkpoint，中间发生过一次压缩（68000 → 52000，降 16000）
// 最后用量 = 80000 input + 2100 output；模型 gemini-3.8-flash-high → 上限 256000
const steps = [
  { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} },
  { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} },
  {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '30000', outputTokens: '1200', cacheReadTokens: '0' } },
  },
  { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 350 } },
  {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '68000', outputTokens: '1800', cacheReadTokens: '0' } },
  },
  // 压缩后回落
  {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '52000', outputTokens: '1500', cacheReadTokens: '0' } },
  },
  { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 120 } },
  {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '80000', outputTokens: '2100', cacheReadTokens: '0' } },
  },
  { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} },
];

// ---- 服务器 ----------------------------------------------------------------

function createMockLs() {
  let tokenCalls = 0;
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
    },
    (req, res) => {
      if (req.headers['x-codeium-csrf-token'] !== CSRF) {
        res.writeHead(403).end();
        return;
      }
      const method = req.url.slice(SERVICE_PATH.length);
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload = {};
        switch (method) {
          case 'GetAuthStatus':
            payload = {};
            break;
          case 'GetTokenBase':
            tokenCalls++;
            payload = tokenCalls >= 2 ? tokenBaseTruncated : tokenBase;
            break;
          case 'GetAllCascadeTrajectories': {
            // 与真实 LS 一致：缺 metadata 时返回空
            const parsed = JSON.parse(body || '{}');
            payload = parsed.metadata ? { trajectorySummaries: trajectories } : {};
            break;
          }
          case 'GetCascadeTrajectorySteps':
            payload = { steps };
            break;
          default:
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
  return server;
}

module.exports = { createMockLs, CSRF };

// 直接运行时：node mock-ls.js [port]，供手工调试
if (require.main === module) {
  const port = Number(process.argv[2]) || 34567;
  createMockLs().listen(port, '127.0.0.1', () => {
    console.log(`mock LS: https://127.0.0.1:${port}  csrf=${CSRF}`);
  });
}
