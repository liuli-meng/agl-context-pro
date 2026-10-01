/**
 * AGL Context Pro —— Antigravity 上下文用量监控扩展
 *
 * 状态栏双显示：
 *   ① 上下文预算（Rules/Skills 自定义内容，GetTokenBase）
 *   ② 当前对话用量（最新 cascade 会话的 checkpoint token，模型上限自动映射）
 * 悬停看分项，点击看完整明细；预算发生截断时弹告警（每次会话只提醒一次）。
 */
'use strict';

const vscode = require('vscode');
const lsclient = require('./lsclient');

const STATUS_PRIORITY = 100;
const REDISCOVER_BACKOFF_MS = 15000; // 发现失败后的最小重试间隔

let statusItem = null;
let timer = null;
let polling = false;
let lastDiscoverFail = 0;
let lastTruncated = false; // 截断告警去重：只在 false→true 跳变时提醒
let lastConvId = null;     // 新会话重置截断提醒状态

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, STATUS_PRIORITY);
  statusItem.name = 'AGL 上下文';
  statusItem.command = 'aglContext.showDetail';
  statusItem.text = '$(dashboard) ⚪ AGL…';
  statusItem.tooltip = new vscode.MarkdownString('正在发现 Antigravity language server…');
  statusItem.show();

  const cmdDetail = vscode.commands.registerCommand(
    'aglContext.showDetail', showDetail);
  const cmdRefresh = vscode.commands.registerCommand(
    'aglContext.refreshNow', () => poll(true));
  context.subscriptions.push(statusItem, cmdDetail, cmdRefresh);

  // 首次立即查，之后按配置轮询
  poll(true);
  schedulePolling();

  context.subscriptions.push({
    dispose() { if (timer) { clearInterval(timer); timer = null; } },
  });
}

function schedulePolling() {
  if (timer) clearInterval(timer);
  const cfg = vscode.workspace.getConfiguration('aglContext');
  const sec = Math.max(2, cfg.get('pollSeconds', 5));
  timer = setInterval(() => poll(false), sec * 1000);
}

async function poll(isManual) {
  if (polling) return;
  polling = true;
  try {
    // 预算与对话两路并行；对话失败不影响预算显示
    const [ctx, conv] = await Promise.all([
      lsclient.getContext(),
      lsclient.getConversation().catch(() => ({ ok: false, error: '' })),
    ]);

    if (ctx.ok) {
      lastDiscoverFail = 0;
      render(ctx, conv.ok ? conv : null);
      warnOnTruncation(ctx, conv.ok ? conv : null);
    } else {
      // 发现失败做节流，避免每个轮询周期都起一遍 PowerShell
      const now = Date.now();
      if (isManual || now - lastDiscoverFail > REDISCOVER_BACKOFF_MS) {
        lastDiscoverFail = now;
      }
      renderOffline(ctx.error);
    }
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- 渲染

function render(ctx, conv) {
  const dot = lsclient.statusDot(ctx.percent);
  const showConv = vscode.workspace.getConfiguration('aglContext')
    .get('showConversation', true);
  let text = `$(dashboard) ${dot} ${ctx.percent.toFixed(1)}% · `
    + `${lsclient.fmtNum(ctx.total)}/${lsclient.fmtNum(ctx.budget)}`;

  let convPercent = null;
  if (showConv && conv && conv.conversation && conv.conversation.used > 0) {
    const c = conv.conversation;
    convPercent = c.percent;
    const cdot = lsclient.statusDot(c.percent);
    const flag = c.compressed ? '⚠' : '';
    text += `  │ ${cdot} ${lsclient.fmtNum(c.used)}/${lsclient.fmtNum(c.limit)}${flag}`;
  }
  statusItem.text = text;

  const worst = Math.max(ctx.percent, convPercent || 0);
  if (worst >= 85) {
    statusItem.backgroundColor =
      new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    statusItem.backgroundColor = undefined;
  }

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  md.appendMarkdown('**Antigravity 上下文预算**\n\n');
  md.appendMarkdown(`${ctx.total} / ${ctx.budget} tokens（**${ctx.percent.toFixed(1)}%**），`
    + `剩余 ${ctx.remaining}\n\n`);
  if (ctx.truncated) md.appendMarkdown('⚠ **部分自定义内容已被截断**\n\n');
  for (const g of ctx.groups) {
    md.appendMarkdown(`- **${g.name}**：${g.numTokens}（${(g.children || []).length} 项）\n`);
  }

  if (conv && conv.conversation && conv.conversation.used > 0) {
    const c = conv.conversation;
    md.appendMarkdown('\n\n---\n\n**当前对话**\n\n');
    md.appendMarkdown(`${c.summary}\n\n`);
    md.appendMarkdown(`${c.used} / ${c.limit} tokens（**${c.percent.toFixed(1)}%**）`
      + ` · 模型 \`${c.model || '?'}\`\n\n`);
    md.appendMarkdown(`checkpoints ${c.checkpoints} · input ${c.inputTokens}`
      + ` + output ${c.outputTokens} + 工具输出≈${c.toolOutputTokens}\n\n`);
    if (c.compressed) {
      md.appendMarkdown(`ℹ 已发生自动压缩（上下文回落 ${lsclient.fmtNum(c.compressionDrop)} tokens）\n\n`);
    }
  }

  md.appendMarkdown(`\n\n_数据源 language_server · 端口 ${ctx.session.port} · 点击状态栏看逐项明细_`);
  statusItem.tooltip = md;
}

function renderOffline(err) {
  statusItem.text = '$(dashboard) ⚪ AGL 未连接';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**未连接到 language_server**\n\n${err || ''}\n\n`);
  md.appendMarkdown('打开 Antigravity（桌面版或本 IDE）后自动重连。');
  statusItem.tooltip = md;
}

/** 截断告警：预算或对话从「未截断→截断」跳变时弹一次；新会话重置状态 */
function warnOnTruncation(ctx, conv) {
  const convId = conv && conv.conversation ? conv.conversation.cascadeId : null;
  if (convId !== lastConvId) {
    lastConvId = convId;
    lastTruncated = false; // 换会话后允许重新告警
  }
  const nowTruncated = !!ctx.truncated;
  if (nowTruncated && !lastTruncated) {
    vscode.window.showWarningMessage(
      'AGL：上下文预算已发生截断 —— 部分自定义 Rules/Skills 未完整注入，'
      + '建议精简全局规则或关闭部分 Skills。');
  }
  lastTruncated = nowTruncated;
}

// ---------------------------------------------------------------- 明细弹层

async function showDetail() {
  const [ctx, conv] = await Promise.all([
    lsclient.getContext(),
    lsclient.getConversation().catch(() => ({ ok: false, error: '' })),
  ]);
  if (!ctx.ok) {
    vscode.window.showInformationMessage('AGL：' + ctx.error);
    return;
  }

  const items = [];
  items.push({
    label: '$(info) 上下文预算',
    description: `${ctx.total} / ${ctx.budget}（${ctx.percent.toFixed(1)}%）`,
    detail: `剩余 ${ctx.remaining} · 规则预算剩余 ${ctx.rulesRemaining}`
      + (ctx.truncated ? ' · ⚠已发生截断' : ''),
  });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

  const c = conv.ok && conv.conversation;
  if (c && c.used > 0) {
    items.push({
      label: `$(comment-discussion) 对话：${c.summary}`,
      description: `${c.used} / ${c.limit}（${c.percent.toFixed(1)}%）`,
      detail: `模型 ${c.model || '?'} · checkpoints ${c.checkpoints}`
        + ` · input ${c.inputTokens} + output ${c.outputTokens} + 工具输出≈${c.toolOutputTokens}`
        + (c.compressed ? ` · ⚠已压缩（回落 ${c.compressionDrop}）` : ''),
    });
    for (const o of conv.others) {
      items.push({
        label: `   $(history) ${o.summary}`,
        description: `${o.status} · ${o.stepCount} 步`,
        detail: o.lastModifiedTime,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }

  for (const g of ctx.groups) {
    items.push({
      label: `$(folder) ${g.name}`,
      description: `小计 ${g.numTokens} tokens`,
    });
    for (const ch of (g.children || [])) {
      items.push({
        label: `    ${ch.name}`,
        description: `${ch.numTokens} tokens`,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'AGL 上下文明细（预算 + 对话）',
    placeHolder: 'Esc 关闭 · 点「上下文预算」概要行可复制全文',
  });

  if (picked && picked.label.startsWith('$(info)')) {
    vscode.env.clipboard.writeText(renderPlainText(ctx, conv.ok ? conv : null));
    vscode.window.showInformationMessage('AGL：明细已复制到剪贴板');
  }
}

function renderPlainText(ctx, conv) {
  const lines = [];
  lines.push(`上下文预算: ${ctx.total} / ${ctx.budget} tokens`
    + ` (${ctx.percent.toFixed(1)}%), 剩余 ${ctx.remaining}`);
  if (ctx.truncated) lines.push('⚠ 已发生截断');
  for (const g of ctx.groups) {
    lines.push(`【${g.name}】小计 ${g.numTokens}`);
    for (const ch of (g.children || [])) {
      lines.push(`    ${String(ch.numTokens).padStart(6)}  ${ch.name}`);
    }
  }
  const c = conv && conv.conversation;
  if (c && c.used > 0) {
    lines.push('');
    lines.push(`当前对话: ${c.summary}`);
    lines.push(`  ${c.used} / ${c.limit} tokens (${c.percent.toFixed(1)}%)`
      + ` · 模型 ${c.model || '?'} · checkpoints ${c.checkpoints}`);
    lines.push(`  input ${c.inputTokens} + output ${c.outputTokens}`
      + ` + 工具输出≈${c.toolOutputTokens}`
      + (c.compressed ? ` · ⚠已压缩（回落 ${c.compressionDrop}）` : ''));
    for (const o of conv.others) {
      lines.push(`  - ${o.summary} (${o.status}, ${o.stepCount} 步)`);
    }
  }
  return lines.join('\n');
}

function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { activate, deactivate };
