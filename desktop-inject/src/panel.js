/* === [START] Antigravity 上下文用量悬浮面板 === */
/*
 * 注入到 dist/preload.js，运行在 Antigravity 主界面（LS 提供的 https://127.0.0.1:<port>/）。
 *
 * 同源优势：页面本身就跑在 LS 端口上，因此可以直接 fetch LS 的 RPC，
 * 不需要 psutil / 日志解析那一套外部探测。
 *
 * UI 规范：对齐 DeepSeek Harness / ZCode 桌面版设计体系（token 见同目录 theme.js）。
 * 核心原则：大面积中性色 + 极少量彩色，靠层次/留白而不是边框和饱和色块来区分信息。
 */
(function () {
  'use strict';

  if (window.__AGL_CTX_PANEL__) return;

  var T = window.AGL_THEME;
  var M_ = T.METRIC;

  var CFG = {
    POLL_MS: 5000,
    RPC_TIMEOUT: 12000,
    API: '/exa.language_server_pb.LanguageServerService/',
  };

  // ---------------------------------------------------------------- 颜色
  // 语义名只在渲染时取，实际值由 CSS 变量解析（支持亮/暗自动切换）
  var C = {
    ok: 'var(--agl-state-ok)',
    warn: 'var(--agl-state-warn)',
    danger: 'var(--agl-state-danger)',
    sys: 'var(--agl-seg-sys)',
    tool: 'var(--agl-seg-out)',
    conv: 'var(--agl-seg-conv)',
    rule: 'var(--agl-seg-rule)',
    accent: 'var(--agl-accent)',
    track: 'var(--agl-bg-track)',
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
    if (n >= 1000000) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }

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
    var direct = readCsrfFromGlobal();
    if (direct) CSRF = direct;

    var HEADERS = ['x-codeium-csrf-token', 'x-csrf-token', 'csrf-token', 'x-xsrf-token'];

    function pick(src) {
      if (!src) return '';
      try {
        if (typeof src.forEach === 'function' && typeof src.get === 'function') {
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
  var LABELS = {};
  var TRACKED_CID = '';

  // —— 算法常量 ——
  // ⚠ 真实数据实测（2026-10-02，Antigravity 2.19.1）：
  //   · modelUsage 挂在 CORTEX_STEP_TYPE_PLANNER_RESPONSE 上（该会话 241 步、119 个 usage、零个 CHECKPOINT）
  //     但别的版本挂在 CHECKPOINT 上 —— 两个都要认
  //   · inputTokens 只是「本轮未命中缓存的增量」（实测 2721）
  //     真正的上下文在 cacheReadTokens（实测 191639）
  //     → 真实上下文 ≈ inputTokens + cacheReadTokens（+ 本轮 outputTokens）
  var SYS_PROMPT_OVERHEAD = 10000;
  var USER_INPUT_FALLBACK = 500;
  var PLANNER_FALLBACK = 800;
  var COMPRESS_MIN_DROP = 5000;
  var MAX_STEPS = 2000;
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

  function computeUsageFromSteps(steps, initialModel) {
    var totalToolOut = 0;
    var estOverhead = 0;
    var toolSinceUsage = 0;
    var model = initialModel || '';
    var last = null;
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
        input: last.input + last.cacheRead,
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
    return rpc('GetUserStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    }).then(function (d) {
      var cfgs = (d && d.userStatus && d.userStatus.cascadeModelConfigData &&
        d.userStatus.cascadeModelConfigData.clientModelConfigs) || [];
      if (!cfgs.length) throw new Error('empty');
      indexModels(cfgs);
    }).catch(function () {
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

  /** 拉一个轨迹的全部步骤：分批 50，并发 5 */
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

      // 会话选择：RUNNING > 上次跟踪的 > 第一个
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
  /*
   * 布局遵循两家的共同做法：
   *   · 视觉层次靠「背景层次 + 留白 + 字重」，不靠粗边框和阴影
   *   · 数字一律 tabular-nums，位数对齐不跳动
   *   · 主要信息（百分比）只出现一次，不在多个位置重复
   *   · 彩色只给进度条 fill 和状态点；文字保持中性灰阶
   */
  var CSS = [
    T.css(),

    '#agl-ctx{position:fixed;right:16px;bottom:16px;z-index:2147483000;',
    'font-family:' + M_.fontUi + ';',
    '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;',
    '-webkit-user-select:none;user-select:none;',
    'font-size:' + M_.fsBase + ';line-height:' + M_.lhNormal + ';',
    'color:var(--agl-text-primary)}',
    '#agl-ctx *{box-sizing:border-box}',
    '#agl-ctx button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',

    /* ---------------- 胶囊：只放三类信息，克制 ---------------- */
    // 高度 34→26，圆环 15→12，模型名默认隐藏（悬停才出）—— 常驻占屏幕的空间先砍一半
    '.agl-pill{display:flex;align-items:center;gap:7px;height:26px;padding:0 10px 0 8px;',
    'border-radius:' + M_.rPill + ';cursor:pointer;',
    'background:var(--agl-bg-pill);',
    'backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);',
    'box-shadow:var(--agl-shadow-pill);',
    'transition:transform ' + M_.durFast + ' ' + M_.ease + ',box-shadow ' + M_.durFast + ' ' + M_.ease + '}',
    '.agl-pill:hover{transform:translateY(-1px)}',
    '.agl-pill:active{transform:translateY(0) scale(.985)}',

    /* 圆环：细一点更像仪表，粗环显笨重 */
    '.agl-ring{width:12px;height:12px;flex:0 0 auto;display:block}',
    '.agl-pct{font-size:12px;font-weight:' + M_.fwSemibold + ';',
    'font-variant-numeric:tabular-nums;letter-spacing:-.01em;line-height:1}',
    '.agl-pct .u{font-size:9px;font-weight:' + M_.fwMedium + ';opacity:.55;margin-left:.5px}',
    '.agl-cap{font-size:11px;color:var(--agl-text-tertiary);',
    'font-variant-numeric:tabular-nums;line-height:1}',
    '.agl-sep{width:1px;height:11px;background:var(--agl-border-line);flex:0 0 auto}',
    // 模型名：默认不占位，悬停整条胶囊时才展开（省掉常驻 104px）
    '.agl-ml{font-size:11px;color:var(--agl-text-tertiary);',
    'max-width:0;opacity:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1;',
    'transition:max-width ' + M_.durFast + ' ' + M_.ease + ',opacity ' + M_.durFast + ' ' + M_.ease + '}',
    '.agl-pill:hover .agl-ml{max-width:104px;opacity:1}',

    /* ---------------- 卡片：320→244 宽，16px 内边距 → 11px ---------------- */
    '.agl-card{position:absolute;right:0;bottom:calc(100% + 8px);width:244px;',
    'border-radius:' + M_.rCard + ';padding:11px 12px 10px;',
    'background:var(--agl-bg-card);',
    'backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);',
    'box-shadow:var(--agl-shadow-card);',
    'opacity:0;transform:translateY(6px) scale(.985);transform-origin:100% 100%;',
    'pointer-events:none;',
    'transition:opacity ' + M_.durFast + ' ' + M_.ease + ',transform ' + M_.durFast + ' ' + M_.ease + '}',
    '.agl-card.open{opacity:1;transform:none;pointer-events:auto}',

    /* 标题行：左「上下文占用」右大数字，一行搞定 */
    '.agl-hdline{display:flex;align-items:baseline;justify-content:space-between;',
    'gap:8px;margin-bottom:1px}',
    '.agl-hdline .lab{font-size:11px;color:var(--agl-text-secondary);',
    'font-weight:' + M_.fwMedium + ';letter-spacing:.01em}',
    '.agl-hdline .val{display:flex;align-items:baseline;gap:1px;',
    'font-variant-numeric:tabular-nums}',
    '.agl-hdline .val b{font-size:18px;font-weight:' + M_.fwSemibold + ';',
    'line-height:1;letter-spacing:-.02em}',
    '.agl-hdline .val i{font-size:10px;font-style:normal;opacity:.45;font-weight:' + M_.fwMedium + '}',

    /* 容量说明：紧跟标题行，小字弱化 */
    '.agl-sub{font-size:10px;color:var(--agl-text-tertiary);',
    'font-variant-numeric:tabular-nums;font-family:' + M_.fontNum + ';',
    'line-height:' + M_.lhTight + ';margin-bottom:7px}',

    /* 进度条：8→5px，块间距更紧 */
    '.agl-bar{display:flex;height:5px;border-radius:' + M_.rTrack + ';overflow:hidden;',
    'background:var(--agl-bg-track);margin-bottom:9px}',
    '.agl-bar i{display:block;height:100%;transition:width .35s ' + M_.ease + '}',
    // 段与段之间留 1.5px 缝隙（用背景色描边切开），避免同色段糊成一片
    '.agl-bar i:not(:last-child){box-shadow:1.5px 0 0 0 var(--agl-bg-card)}',

    /* 明细行：行距 3.5→2px，dot 6→5px */
    '.agl-row{display:flex;align-items:center;gap:6px;padding:2px 0;',
    'font-size:11px;line-height:' + M_.lhTight + '}',
    '.agl-dot{width:5px;height:5px;border-radius:2.5px;flex:0 0 auto}',
    '.agl-row .l{flex:1;color:var(--agl-text-secondary);',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.agl-row .v{color:var(--agl-text-primary);font-weight:' + M_.fwMedium + ';',
    'font-variant-numeric:tabular-nums;font-family:' + M_.fontNum + ';font-size:10.5px}',

    /* 底注：细分隔线 + 极小字，只承载元信息 */
    '.agl-ft{margin-top:8px;padding-top:7px;border-top:1px solid var(--agl-border-hair);',
    'font-size:10px;color:var(--agl-text-tertiary);line-height:1.5;',
    'display:flex;flex-direction:column;gap:0}',
    '.agl-ft .r{display:flex;align-items:center;gap:6px}',
    // key 定宽右对齐，value 左对齐 —— 标签垂直对齐，读起来是表格而不是流水句
    '.agl-ft .k{color:var(--agl-text-faint);flex:0 0 auto;width:24px;text-align:right}',
    '.agl-ft .t{color:var(--agl-text-secondary);overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.agl-ft .t.num{font-variant-numeric:tabular-nums;font-family:' + M_.fontNum + '}',

    /* 状态徽标：极小的胶囊，比纯彩色文字更清晰 */
    '.agl-tag{display:inline-flex;align-items:center;height:14px;padding:0 4px;',
    'border-radius:3px;background:var(--agl-bg-inset);',
    'font-size:9.5px;font-weight:' + M_.fwMedium + ';color:var(--agl-text-secondary);',
    'letter-spacing:.02em;line-height:1}',
    '.agl-tag.warn{color:var(--agl-state-warn)}',

    /* 加载骨架 */
    '.agl-sk{background:var(--agl-bg-inset);border-radius:4px;',
    'animation:agl-sk 1.4s ' + M_.ease + ' infinite}',
    '@keyframes agl-sk{0%,100%{opacity:1}50%{opacity:.45}}',
    '@media (prefers-reduced-motion:reduce){',
    '.agl-card,.agl-pill,.agl-bar i{transition:none}',
    '.agl-sk{animation:none}}',
  ].join('');

  function ringSvg(pct) {
    var col = stateColor(pct);
    var r = 5.8, cir = 2 * Math.PI * r, sw = 2.2;
    var off = cir * (1 - Math.min(pct, 100) / 100);
    return '<svg class="agl-ring" viewBox="0 0 15 15" aria-hidden="true">'
      + '<circle cx="7.5" cy="7.5" r="' + r + '" fill="none" stroke="var(--agl-bg-track)" stroke-width="' + sw + '"/>'
      + '<circle cx="7.5" cy="7.5" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '"'
      + ' stroke-linecap="round" stroke-dasharray="' + cir.toFixed(2) + '"'
      + ' stroke-dashoffset="' + off.toFixed(2) + '"'
      + ' transform="rotate(-90 7.5 7.5)"/></svg>';
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
      + '<div class="agl-pill" id="agl-pill" role="button" tabindex="0" aria-label="上下文用量"></div>';
    document.body.appendChild(root);

    pill = root.querySelector('#agl-pill');
    card = root.querySelector('#agl-card');

    // 跟随宿主主题（Antigravity 有暗色标记时同步）
    syncTheme();
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', syncTheme);
      } catch (e) { /* ignore */ }
    }
    setInterval(syncTheme, 4000);

    function toggle() {
      open = !open;
      card.classList.toggle('open', open);
      if (open) refresh();
    }
    pill.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    pill.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    card.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      if (open) { open = false; card.classList.remove('open'); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) { open = false; card.classList.remove('open'); }
    });
  }

  /** 宿主是暗色就加标记，让 token 层切到暗色 */
  function syncTheme() {
    if (!root) return;
    var dark = false;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches) dark = true;
      var de = document.documentElement;
      if (de) {
        if (de.hasAttribute('data-ds-dark-theme') || de.classList.contains('dark')) dark = true;
        var bg = getComputedStyle(document.body || de).backgroundColor || '';
        var m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
          if (de.classList.contains('vscode-dark')) dark = true;
          else if (bg && bg !== 'rgba(0, 0, 0, 0)' && !de.hasAttribute('data-ds-dark-theme')) dark = lum < 0.45;
        }
      }
    } catch (e) { /* ignore */ }
    if (dark) root.setAttribute('data-agl-dark', '');
    else root.removeAttribute('data-agl-dark');
  }

  function render() {
    if (!root) return;
    var m = metrics();
    var col = m.known ? stateColor(m.pct) : 'var(--agl-text-faint)';
    var pctTxt = m.known ? String(Math.round(m.pct)) : '·';
    var capTxt = fmtTok(m.total) + ' / ' + fmtTok(m.limit);

    // ---------------- 胶囊 ----------------
    pill.innerHTML = ringSvg(m.known ? m.pct : 0)
      + '<span class="agl-pct" style="color:' + col + '">' + pctTxt + '<span class="u">%</span></span>'
      + '<span class="agl-sep"></span>'
      + '<span class="agl-cap">' + capTxt + '</span>'
      + (CONV.ok ? '<span class="agl-ml">' + esc(nameOf(CONV.model)) + '</span>' : '');

    // ---------------- 卡片 ----------------
    var segs = [
      [CONV.cacheRead, C.conv],
      [Math.max(0, CONV.input - CONV.cacheRead), C.sys],
      [CONV.output, C.tool],
      [CONV.est, C.tool],
      [BUDGET.total, C.rule],
    ];
    var bar = '';
    var denom = m.limit || 1;
    if (m.known) {
      for (var i = 0; i < segs.length; i++) {
        var w = 100 * segs[i][0] / denom;
        if (w <= 0.05) continue;
        bar += '<i style="width:' + Math.min(w, 100).toFixed(3) + '%;background:' + segs[i][1] + '"></i>';
      }
    }

    function row(label, tok, color) {
      return '<div class="agl-row"><span class="agl-dot" style="background:' + color + '"></span>'
        + '<span class="l">' + esc(label) + '</span>'
        + '<span class="v">' + fmtTok(tok) + '</span></div>';
    }

    var rows = '';
    if (!CONV.ok) {
      rows = '<div class="agl-row"><span class="l" style="color:var(--agl-text-faint)">'
        + (CONV.err === 'no session' ? '还没有对话' : '数据获取中…') + '</span></div>';
    } else if (CONV.hasCkpt) {
      rows = row('历史上下文（缓存命中）', CONV.cacheRead, C.conv)
        + row('本轮新增输入', Math.max(0, CONV.input - CONV.cacheRead), C.sys)
        + row('本轮输出', CONV.output, C.tool);
      if (CONV.est > 0) rows += row('后续增量（估算）', CONV.est, C.tool);
    } else {
      rows = row('系统提示词', SYS_PROMPT_OVERHEAD, C.sys)
        + row('工具与响应（估算）', Math.max(0, CONV.est - SYS_PROMPT_OVERHEAD), C.tool);
    }
    if (BUDGET.total) rows += row('Rules / Skills', BUDGET.total, C.rule);

    // 底注：来源标记 + 剩余 + 会话/模型 + 步数，全部压进两行
    var foot;
    if (CONV.ok && CONV.summary) {
      var freeTok = Math.max(0, m.limit - m.total);
      var srcTag = CONV.src === 'api' ? '精确' : (CONV.src === 'mixed' ? '精确+估算' : '估算');
      foot = '<div class="r">'
        + '<span class="tag">' + srcTag + '</span>'
        + (CONV.compressed ? '<span class="tag warn">已压缩</span>' : '')
        + '<span class="t num" style="margin-left:auto">剩余 ' + fmtTok(freeTok) + '</span>'
        + '</div>'
        + '<div class="r"><span class="t">' + esc(String(CONV.summary)) + '</span></div>'
        + '<div class="r"><span class="t">' + esc(nameOf(CONV.model))
        + '</span><span class="t num" style="margin-left:auto">' + CONV.steps + ' 步</span></div>';
    } else {
      foot = '<div class="r"><span class="t">'
        + (CONV.err === 'no session' ? '开启对话后自动统计' : '等待 Antigravity 响应…')
        + '</span></div>';
    }

    card.innerHTML =
      '<div class="agl-hdline">'
      + '<span class="lab">上下文占用</span>'
      + '<span class="val"><b style="color:' + col + '">' + (m.known ? Math.round(m.pct) : '—') + '</b>'
      + '<i>' + (m.known ? '%' : '') + '</i></span>'
      + '</div>'
      + '<div class="agl-sub">' + capTxt + ' tokens</div>'
      + '<div class="agl-bar">' + bar + '</div>'
      + rows
      + '<div class="agl-ft">' + foot + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 60); return; }
    sniffCsrf();
    build();
    render();               // 先出骨架，避免打开瞬间空白
    waitCsrfAndRefresh();
    setInterval(function () {
      if (!document.hidden) refresh();
    }, CFG.POLL_MS);
  }

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
