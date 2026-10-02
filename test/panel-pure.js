/**
 * panel.js 纯函数单测 —— 补上原本缺失的覆盖。
 *
 * 为什么需要这个文件：
 *   panel.js 是 IIFE、依赖 window/document，没法直接 require，
 *   所以它的 computeUsageFromSteps / limitOf 一直没被测过，
 *   「模型名被非 usage 步骤污染」这个 bug 才漏了过去。
 *
 * 做法：按行号从 panel.js 里**原样切出**纯函数段（不复制粘贴，避免两份代码漂移），
 * 拼成一段可求值的代码，喂给 new Function。
 * 切出后立即断言「切到的片段里确实含目标函数名」，防止行号漂移导致静默失效。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'desktop-inject', 'src', 'panel.js');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

/** 按起止行（1-based，含端点）取片段 */
function slice(from, to) {
  return lines.slice(from - 1, to).join('\n');
}

/** 找某个函数体的结束行：从签名行往下数到配平的 `}` */
function findEnd(startLine1) {
  let depth = 0;
  let started = false;
  for (let i = startLine1 - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) return i + 1;
  }
  throw new Error('找不到函数结束行，起始 ' + startLine1);
}

function lineOf(pattern) {
  const i = lines.findIndex(l => pattern.test(l));
  if (i < 0) throw new Error('找不到: ' + pattern);
  return i + 1;
}

// —— 定位并切片 ——
const constStart = lineOf(/^\s*var M = \{/);
const constEnd = lineOf(/^\s*function limitOf\(/);
const helpStart = lineOf(/^\s*function limitOf\(/);
const helpEnd = lineOf(/^\s*function loadModels\(/);
const usageStart = lineOf(/^\s*function usageOf\(/);
const usageEnd = lineOf(/^\s*function loadModels\(/);

const consts = slice(constStart, constEnd - 1);
const helpers = slice(helpStart, helpEnd - 1);
const usage = slice(usageStart, usageEnd - 1);

// 防漂移：必须真的切到东西
for (const [name, chunk] of [
  ['常量段', consts], ['helpers 段', helpers], ['usage 段', usage],
]) {
  assert.ok(chunk.trim().length > 50, name + ' 切出来是空的，行号漂了');
}
assert.ok(/var M = \{/.test(consts), '常量段缺 M');
assert.ok(/function limitOf/.test(helpers), 'helpers 段缺 limitOf');
assert.ok(/function computeUsageFromSteps/.test(usage), 'usage 段缺 computeUsageFromSteps');

// —— 在沙箱里求值 ——
const src = `
  var LABELS = typeof LABELS !== 'undefined' ? LABELS : {};
  ${consts}
  ${helpers}
  ${usage}
  __EXPORT__.limitOf = limitOf;
  __EXPORT__.nameOf = nameOf;
  __EXPORT__.usageOf = usageOf;
  __EXPORT__.computeUsageFromSteps = computeUsageFromSteps;
  __EXPORT__.M = M;
`;

const P = {};
const names = ['LABELS', 'EST_OVERHEAD', 'SYS_PROMPT_OVERHEAD', 'USER_INPUT_FALLBACK',
  'PLANNER_FALLBACK', 'COMPRESS_MIN_DROP', 'MAX_STEPS', 'BATCH', 'CONCURRENCY'];
const vals = [undefined, 0, 10000, 500, 800, 5000, 2000, 50, 5];
new Function(...names, '__EXPORT__', src)(...vals, P);

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; fails.push(name); console.log('  ✖ ' + name + '\n      ' + e.message); }
}

console.log('panel.js 纯函数单测');

// ---------- limitOf ----------
console.log('\nlimitOf 模型分支');
test('Claude 系 → 200K', () => {
  assert.strictEqual(P.limitOf('MODEL_PLACEHOLDER_M26'), 200000);
  assert.strictEqual(P.limitOf('claude-sonnet-4-6'), 200000);
});
test('Gemini 系 → 1M', () => {
  assert.strictEqual(P.limitOf('MODEL_PLACEHOLDER_M318'), 1000000);
  assert.strictEqual(P.limitOf('gemini-3.8-flash-high'), 1000000);
});
test('GPT-OSS → 128K', () => {
  assert.strictEqual(P.limitOf('gpt-oss-120b'), 128000);
});
test('空/未知 → 兜底 1M', () => {
  assert.strictEqual(P.limitOf(''), 1000000);
  assert.strictEqual(P.limitOf(undefined), 1000000);
});

// ---------- 模型名解析（★ 核心回归） ----------
console.log('\n模型解析优先级');

test('★ 末次 usage 的模型胜出（后续无关步骤不污染）', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { generatorModel: 'MODEL_PLACEHOLDER_M26',
                  modelUsage: { model: 'MODEL_PLACEHOLDER_M26',
                                inputTokens: '1000', outputTokens: '10' } } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT',
      metadata: { generatorModel: 'MODEL_PLACEHOLDER_M318' } },
  ];
  const r = P.computeUsageFromSteps(steps, '');
  assert.strictEqual(r.model, 'MODEL_PLACEHOLDER_M26',
    '真实模型应是 M26，被后续无关步骤的 M318 污染了');
});

test('requestedModel 为空对象时不覆盖已有模型', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { generatorModel: 'MODEL_PLACEHOLDER_M318',
                  modelUsage: { model: 'MODEL_PLACEHOLDER_M318',
                                inputTokens: '500', outputTokens: '5' } } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { requestedModel: {}, generatorModel: '' } },
  ];
  const r = P.computeUsageFromSteps(steps, '');
  assert.strictEqual(r.model, 'MODEL_PLACEHOLDER_M318');
});

test('真切换模型：取最后一次 usage 的模型（分母随之变）', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318',
                                inputTokens: '1000', outputTokens: '10' } } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M26',
                                inputTokens: '2000', outputTokens: '20' } } },
  ];
  const r = P.computeUsageFromSteps(steps, '');
  assert.strictEqual(r.model, 'MODEL_PLACEHOLDER_M26');
  assert.strictEqual(P.limitOf(r.model), 200000);
});

test('完全没有 usage 时用 initialModel 兜底', () => {
  const steps = [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} }];
  const r = P.computeUsageFromSteps(steps, 'MODEL_PLACEHOLDER_M26');
  assert.strictEqual(r.model, 'MODEL_PLACEHOLDER_M26');
  assert.strictEqual(r.hasCkpt, false);
});

// ---------- 现有行为回归 ----------
console.log('\n用量计算回归');

test('上下文 = input + cacheRead + output', () => {
  const steps = [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'M', inputTokens: '2721',
                              cacheReadTokens: '191639', outputTokens: '588' } } }];
  const r = P.computeUsageFromSteps(steps, '');
  assert.strictEqual(r.used, 2721 + 191639 + 588);
  assert.strictEqual(r.cacheRead, 191639);
});

test('压缩检测：跌幅 > 5000 才判压缩', () => {
  const mk = (ctx) => ({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { modelUsage: { model: 'M', inputTokens: String(ctx), outputTokens: '1' } } });
  assert.strictEqual(P.computeUsageFromSteps([mk(100000), mk(50000)], '').compressed, true);
  assert.strictEqual(P.computeUsageFromSteps([mk(100000), mk(98000)], '').compressed, false);
});

test('usage 后的工具输出与估算增量计入 used', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { modelUsage: { model: 'M', inputTokens: '1000', outputTokens: '10' } } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { toolCallOutputTokens: 500 } },
  ];
  const r = P.computeUsageFromSteps(steps, '');
  assert.ok(r.used > 1000, 'used 应包含 usage 之后的增量');
  assert.strictEqual(r.src, 'mixed');
});

console.log('\n' + passed + ' 通过，' + (failed ? failed + ' 失败' : '全部绿'));
if (failed) console.log('失败项: ' + fails.join(' / '));
process.exit(failed ? 1 : 0);
