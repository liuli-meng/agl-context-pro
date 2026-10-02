/* === [START] Antigravity 上下文用量悬浮面板 === */
/*
 * 注入到 dist/preload.js，运行在 Antigravity 主界面（LS 提供的 https://127.0.0.1:<port>/）。
 *
 * 同源优势：页面本身就跑在 LS 端口上，因此可以直接 fetch LS 的 RPC，
 * 不需要 psutil / 日志解析那一套外部探测。
 *
 * UI：右下角浮动胶囊显示占用百分比，点击展开卡片（对标 DeepSeek / ZCode）。
 */
(function () {
  'use strict';

  if (window.__AGL_CTX_PANEL__) return;

  var CFG = {
    POLL_MS: 5000,
    RPC_TIMEOUT: 12000,
    API: '/exa.language_server_pb.LanguageServerService/',
  };

  // ---------------------------------------------------------------- 颜色
  var C = {
    ok: '#3b82f6',
    warn: '#f59e0b',
    danger: '#ef4444',
    sys: '#9aa3ad',
    tool: '#8b7cf6',
    conv: '#3b82f6',
    rule: '#10b981',
    track: 'rgba(127,127,127,.22)',
  };

  // ---------------------------------------------------------------- 模型
  // 窗口上限：按模型家族估算。真正的上限 LS 不返回，只能本地推断。
  var M = {
    GEMINI: 1000000,   // Gemini 3.x 系列（Flash / Pro）
    CLAUDE: 200000,    // Claude 4.6
    GPT_OSS: 128000,   // GPT-OSS 120B
  };

  // 兜底映射（真实名称优先从 GetCascadeModelConfigData 动态拿）
  var FALLBACK_LABELS = {
    MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
    MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
    MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
    MODEL_PLACEHOLDER_M298: 'Gemini 3.7 Flash (High)',
    MODEL_PLACEHOLDER_M299: 'Gemini 3.7 Flash (Medium)',
    MODEL_PLACEHOLDER_M300: 'Gemini 3.7 Flash (Low)',
    MODEL_PLACEHOLDER_M71: 'Gemini 3.6 Flash (High)',
    MODEL_PLACEHOLDER_M72: 'Gemini 3.6 Flash (Medium)',
    MODEL_PLACEHOLDER_M73: 'Gemini 3.6 Flash (Low)',
    MODEL_PLACEHOLDER_M16: 'Gemini 3.1 Pro (High)',
    MODEL_PLACEHOLDER_M36: 'Gemini 3.1 Pro (Low)',
    MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6',
    MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6',
    MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B',
  };

  // modelId 前缀 → 窗口上限
  function limitByModelId(mid) {
    var s = String(mid || '').toLowerCase();
    if (/gemini/.test(s)) return M.GEMINI;
    if (/claude/.test(s)) return M.CLAUDE;
    if (/gpt-oss|gpt_oss/.test(s)) return M.GPT_OSS;
    return M.GEMINI;
  }

  function limitOf(model, modelId) {
    var s = String(model || '') + ' ' + String(modelId || '');
    var low = s.toLowerCase();
    if (/claude|opus|sonnet/.test(low)) return M.CLAUDE;
    if (/gpt-oss|gpt_oss|gpt-oss-120/.test(low)) return M.GPT_OSS;
    if (/gemini|MODEL_PLACEHOLDER/i.test(s)) return M.GEMINI;
    return M.GEMINI;
  }

  function nameOf(model) {
    if (!model) return '—';
    if (LABELS[model]) return LABELS[model];
    if (FALLBACK_LABELS[model]) return FALLBACK_LABELS[model];
    return String(model).replace('MODEL_PLACEHOLDER_', 'Gemini ')
      .replace('MODEL_OPENAI_', '').replace(/_/g, ' ');
  }

  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return '~' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return '~' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
    return '~' + Math.round(n);
  }

  // ---------------------------------------------------------------- RPC
  function rpc(method, body) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, CFG.RPC_TIMEOUT);
      fetch(CFG.API + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        credentials: 'same-origin',
        signal: ctrl.signal,
      }).then(function (r) {
        clearTimeout(to);
        if (!r.ok) { reject(new Error(method + ' HTTP ' + r.status)); return; }
        return r.text();
      }).then(function (t) {
        if (t === undefined) return;
        try { resolve(t.trim() ? JSON.parse(t) : {}); }
        catch (e) { reject(e); }
      }).catch(function (e) { clearTimeout(to); reject(e); });
    });
  }

  // ---------------------------------------------------------------- 取数
  var BUDGET = { groups: [], total: 0, budget: 0, remaining: 0, truncated: false };
  var CONV = { ok: false, used: 0, limit: 0, input: 0, cache: 0, model: '', modelId: '', summary: '', steps: 0, compressed: false };
  var LABELS = {};   // model -> 官方 label（动态拉取）

  /** 官方模型表：把 MODEL_PLACEHOLDER_XXX → "Gemini 3.8 Flash (High)" */
  function loadModels() {
    return rpc('GetCascadeModelConfigData', {}).then(function (d) {
      var cfgs = (d && d.clientModelConfigs) || [];
      cfgs.forEach(function (c) {
        var m = (c.modelOrAlias || {}).model;
        if (m && c.label) LABELS[m] = c.label;
      });
    }).catch(function () { /* 保留兜底表 */ });
  }

  function loadBudget() {
    return rpc('GetTokenBase').then(function (d) {
      var base = (d && d.customizationTokenBase) || {};
      BUDGET.groups = base.groups || [];
      BUDGET.total = base.totalTokens || 0;
      BUDGET.budget = (d && d.customizationBudget) || 0;
      BUDGET.remaining = (d && d.remainingBudget) || 0;
      BUDGET.truncated = !!(d && d.truncatedCustomizationTokenBase &&
        Object.keys(d.truncatedCustomizationTokenBase).length);
    }).catch(function () { /* 保留上次值 */ });
  }

  function loadConversation() {
    return rpc('GetAllCascadeTrajectories', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    }).then(function (d) {
      var sums = (d && d.trajectorySummaries) || {};
      var keys = Object.keys(sums);
      if (!keys.length) throw new Error('no session');
      keys.sort(function (a, b) {
        return String((sums[b] || {}).lastModifiedTime || '')
          .localeCompare(String((sums[a] || {}).lastModifiedTime || ''));
      });
      var cid = keys[0];
      var meta = sums[cid] || {};
      var steps = Number(meta.stepCount) || 0;
      var model = '', modelId = '';
      ['latestTaskBoundaryStep', 'latestNotifyUserStep'].forEach(function (k) {
        var mm = ((meta[k] || {}).step || {}).metadata || {};
        if (mm.generatorModel) model = mm.generatorModel;
        var rq = mm.requestedModel || {};
        if (rq.model) model = rq.model;
      });
      var start = Math.max(0, steps - 400);
      return rpc('GetCascadeTrajectorySteps', {
        cascadeId: cid, startIndex: start, endIndex: steps,
      }).then(function (sr) {
        var arr = (sr && sr.steps) || [];
        var last = null, prevTotal = -1, compressed = false;
        for (var i = 0; i < arr.length; i++) {
          var st = arr[i] || {};
          var ty = st.type || '';
          var md = st.metadata || {};
          if (ty === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || ty === 'CORTEX_STEP_TYPE_CHECKPOINT') {
            var mu = md.modelUsage;
            if (mu) {
              var it = parseInt(mu.inputTokens, 10) || 0;
              var cr = parseInt(mu.cacheReadTokens, 10) || 0;
              var tot = it + cr;
              if (prevTotal > 0 && tot < prevTotal && (prevTotal - tot) > 20000) compressed = true;
              prevTotal = tot;
              last = { it: it, cr: cr, model: mu.model || '' };
            }
          }
        }
        CONV.ok = true;
        CONV.used = last ? (last.it + last.cr) : 0;
        CONV.input = last ? last.it : 0;
        CONV.cache = last ? last.cr : 0;
        CONV.model = (last && last.model) || model;
        CONV.limit = limitOf(CONV.model, modelId);
        CONV.summary = meta.summary || cid;
        CONV.steps = steps;
        CONV.compressed = compressed;
      });
    }).catch(function () { CONV.ok = false; });
  }

  function refresh() {
    return Promise.all([loadModels(), loadBudget(), loadConversation()]).then(function () {
      render();
    });
  }

  // ---------------------------------------------------------------- 计算
  var SYS_TOK = 1500;
  var TOOL_TOK = 5600;

  function metrics() {
    var convTok = CONV.ok ? CONV.used : 0;
    // ⚠ 不能拿 BUDGET.budget(20000, 那是 Rules/Skills 预算) 当上下文窗口，
    // 否则无会话时会虚报 ~44%。拿不到会话就退回 1M（Gemini 3.x 的窗口）。
    var limit = (CONV.ok && CONV.limit) ? CONV.limit : M.GEMINI;
    var total = SYS_TOK + TOOL_TOK + convTok;
    var pct = limit ? (100 * total / limit) : 0;
    return {
      convTok: convTok, limit: limit, total: total,
      pct: Math.max(0, Math.min(pct, 100)),
      rawPct: pct, known: CONV.ok,
    };
  }

  function stateColor(pct) {
    if (pct >= 85) return C.danger;
    if (pct >= 65) return C.warn;
    return C.ok;
  }

  // ---------------------------------------------------------------- 样式
  var CSS = [
    '#agl-ctx{position:fixed;right:18px;bottom:18px;z-index:2147483000;',
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;',
    '-webkit-user-select:none;user-select:none}',
    '#agl-ctx *{box-sizing:border-box}',
    '.agl-pill{display:flex;align-items:center;gap:8px;padding:7px 13px 7px 9px;',
    'border-radius:999px;cursor:pointer;background:rgba(28,28,32,.86);',
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'border:1px solid rgba(255,255,255,.10);',
    'box-shadow:0 3px 14px rgba(0,0,0,.30);transition:transform .13s ease,box-shadow .13s ease}',
    '.agl-pill:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.38)}',
    '.agl-ring{width:17px;height:17px;flex:0 0 auto}',
    '.agl-pct{font-size:12.5px;font-weight:600;color:#f2f3f5;letter-spacing:.2px}',
    '.agl-cap{font-size:11.5px;color:#a9adb6}',
    '.agl-ml{font-size:11px;color:#8b9099;max-width:108px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',

    '.agl-card{position:absolute;right:0;bottom:calc(100% + 10px);width:344px;',
    'border-radius:14px;padding:18px 20px 16px;background:rgba(30,30,34,.97);',
    'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);',
    'border:1px solid rgba(255,255,255,.11);box-shadow:0 12px 42px rgba(0,0,0,.5);',
    'color:#eceef1;opacity:0;transform:translateY(8px) scale(.98);pointer-events:none;',
    'transition:opacity .16s ease,transform .16s ease}',
    '.agl-card.open{opacity:1;transform:none;pointer-events:auto}',

    '.agl-hd{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px}',
    '.agl-hd .t{font-size:13px;color:#a9adb6}',
    '.agl-hd .p{font-size:26px;font-weight:700;line-height:1;margin-left:8px}',
    '.agl-hd .c{font-size:13px;font-weight:600;color:#eceef1}',

    '.agl-bar{display:flex;height:9px;border-radius:5px;overflow:hidden;',
    'background:rgba(127,127,127,.24);margin-bottom:15px}',
    '.agl-bar i{display:block;height:100%}',

    '.agl-row{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px}',
    '.agl-dot{width:9px;height:9px;border-radius:2.5px;flex:0 0 auto}',
    '.agl-row .l{flex:1;color:#d6d9de}',
    '.agl-row .v{font-variant-numeric:tabular-nums;color:#eceef1;font-weight:500}',

    '.agl-ft{margin-top:12px;padding-top:11px;border-top:1px solid rgba(255,255,255,.09);',
    'font-size:11px;color:#8b9099;line-height:1.65}',
    '.agl-warn{color:#f59e0b}',
  ].join('');

  function ringSvg(pct) {
    var col = stateColor(pct);
    var r = 6.6, cir = 2 * Math.PI * r;
    var off = cir * (1 - Math.min(pct, 100) / 100);
    return '<svg class="agl-ring" viewBox="0 0 17 17">'
      + '<circle cx="8.5" cy="8.5" r="' + r + '" fill="none" stroke="' + C.track + '" stroke-width="2.6"/>'
      + '<circle cx="8.5" cy="8.5" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="2.6"'
      + ' stroke-linecap="round" stroke-dasharray="' + cir.toFixed(1) + '"'
      + ' stroke-dashoffset="' + off.toFixed(1) + '"'
      + ' transform="rotate(-90 8.5 8.5)"/></svg>';
  }

  // ---------------------------------------------------------------- DOM
  var root, pill, card, open = false;

  function build() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    root = document.createElement('div');
    root.id = 'agl-ctx';
    root.innerHTML =
      '<div class="agl-card" id="agl-card"></div>'
      + '<div class="agl-pill" id="agl-pill"></div>';
    document.body.appendChild(root);

    pill = root.querySelector('#agl-pill');
    card = root.querySelector('#agl-card');

    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      open = !open;
      card.classList.toggle('open', open);
      if (open) refresh();
    });
    card.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      if (open) { open = false; card.classList.remove('open'); }
    });
  }

  function render() {
    if (!root) return;
    var m = metrics();
    var col = m.known ? stateColor(m.pct) : '#8b9099';

    // 胶囊
    var capTxt = fmtTok(m.total) + ' / ' + fmtTok(m.limit);
    pill.innerHTML = ringSvg(m.known ? m.pct : 0)
      + '<span class="agl-pct" style="color:' + col + '">'
      + (m.known ? Math.round(m.pct) + '%' : '···') + '</span>'
      + '<span class="agl-cap">' + capTxt + '</span>'
      + (CONV.ok ? '<span class="agl-ml">' + nameOf(CONV.model) + '</span>' : '');

    // 卡片
    var segs = [
      [SYS_TOK, C.sys],
      [TOOL_TOK, C.tool],
      [m.convTok, C.conv],
      [BUDGET.total, C.rule],
    ];
    var bar = '';
    var denom = m.limit || 1;
    if (m.known) {
      for (var i = 0; i < segs.length; i++) {
        var w = 100 * segs[i][0] / denom;
        if (w <= 0) continue;
        bar += '<i style="width:' + Math.min(w, 100).toFixed(3) + '%;background:'
          + segs[i][1] + '"></i>';
      }
    }

    function row(label, tok, color) {
      return '<div class="agl-row"><span class="agl-dot" style="background:' + color + '"></span>'
        + '<span class="l">' + label + '</span><span class="v">' + fmtTok(tok) + '</span></div>';
    }

    var rows = row('系统提示词', SYS_TOK, C.sys)
      + row('工具定义', TOOL_TOK, C.tool)
      + row('对话消息', m.convTok, C.conv);
    if (BUDGET.total) rows += row('Rules / Skills', BUDGET.total, C.rule);

    var foot = '';
    if (CONV.ok && CONV.summary) {
      var freeTok = Math.max(0, m.limit - m.total);
      foot = '剩余可用 ' + fmtTok(freeTok) + '　·　'
        + 'input ' + fmtTok(CONV.input) + ' / cache ' + fmtTok(CONV.cache)
        + '<br>会话：' + String(CONV.summary).slice(0, 26)
        + '<br>模型：' + nameOf(CONV.model) + '　步数：' + CONV.steps
        + (CONV.compressed ? '　<span class="agl-warn">⚠ 已压缩</span>' : '');
    } else {
      foot = '<span class="agl-warn">对话数据暂不可用（需 Antigravity 运行中）</span>';
    }

    card.innerHTML =
      '<div class="agl-hd">'
      + '<span class="t">上下文已用<span class="p" style="color:' + col + '">'
      + (m.known ? Math.round(m.pct) + '%' : '—') + '</span></span>'
      + '<span class="c">' + capTxt + '</span></div>'
      + '<div class="agl-bar">' + bar + '</div>'
      + rows
      + '<div class="agl-ft">' + foot + '</div>';
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 60); return; }
    build();
    refresh();
    setInterval(function () {
      if (!document.hidden) refresh();
    }, CFG.POLL_MS);
  }

  window.__AGL_CTX_PANEL__ = { refresh: refresh };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
/* === [END] Antigravity 上下文用量悬浮面板 === */
