/* === [START] Antigravity 上下文用量悬浮面板 === */
/* ---------------------------------------------------------------------------
 * 设计 token 层（theme.js）—— 与 panel.js 同属一个注入块，共用一个标记对。
 *
 * ⚠ 标记必须和 inject.js 的 MARK_START/MARK_END 逐字一致，否则 stripBlock
 *   清不掉旧块，重复 install 会层层叠加。这两个文件靠拼接注入，标记只留一份。
 * ------------------------------------------------------------------------- */
/*
 * 视觉规范对齐 DeepSeek Harness / ZCode(opencode) 的桌面端设计体系。
 *
 * 两家的共同做法（都是从 asar 里扒出来的真实实现）：
 *
 *  1. 三层 token 结构 —— 原始色阶 → 语义别名 → 组件局部变量
 *     · DSH:  --dsw-static-neutral-bluish-*  →  --dsw-alias-label-primary  →  组件里直接用 alias
 *     · ZCode:--v2-grey-* / --v2-alpha-*     →  --v2-text-text-base        →  [data-component] 里用
 *     好处：换主题只改中间层，组件 CSS 一行不动。
 *
 *  2. 中性色带蓝味，不用纯灰 —— DSH 的 neutral-bluish 全系偏冷（#0f1115 / #61666b / #ebedf2），
 *     ZCode 同样是 #161616 / #5c5c5c / #fafafa。纯灰 (#888/#ccc) 会显得脏、廉价。
 *
 *  3. 大面积中性 + 极少量彩色 —— 卡片主体全是灰阶，
 *     只有进度条 fill 和状态点用彩色。绝不出现四五个饱和色块并排。
 *
 *  4. 边框极淡、阴影极浅 —— DSH: border-l2 = #0000001a (10%)，ZCode: --v2-alpha-dark-10。
 *     靠层次和留白区分，不靠粗边框。
 *
 *  5. 字号阶梯 13/14/16/20，行高 130%/150%，字重 400/500 —— 两家完全一致。
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 1. 原始色阶 */
  /* 中性色：带蓝味（对齐 DSH neutral-bluish / ZCode grey） */
  var PALETTE = {
    // 亮色端
    n00: '#ffffff',
    n25: '#fcfcfd',
    n50: '#fafbfc',
    n75: '#f4f6f8',
    n100: '#eef1f4',
    n150: '#e6eaf0',
    n200: '#dde2ea',
    n300: '#c9d0d9',
    n400: '#a8b0bb',
    n500: '#8b939e',
    n600: '#6b737e',
    n700: '#4d545d',
    n750: '#3d434b',
    n800: '#2c3138',
    n850: '#23272d',
    n900: '#191c21',
    n950: '#131519',
    n1000: '#0d0f12',
    // 品牌蓝（DSH deepseek-500 / ZCode blue-600）
    blue: '#4d6bfe',
    blueSoft: '#7698fd',
    // 状态色（只取中段，避免刺眼）
    amber: '#e7882c',
    red: '#e5484d',
    green: '#2fa85c',
    violet: '#8b7cf6',
  };

  /* ---------------------------------------------------------------- 2. 语义别名 */
  /* 亮色 */
  var LIGHT = {
    'bg-card': 'rgba(255,255,255,.92)',
    'bg-pill': 'rgba(255,255,255,.86)',
    'bg-inset': PALETTE.n75,
    'bg-track': 'rgba(15,17,21,.09)',
    'bg-hover': 'rgba(15,17,21,.04)',

    'text-primary': PALETTE.n900,
    'text-secondary': PALETTE.n600,
    'text-tertiary': PALETTE.n500,
    'text-faint': PALETTE.n400,

    'border-hair': 'rgba(15,17,21,.07)',
    'border-line': 'rgba(15,17,21,.11)',

    'accent': PALETTE.blue,
    'state-ok': PALETTE.blue,
    'state-warn': PALETTE.amber,
    'state-danger': PALETTE.red,

    'seg-conv': PALETTE.blue,
    'seg-sys': PALETTE.n400,
    'seg-out': PALETTE.violet,
    'seg-rule': PALETTE.green,

    'shadow-card': '0 0 0 .5px rgba(15,17,21,.06), 0 1px 2px rgba(15,17,21,.04), 0 12px 32px rgba(15,17,21,.10)',
    'shadow-pill': '0 0 0 .5px rgba(15,17,21,.06), 0 1px 2px rgba(15,17,21,.05), 0 4px 14px rgba(15,17,21,.08)',
  };

  /* 暗色 */
  var DARK = {
    'bg-card': 'rgba(28,30,34,.94)',
    'bg-pill': 'rgba(30,32,36,.86)',
    'bg-inset': 'rgba(255,255,255,.05)',
    'bg-track': 'rgba(255,255,255,.11)',
    'bg-hover': 'rgba(255,255,255,.06)',

    'text-primary': '#eceded',
    'text-secondary': '#9ba1aa',
    'text-tertiary': '#7b818a',
    'text-faint': '#5f656d',

    'border-hair': 'rgba(255,255,255,.06)',
    'border-line': 'rgba(255,255,255,.10)',

    'accent': PALETTE.blueSoft,
    'state-ok': PALETTE.blueSoft,
    'state-warn': '#e0a33f',
    'state-danger': '#e5615f',

    'seg-conv': PALETTE.blueSoft,
    'seg-sys': '#7b818a',
    'seg-out': '#a99bfa',
    'seg-rule': '#4cbd76',

    'shadow-card': '0 0 0 .5px rgba(0,0,0,.30), 0 2px 6px rgba(0,0,0,.24), 0 16px 40px rgba(0,0,0,.40)',
    'shadow-pill': '0 0 0 .5px rgba(0,0,0,.26), 0 2px 6px rgba(0,0,0,.22), 0 6px 18px rgba(0,0,0,.26)',
  };

  /* ---------------------------------------------------------------- 3. 度量 */
  /* 字号阶梯与行高严格对齐两家：13/14/16/20，130%/150% */
  var METRIC = {
    fontUi: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", ' +
      '"Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif',
    fontNum: 'ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Consolas, monospace',

    fsSmall: '12px',
    fsBase: '13px',
    fsLarge: '14px',
    fsTitle: '15px',
    fsHero: '22px',

    fwRegular: '400',
    fwMedium: '500',
    fwSemibold: '600',

    lhTight: '1.3',
    lhNormal: '1.5',

    rPill: '999px',
    rCard: '12px',
    rTrack: '999px',
    rDot: '3px',
    rBtn: '8px',

    durFast: '140ms',
    ease: 'cubic-bezier(.4,0,.2,1)',
  };

  /* ---------------------------------------------------------------- 4. 序列化 */
  /** 把语义层铺成 CSS 自定义属性 */
  function tokens(prefix, map) {
    return Object.keys(map).map(function (k) {
      return '--' + prefix + '-' + k + ':' + map[k] + ';';
    }).join('');
  }

  /** 生成「自动跟随系统主题」的 token 块 */
  function css() {
    var t = tokens('agl', LIGHT);      // 默认亮色
    var d = tokens('agl', DARK);       // 暗色覆盖
    return ':root, #agl-ctx{' + t + '}\n'
      + '@media (prefers-color-scheme:dark){#agl-ctx{' + d + '}}\n'
      // Antigravity 主界面用 data-ds-dark-theme / .dark 标记时也认
      + '#agl-ctx[data-agl-dark]{' + d + '}';
  }

  global.AGL_THEME = {
    PALETTE: PALETTE, LIGHT: LIGHT, DARK: DARK, METRIC: METRIC, css: css,
  };
})(typeof window !== 'undefined' ? window : globalThis);
/* === [END] Antigravity 上下文用量悬浮面板 === */
