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

// 9 步序列，modelUsage 挂在 PLANNER_RESPONSE 上（2026-10-02 实测的真实形态，
// 该会话 520 个 PLANNER_RESPONSE 全带用量、CHECKPOINT 一个都不带）。
// 中间发生过一次压缩：缓存归零、新增输入顶上（69800 → 53500，降 16300）。
// 末次用量 = 3211 + 76689 + 2100 = 82000；模型 gemini-3.8-flash-high → 上限 256000
const steps = [
  { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} },
  { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} },
  {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '3000', cacheReadTokens: '27000', outputTokens: '1200' } },
  },
  { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 350 } },
  {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '4200', cacheReadTokens: '63800', outputTokens: '1800' } },
  },
  // 压缩后回落：cacheRead 归 0，新增输入顶上
  {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '52000', cacheReadTokens: '0', outputTokens: '1500' } },
  },
  { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 120 } },
  {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'gemini-3.8-flash-high', inputTokens: '3211', cacheReadTokens: '76689', outputTokens: '2100' } },
  },
  { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} },
];

// 官方额度视图（GetUserStatus）：含 proto3 float 0.0 缺省的两个边界场景
// —— gemini-3.8 用尽（fraction 缺失 + resetTime 未来 → 0%）、claude 未动（fraction 缺失 + epoch → 100%）
const userStatus = {
  userStatus: {
    cascadeModelConfigData: {
      clientModelConfigs: [
        { modelOrAlias: { model: 'gemini-3.8-flash-high' }, label: 'Gemini 3.8 Flash (High)',
          quotaInfo: { resetTime: '2026-10-02T03:00:00Z' } },
        { modelOrAlias: { model: 'claude-sonnet-4-6' }, label: 'Claude Sonnet 4.6 (Thinking)',
          quotaInfo: { resetTime: '1970-01-01T00:00:00Z' } },
        { modelOrAlias: { model: 'gemini-3.1-pro-low' }, label: 'Gemini 3.1 Pro (Low)',
          quotaInfo: { remainingFraction: 0.785, resetTime: '2026-10-02T03:00:00Z' } },
      ],
      defaultOverrideModelConfig: { modelOrAlias: { model: 'gemini-3.8-flash-high' } },
    },
    planStatus: { planInfo: { displayName: 'Google AI Pro' } },
    userTier: { availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: 5, minimumCreditAmountForUsage: 1 }] },
  },
};

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
          case 'GetUserStatus':
            payload = userStatus;
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
