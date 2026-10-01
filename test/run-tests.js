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

  await test('parseConversationSteps：末 checkpoint 用量 + 压缩检测 + 工具输出', () => {
    const p = lsclient.parseConversationSteps([
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', metadata: { modelUsage: { model: 'm', inputTokens: '68000', outputTokens: '1800' } } },
      { type: 'CORTEX_STEP_TYPE_TOOL_CALL', metadata: { toolCallOutputTokens: 120 } },
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', metadata: { modelUsage: { model: 'm', inputTokens: '52000', outputTokens: '1500' } } },
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', metadata: { modelUsage: { model: 'm', inputTokens: '80000', outputTokens: '2100' } } },
    ]);
    assert.strictEqual(p.checkpointCount, 3);
    assert.strictEqual(p.lastUsage.inputTokens, 80000);
    assert.strictEqual(p.compressed, true);
    assert.strictEqual(p.compressionDrop, 16000);
    assert.strictEqual(p.toolOutputTokens, 120);
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

  await test('getConversation：最新会话用量 82100/256000 + 压缩 + 会话列表', async () => {
    const conv = await lsclient.getConversation();
    assert.ok(conv.ok);
    const c = conv.conversation;
    assert.strictEqual(c.cascadeId, 'conv-2-aaaa');
    assert.strictEqual(c.model, 'gemini-3.8-flash-high'); // checkpoint 的 modelUsage.model 优先
    assert.strictEqual(c.used, 80000 + 2100);
    assert.strictEqual(c.limit, 256000);
    assert.strictEqual(c.checkpoints, 4);
    assert.strictEqual(c.compressed, true);
    assert.strictEqual(c.compressionDrop, 16000);
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
