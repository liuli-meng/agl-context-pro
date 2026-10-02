/**
 * 离线 E2E 测试：mock LS + 全链路断言（发现钩子 → RPC → 解析 → 展示）。
 * 运行：npm test  （或 node test/run-tests.js）
 */
'use strict';

const assert = require('assert');
const { createMockLs, CSRF } = require('./mock-ls');
const lsclient = require('../lsclient');

let passed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✔ ${name}`); })
    .catch((e) => {
      console.error(`  ✘ ${name}\n    ${e.message}`);
      process.exitCode = 1;
    });
}

(async () => {
  // 启动 mock LS
  const server = createMockLs();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.AGL_MOCK_SESSION = JSON.stringify({ port, csrf: CSRF });

  console.log('纯函数单元测试');

  await test('guessContextLimit 模型分支', () => {
    assert.strictEqual(lsclient.guessContextLimit('claude-sonnet-4-6'), 160000);
    assert.strictEqual(lsclient.guessContextLimit('claude-opus-4-6-thinking'), 160000);
    assert.strictEqual(lsclient.guessContextLimit('gemini-3.1-pro-low'), 128000);
    assert.strictEqual(lsclient.guessContextLimit('gemini-3.8-flash-high'), 256000);
    assert.strictEqual(lsclient.guessContextLimit('gemini-2.5-flash-lite'), 128000); // <3.5 走旧档
    assert.strictEqual(lsclient.guessContextLimit('gpt-oss-120b-medium'), 80000);
    // placeholder 按编号精确比对：m26 是 Claude，但 m264 绝不能被子串误命中
    assert.strictEqual(lsclient.guessContextLimit('MODEL_PLACEHOLDER_M26'), 160000);
    assert.strictEqual(lsclient.guessContextLimit('MODEL_PLACEHOLDER_M264'), 256000);
    assert.strictEqual(lsclient.guessContextLimit('unknown-model'), 160000);
  });

  await test('parseTrajectories 按 lastModifiedTime 降序 + requestedModel 优先', () => {
    const convs = lsclient.parseTrajectories({
      'conv-1': { summary: '旧', lastModifiedTime: '2026-09-30T09:00:00Z' },
      'conv-2': {
        summary: '新',
        lastModifiedTime: '2026-10-01T16:00:00Z',
        latestTaskBoundaryStep: {
          step: {
            metadata: {
              generatorModel: 'gemini-3.8-flash-high',
              requestedModel: { model: 'claude-sonnet-4-6' },
            },
          },
        },
      },
    });
    assert.strictEqual(convs[0].cascadeId, 'conv-2');
    assert.strictEqual(convs[0].model, 'claude-sonnet-4-6'); // requestedModel 覆盖 generatorModel
    assert.strictEqual(convs[1].cascadeId, 'conv-1');
  });

  await test('parseConversationSteps：PLANNER_RESPONSE 用量 + 压缩 + 工具输出', () => {
    // 真实形态：modelUsage 挂在 PLANNER_RESPONSE 上，CHECKPOINT 一个都不带
    const p = lsclient.parseConversationSteps([
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { modelUsage: { model: 'm', inputTokens: '3000', cacheReadTokens: '27000', outputTokens: '1200' } } },
      { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 120 } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { modelUsage: { model: 'm', inputTokens: '4200', cacheReadTokens: '63800', outputTokens: '1800' } } },
      // 压缩点：缓存归零，总数 69800 → 53500
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { modelUsage: { model: 'm', inputTokens: '52000', cacheReadTokens: '0', outputTokens: '1500' } } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { modelUsage: { model: 'm', inputTokens: '3211', cacheReadTokens: '76689', outputTokens: '2100' } } },
    ]);
    assert.strictEqual(p.usageSteps, 4);
    assert.strictEqual(p.lastUsage.inputTokens, 3211);
    assert.strictEqual(p.lastUsage.cacheReadTokens, 76689);
    assert.strictEqual(p.lastUsage.ctx, 3211 + 76689 + 2100);
    assert.strictEqual(p.compressed, true);
    assert.strictEqual(p.compressionDrop, 16300);
    assert.strictEqual(p.toolOutputTokens, 120);
  });

  await test('parseConversationSteps：CHECKPOINT 形态仍然兼容', () => {
    const p = lsclient.parseConversationSteps([
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', metadata: { modelUsage: { model: 'm', inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '50' } } },
    ]);
    assert.strictEqual(p.usageSteps, 1);
    assert.strictEqual(p.lastUsage.ctx, 10050);
    assert.strictEqual(p.compressed, false);
  });

  await test('tailSteps：本地截尾只保留最新 N 步', () => {
    // LS 忽略 startIndex/endIndex，永远返回全量；截尾防止大会话每轮全量遍历
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepStrictEqual(lsclient.tailSteps(arr, 3), [8, 9, 10]);
    assert.deepStrictEqual(lsclient.tailSteps(arr, 99), arr);
    assert.deepStrictEqual(lsclient.tailSteps(null, 3), []);
  });

  console.log('\nE2E（mock LS 全链路）');

  await test('getContext：预算数据 + 截断状态随调用推进', async () => {
    const ctx1 = await lsclient.getContext();
    assert.ok(ctx1.ok);
    assert.strictEqual(ctx1.total, 1673);
    assert.strictEqual(ctx1.budget, 20000);
    assert.strictEqual(ctx1.truncated, false);
    assert.strictEqual(ctx1.groups.length, 2);

    const ctx2 = await lsclient.getContext();
    assert.strictEqual(ctx2.truncated, true); // mock 第 2 次返回已截断
  });

  await test('getConversation：真实上下文 = 新增 + 缓存命中 + 输出', async () => {
    const conv = await lsclient.getConversation();
    assert.ok(conv.ok);
    const c = conv.conversation;
    assert.strictEqual(c.cascadeId, 'conv-2-aaaa');
    assert.strictEqual(c.model, 'gemini-3.8-flash-high'); // PLANNER_RESPONSE 的 modelUsage.model 优先
    // 曾漏掉 cacheReadTokens，会把 82000 低估成 5311
    assert.strictEqual(c.used, 3211 + 76689 + 2100);
    assert.strictEqual(c.limit, 256000);
    assert.strictEqual(c.cacheReadTokens, 76689);
    assert.strictEqual(c.usageSteps, 4);
    assert.strictEqual(c.checkpoints, 4); // 兼容字段，语义同 usageSteps
    assert.strictEqual(c.compressed, true);
    assert.strictEqual(c.compressionDrop, 16300);
    assert.strictEqual(c.toolOutputTokens, 350 + 120);
    assert.strictEqual(conv.others.length, 1);
    assert.strictEqual(conv.others[0].cascadeId, 'conv-1-bbbb');
  });

  await test('getUserStatus：官方额度 + proto3 缺省坑 + 套餐', async () => {
    const st = await lsclient.getUserStatus();
    assert.ok(st.ok);
    assert.strictEqual(st.plan, 'Google AI Pro');
    assert.strictEqual(st.models.length, 3);
    const gemini = st.models.find((m) => m.model === 'gemini-3.8-flash-high');
    // remainingFraction 缺失 + resetTime 未来 → 已用尽 0%
    assert.strictEqual(gemini.remainingPercent, 0);
    assert.strictEqual(gemini.resetTime, '2026-10-02T03:00:00Z');
    assert.strictEqual(gemini.isDefault, true);
    const claude = st.models.find((m) => m.model === 'claude-sonnet-4-6');
    // remainingFraction 缺失 + epoch resetTime → 未动 100%
    assert.strictEqual(claude.remainingPercent, 100);
    const pro = st.models.find((m) => m.model === 'gemini-3.1-pro-low');
    assert.strictEqual(pro.remainingPercent, 78.5);
    assert.strictEqual(st.credits.length, 1);
  });

  await test('格式化输出', () => {
    assert.strictEqual(lsclient.fmtNum(1673), '1.7k');
    assert.strictEqual(lsclient.fmtNum(20000), '20.0k');
    assert.strictEqual(lsclient.fmtNum(82100), '82.1k');
    assert.strictEqual(lsclient.fmtNum(1048576), '1.0M');
    assert.strictEqual(lsclient.fmtNum(42), '42');
    assert.strictEqual(lsclient.statusDot(30), '🔵');
    assert.strictEqual(lsclient.statusDot(70), '🟠');
    assert.strictEqual(lsclient.statusDot(90), '🔴');
  });

  server.close();
  console.log(`\n${passed} 通过${process.exitCode ? '，存在失败用例' : '，全部绿'}`);
})();
