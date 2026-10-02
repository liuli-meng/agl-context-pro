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

  // 模型名 → 窗口上限（对齐开源实现的内置映射表）
  function limitOf(model) {
    var n = String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (n.includes('m37') || n.includes('m36') || n.includes('m18') ||
        n.includes('m318') || n.includes('m319') || n.includes('m320') ||
        n.includes('m298') || n.includes('m299') || n.includes('m300') ||
        n.includes('m71') || n.includes('m72') || n.includes('m73') ||
        n.includes('m16') || n.includes('gemini')) return M.GEMINI;
    if (n.includes('m35') || n.includes('m26') || n.includes('claude')) return M.CLAUDE;
    if (n.includes('gpt-oss') || n.includes('gpt-oss-120')) return M.GPT_OSS;
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
  // ---------------------------------------------------------------- CSRF
  /*
   * ⚠ 关键：LS 要求每个请求带 CSRF token，否则 401 {"code":"unauthenticated"}。
   *
   * 首选来源：页面在启动时会把 token 挂到全局 ——
   *     window.__APP_CONFIG__ = { productName, csrfToken, appVersion, ... }
   * 直接读就行，不需要嗅探。
   *
   * 兜底：万一某版本没挂全局，就 hook fetch / XHR 从真实请求头里嗅探。
   * token 在应用生命周期内不变（每次启动应用才重新生成）。
   */
  var CSRF = '';

  /** 从全局 __APP_CONFIG__ 直接取（最稳） */
  function readCsrfFromGlobal() {
    try {
      var cfg = window.__APP_CONFIG__;
      if (cfg) {
        if (typeof cfg === 'string') {          // 万一是 JSON 串
          try { cfg = JSON.parse(cfg); } catch (e) { return ''; }
        }
        var t = cfg.csrfToken || cfg.csrf_token || cfg.CSRF_TOKEN;
        if (t) return String(t);
      }
    } catch (e) { /* ignore */ }
    // 再顺手扫一遍常见挂点
    var spots = ['__NEXT_DATA__', '__INITIAL_STATE__', '__APP__', '__CONFIG__'];
    for (var i = 0; i < spots.length; i++) {
      try {
        var o = window[spots[i]];
        if (!o) continue;
        if (o.csrfToken) return String(o.csrfToken);
        var j = JSON.stringify(o);
        var m = j && j.match(/"csrf_token"\s*:\s*"([^"]+)"/i);
        if (m) return m[1];
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function sniffCsrf() {
    // 1) 先直接读全局
    var direct = readCsrfFromGlobal();
    if (direct) CSRF = direct;

    var HEADERS = ['x-codeium-csrf-token', 'x-csrf-token', 'csrf-token', 'x-xsrf-token'];

    function pick(src) {
      if (!src) return '';
      try {
        if (typeof src.forEach === 'function' && typeof src.get === 'function') {
          // Headers 实例
          for (var i = 0; i < HEADERS.length; i++) {
            var v = src.get(HEADERS[i]);
            if (v) return v;
          }
          return '';
        }
        for (var k in src) {
          if (/csrf/i.test(k) && typeof src[k] === 'string') return src[k];
        }
      } catch (e) { /* ignore */ }
      return '';
    }

    // 1) hook fetch
    var _fetch = window.fetch;
    if (_fetch && !_fetch.__aglHooked) {
      var wrapped = function (input, init) {
        try {
          var hit = pick(init && init.headers) || pick(input && input.headers);
          if (hit) CSRF = hit;
        } catch (e) { /* ignore */ }
        return _fetch.apply(this, arguments);
      };
      wrapped.__aglHooked = true;
      window.fetch = wrapped;
    }

    // 2) hook XHR（页面有些调用走 XHR）
    try {
      var _open = XMLHttpRequest.prototype.open;
      var _setH = XMLHttpRequest.prototype.setRequestHeader;
      if (!_setH.__aglHooked) {
        var newSet = function (k, v) {
          try { if (/csrf/i.test(k) && typeof v === 'string') CSRF = v; } catch (e) { /* ignore */ }
          return _setH.apply(this, arguments);
        };
        newSet.__aglHooked = true;
        XMLHttpRequest.prototype.setRequestHeader = newSet;
      }
    } catch (e) { /* ignore */ }
  }

  /** 拿不到 token 时，从内存里的已知位置兜底捞一遍 */
  function rpc(method, body) {
    return new Promise(function (resolve, reject) {
      if (!CSRF) CSRF = readCsrfFromGlobal();   // 每轮兜一次，防首页加载时未就绪
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, CFG.RPC_TIMEOUT);
      var headers = { 'Content-Type': 'application/json' };
      if (CSRF) {
        headers['X-Codeium-Csrf-Token'] = CSRF;
        headers['Connect-Protocol-Version'] = '1';
      }
      fetch(CFG.API + method, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body || {}),
        credentials: 'same-origin',
        signal: ctrl.signal,
      }).then(function (r) {
        clearTimeout(to);
        if (!r.ok) {
          if (r.status === 401) CSRF = '';   // token 失效 → 下一轮重新嗅探
          reject(new Error(method + ' HTTP ' + r.status));
          return;
        }
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
  var CONV = {
    ok: false, used: 0, limit: 0, input: 0, cacheRead: 0, output: 0, est: 0,
    model: '', summary: '', steps: 0, compressed: false, src: 'estimate',
  };
  var LABELS = {};   // model -> 官方 label（动态拉取）
  var TRACKED_CID = '';  // 当前跟踪的会话 id（跨轮询保持，防抖）

  // —— 算法常量 ——
  // ⚠ 真实数据实测（2026-10-02，Antigravity 2.19.1）：
  //   · modelUsage 挂在 CORTEX_STEP_TYPE_PLANNER_RESPONSE 上（该会话 241 步、119 个 usage、零个 CHECKPOINT）
  //     但别的版本挂在 CHECKPOINT 上 —— 两个都要认
  //   · inputTokens 只是「本轮未命中缓存的增量」（实测 2721）
  //     真正的上下文在 cacheReadTokens（实测 191639）
  //     → 真实上下文 ≈ inputTokens + cacheReadTokens（+ 本轮 outputTokens）
  var SYS_PROMPT_OVERHEAD = 10000;   // 完全无 usage 时的系统提示词兜底
  var USER_INPUT_FALLBACK = 500;
  var PLANNER_FALLBACK = 800;
  var COMPRESS_MIN_DROP = 5000;      // 相邻 usage 上下文骤降阈值（压缩检测）
  var MAX_STEPS = 2000;              // 拉取上限，防爆
  var BATCH = 50, CONCURRENCY = 5;

  /**
   * 字符估算 token（无 usage 时的兜底）：
   *   ascii 字符 / 4  +  非 ascii 字符 / 1.5
   */
  function estimateTokensFromText(text) {
    if (!text) return 0;
    var ascii = 0, nonAscii = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) ascii++; else nonAscii++;
    }
    return Math.ceil(ascii / 4 + nonAscii / 1.5);
  }

  /** 一个 step 上拿到的「上下文总量」= input + cacheRead（+ 本轮 output） */
  function usageOf(mu) {
    if (!mu) return null;
    var it = parseFloat(mu.inputTokens) || 0;
    var cr = parseFloat(mu.cacheReadTokens) || 0;
    var ot = parseFloat(mu.outputTokens) || 0;
    if (it <= 0 && cr <= 0 && ot <= 0) return null;
    return { input: it, cacheRead: cr, output: ot, ctx: it + cr + ot, model: mu.model || '' };
  }

  /**
   * 从 steps 里算真实上下文用量（实测口径）：
   *
   *   1) 取**最后一个带 modelUsage 的步**，上下文 = inputTokens + cacheReadTokens + outputTokens
   *      （不逐轮累加 —— inputTokens 已经是累计前缀，累加会爆炸）
   *   2) 该步之后的 toolCall 输出 + 字符估算，作为增量补上
   *   3) 一个 usage 都没有才退回「系统提示词 + 工具输出估算」
   */
  function computeUsageFromSteps(steps, initialModel) {
    var totalToolOut = 0;          // 全程工具输出（兜底用）
    var estOverhead = 0;           // 最近一个 usage 之后的字符估算增量
    var toolSinceUsage = 0;        // 最近一个 usage 之后的工具输出
    var model = initialModel || '';
    var last = null;               // 最后一个有效 usage
    var prevCtx = -1;
    var compressed = false;

    for (var i = 0; i < steps.length; i++) {
      var step = steps[i] || {};
      var ty = step.type || '';
      var md = step.metadata || {};

      if (ty === 'CORTEX_STEP_TYPE_USER_INPUT') {
        var ui = step.userInput;
        estOverhead += (ui && typeof ui === 'object')
          ? estimateTokensFromText(String(ui.userResponse || '')) : USER_INPUT_FALLBACK;
      }

      if (ty === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        var pr = step.plannerResponse;
        if (pr && typeof pr === 'object') {
          var rt = String(pr.response || '');
          var th = String(pr.thinking || '');
          var tcTxt = '';
          if (Array.isArray(pr.toolCalls)) {
            pr.toolCalls.forEach(function (tc) {
              tcTxt += String((tc && tc.argumentsJson) || '');
            });
          }
          estOverhead += estimateTokensFromText(rt + th + tcTxt);
        } else {
          estOverhead += PLANNER_FALLBACK;
        }
      }

      var tco = parseFloat(md.toolCallOutputTokens) || 0;
      totalToolOut += tco;
      toolSinceUsage += tco;

      if (md.generatorModel) model = md.generatorModel;
      if (md.requestedModel && md.requestedModel.model) model = md.requestedModel.model;

      // ⚠ 两个类型都认：新版在 PLANNER_RESPONSE，别的在 CHECKPOINT
      var u = usageOf(md.modelUsage);
      if (u) {
        if (u.model) model = u.model;
        // 压缩检测：上下文相对上一个 usage 骤降
        if (prevCtx > 0 && u.ctx < prevCtx && (prevCtx - u.ctx) > COMPRESS_MIN_DROP) {
          compressed = true;
        }
        prevCtx = u.ctx;
        last = u;
        estOverhead = 0;
        toolSinceUsage = 0;
      }
    }

    if (last) {
      var delta = toolSinceUsage + estOverhead;
      return {
        used: last.ctx + delta,
        input: last.input + last.cacheRead,   // 真实上下文主体（含缓存命中）
        cacheRead: last.cacheRead,
        output: last.output, est: delta,
        model: model, hasCkpt: true, compressed: compressed,
        src: delta > 0 ? 'mixed' : 'api',
      };
    }

    var total = SYS_PROMPT_OVERHEAD + totalToolOut + estOverhead;
    return {
      used: total, input: 0, cacheRead: 0, output: 0, est: total,
      model: model, hasCkpt: false, compressed: false, src: 'estimate',
    };
  }

  /** 官方模型表：把 MODEL_PLACEHOLDER_XXX → "Gemini 3.8 Flash (High)" */
  function loadModels() {
    // 优先 GetUserStatus（开源实现用的这个，一并带回模型表 + 额度）
    return rpc('GetUserStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    }).then(function (d) {
      var cfgs = (d && d.userStatus && d.userStatus.cascadeModelConfigData &&
        d.userStatus.cascadeModelConfigData.clientModelConfigs) || [];
      if (!cfgs.length) throw new Error('empty');
      indexModels(cfgs);
    }).catch(function () {
      // 退回 GetCascadeModelConfigData
      return rpc('GetCascadeModelConfigData', {}).then(function (d) {
        indexModels((d && d.clientModelConfigs) || []);
      }).catch(function () { /* 保留兜底表 */ });
    });
  }

  function indexModels(cfgs) {
    cfgs.forEach(function (c) {
      var m = (c.modelOrAlias || {}).model;
      var alias = (c.modelOrAlias || {}).alias;
      if (c.label) {
        if (m) LABELS[m] = c.label;
        if (alias) LABELS[alias] = c.label;
      }
    });
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

  /** 拉一个轨迹的全部步骤：分批 50，并发 5（开源同款策略） */
  function fetchAllSteps(cid, stepCount) {
    var total = Math.min(Math.max(stepCount, 0), MAX_STEPS);
    if (!total) return Promise.resolve([]);
    var ranges = [];
    for (var s = 0; s < total; s += BATCH) {
      ranges.push({ start: s, end: Math.min(s + BATCH, total) });
    }
    var all = [];
    function runGroup(idx) {
      if (idx >= ranges.length) return Promise.resolve();
      var group = ranges.slice(idx, idx + CONCURRENCY);
      return Promise.all(group.map(function (rg) {
        return rpc('GetCascadeTrajectorySteps', {
          cascadeId: cid, startIndex: rg.start, endIndex: rg.end,
        }).then(function (sr) {
          return (sr && sr.steps) || [];
        }).catch(function () { return []; });
      })).then(function (chunks) {
        chunks.forEach(function (c) {
          for (var i = 0; i < c.length; i++) {
            if (c[i] && typeof c[i] === 'object') all.push(c[i]);
          }
        });
        return runGroup(idx + CONCURRENCY);
      });
    }
    return runGroup(0).then(function () { return all; });
  }

  function loadConversation() {
    return rpc('GetAllCascadeTrajectories', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    }).then(function (d) {
      var sums = (d && d.trajectorySummaries) || {};
      var list = Object.keys(sums).map(function (cid) {
        var v = sums[cid] || {};
        var mm = ((v.latestNotifyUserStep || v.latestTaskBoundaryStep || {}).step || {}).metadata || {};
        return {
          cid: cid,
          summary: v.summary || cid,
          stepCount: Number(v.stepCount) || 0,
          status: v.status || '',
          lastModifiedTime: String(v.lastModifiedTime || ''),
          requestedModel: (mm.requestedModel || {}).model || '',
          generatorModel: mm.generatorModel || '',
        };
      });
      if (!list.length) throw new Error('no session');

      list.sort(function (a, b) {
        return b.lastModifiedTime.localeCompare(a.lastModifiedTime);
      });

      // 会话选择（对齐开源策略）：RUNNING > 上次跟踪的 > 第一个
      var pick = null;
      var running = list.filter(function (t) {
        return t.status === 'CASCADE_RUN_STATUS_RUNNING';
      });
      if (running.length) {
        pick = running.filter(function (t) { return t.cid === TRACKED_CID; })[0] || running[0];
      } else if (TRACKED_CID) {
        pick = list.filter(function (t) { return t.cid === TRACKED_CID; })[0];
      }
      if (!pick) pick = list[0];
      TRACKED_CID = pick.cid;

      var initialModel = pick.requestedModel || pick.generatorModel || '';

      return fetchAllSteps(pick.cid, pick.stepCount).then(function (steps) {
        var r = computeUsageFromSteps(steps, initialModel);
        CONV.ok = true;
        CONV.used = r.used;
        CONV.input = r.input;
        CONV.cacheRead = r.cacheRead || 0;
        CONV.output = r.output;
        CONV.est = r.est;
        CONV.model = r.model;
        CONV.hasCkpt = r.hasCkpt;
        CONV.src = r.src;
        CONV.compressed = r.compressed;
        CONV.limit = limitOf(r.model);
        CONV.summary = pick.summary;
        CONV.steps = pick.stepCount;
        CONV.rawSteps = steps.length;
        CONV.pickStatus = pick.status;
      });
    }).catch(function (e) {
      CONV.ok = false;
      CONV.err = (e && e.message) || 'unknown';
    });
  }

  function refresh() {
    return Promise.all([loadModels(), loadBudget(), loadConversation()]).then(function () {
      render();
    });
  }

  // ---------------------------------------------------------------- 计算
  // ⚠ 不再自己拼 SYS_TOK/TOOL_TOK —— computeUsageFromSteps 已经含系统开销。
  function metrics() {
    var used = CONV.ok ? CONV.used : 0;
    var limit = (CONV.ok && CONV.limit) ? CONV.limit : M.GEMINI;
    var pct = limit ? (100 * used / limit) : 0;
    return {
      used: used, limit: limit, total: used,
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
      [Math.max(0, CONV.input - CONV.cacheRead), C.sys],   // 未命中缓存（真实新增）
      [CONV.cacheRead, C.conv],                            // 缓存命中（历史上下文主体）
      [CONV.output, C.tool],
      [CONV.est, '#a78bfa'],                               // usage 之后的增量估算
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

    var rows = '';
    if (CONV.ok && CONV.hasCkpt) {
      rows = row('历史上下文（缓存命中）', CONV.cacheRead, C.conv)
        + row('本轮新增输入', Math.max(0, CONV.input - CONV.cacheRead), C.sys)
        + row('本轮输出', CONV.output, C.tool);
      if (CONV.est > 0) rows += row('后续增量（估算）', CONV.est, '#a78bfa');
    } else if (CONV.ok) {
      rows = row('系统提示词', SYS_PROMPT_OVERHEAD, C.sys)
        + row('工具与响应（估算）', Math.max(0, CONV.est - SYS_PROMPT_OVERHEAD), C.tool);
    }
    if (BUDGET.total) rows += row('Rules / Skills', BUDGET.total, C.rule);

    var foot = '';
    if (CONV.ok && CONV.summary) {
      var freeTok = Math.max(0, m.limit - m.total);
      var srcTag = CONV.src === 'api' ? '精确' : (CONV.src === 'mixed' ? '精确+估算' : '估算');
      foot = '剩余可用 ' + fmtTok(freeTok) + '　·　' + srcTag
        + '<br>会话：' + String(CONV.summary).slice(0, 26)
        + '<br>模型：' + nameOf(CONV.model) + '　步数：' + CONV.steps
        + (CONV.compressed ? '　<span class="agl-warn">⚠ 已压缩</span>' : '');
    } else {
      var why = CONV.err === 'no session' ? '还没有对话' : '数据获取中…';
      foot = '<span class="agl-warn">' + why + '</span>';
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
    // 先 hook，越早越好 —— 页面自己的 RPC 一旦发出就能嗅到 token
    sniffCsrf();
    build();
    waitCsrfAndRefresh();
    setInterval(function () {
      if (!document.hidden) refresh();
    }, CFG.POLL_MS);
  }

  // token 一般启动即可用；万一还没就绪，短暂重试几轮（最多 ~4s）
  function waitCsrfAndRefresh(tries) {
    tries = tries || 0;
    if (!CSRF) CSRF = readCsrfFromGlobal();
    if (CSRF || tries > 10) { refresh(); return; }
    setTimeout(function () { waitCsrfAndRefresh(tries + 1); }, 400);
  }

  window.__AGL_CTX_PANEL__ = { refresh: refresh };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
/* === [END] Antigravity 上下文用量悬浮面板 === */
