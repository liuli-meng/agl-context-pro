# Antigravity 上下文用量悬浮面板

给 **Antigravity 桌面版**主界面右下角加一个 DeepSeek / ZCode 风格的上下文用量胶囊。

- 右下角浮动胶囊（**26px 高**）：`◔ 41% │ 105K / 256K` —— 模型名平时不占位，**悬停整条胶囊才展开**
- 点击展开卡片（**244×211**）：分段彩条 + 明细（历史上下文 / 本轮新增 / 输出 / Rules·Skills）+ 来源与剩余
- **自动跟随系统亮/暗主题**（token 层驱动，不需要两套 CSS）
- 5 秒轮询自动刷新，只在页面可见时拉取

## 视觉规范

`src/theme.js` 是独立的设计 token 层，三层结构对齐 DeepSeek Harness / ZCode 桌面版：

```
原始色阶  →  语义别名  →  组件 CSS
PALETTE      LIGHT/DARK    panel.js 里只写 var(--agl-*)
```

| 层 | DSH 对应 | ZCode 对应 | 本项目 |
|---|---|---|---|
| 原始 | `--dsw-static-neutral-bluish-*` | `--v2-grey-*` / `--v2-alpha-*` | `PALETTE` |
| 语义 | `--dsw-alias-label-primary` | `--v2-text-text-base` | `LIGHT` / `DARK` |
| 组件 | 直接引用 alias | `[data-component=...]` | `var(--agl-text-primary)` |

几条从源码里提炼的原则：

1. **中性色带蓝味，不用纯灰**。两家都是（DSH `#0f1115`/`#61666b`，ZCode `#161616`/`#5c5c5c`）——纯灰显脏。本项目 `PALETTE.n*` 全系偏冷。
2. **大面积中性 + 极少量彩色**。彩色只给进度条 fill 和状态点，文字全走灰阶。避免四五个饱和色块并排。
3. **边框极淡**。DSH `border-l2 = #0000001a`、ZCode `--v2-alpha-dark-10`，本项目 `border-hair` = 7% 不透明度。靠层次和留白区分，不靠描边。
4. **字号阶梯 12/13/14/15/22，行高 1.3/1.5，字重 400/500/600**，与两家一致。
5. **数字全用 `tabular-nums`**，位数变化时不跳动。
6. **主数字只出现一次**（卡片右上角那个大百分比），不在别处重复。

改主题只需要动 `theme.js`，`panel.js` 里的 CSS 一行不用改。

## 原理

Antigravity 桌面版是**纯 Electron 壳**（不是 VS Code 内核，装不了 VSIX）。
它的主界面由 `language_server.exe` 提供的本地页 `https://127.0.0.1:<动态端口>/` 渲染。

所以做法是：**把一段脚本追加进 `app.asar` 内的 `dist/preload.js`**。
preload 在每个页面加载前执行，且**与页面同源** —— 可以直接 `fetch` LS 的 RPC，
不需要 psutil 探测进程、也不解析日志。

注入时 `theme.js` 与 `panel.js` 按顺序拼接成一个块。**两个源文件各自带一对 START/END 标记**
（单独看各自完整），所以 `install` 会先把源文件的标记剥掉、只在外层包一对 ——
否则负载里会出现两对标记，非贪婪匹配只吃掉前半块，重复 install 会**层层叠加**。

⚠ 标记串必须与 `inject.js` 的 `MARK_START` / `MARK_END` **逐字一致**。
改标记时两边一起改；只改一边（哪怕只是加个 `· xxx` 后缀）都会让 `stripBlock` 匹配不上。
`ANY_BLOCK_RE` 已放宽到能吃带后缀的变体，但别依赖这个兜底。

**验证幂等**：连续 `install` 三次，asar 里 `preload.js` 的标记数应恒为 2（一对）。

## 尺寸

| 元素 | 尺寸 |
|---|---|
| 胶囊 | 高 26px；未悬停宽 130px（有数据）/ 95px（无会话） |
| 胶囊悬停 | 展开模型名 +104px |
| 卡片 | 244 × 211（有数据）/ 244 × 144（无会话） |
| 进度条 | 高 5px |
| 圆环 | 12px |

## 用法

```bash
# 状态
node inject.js status

# 注入（幂等：重复执行不会叠加，以当前 asar 为基准，保留汉化补丁）
node inject.js install

# 移除
node inject.js uninstall
```

注入后**只做一件事：完全退出 Antigravity 再重新打开**（点桌面快捷方式即可，不用管代理）。
preload 在页面加载前执行，所以必须重启才生效。

node 用任意 18+ 的 Node 均可（本机用的是 WorkBuddy 自带的 `node.exe`）。

## 认证（CSRF）

LS 要求每个请求带 CSRF token，否则返回 `401 {"code":"unauthenticated","message":"missing CSRF token"}`。

token 由 main 进程 `crypto.randomUUID()` 生成后传给 LS，**页面把它挂在全局**：

```js
window.__APP_CONFIG__ = {
  productName: "antigravity",
  csrfToken: "ead0b117-3558-4e28-8476-91365fc03a0d",
  appVersion: "2.19.1",
  releaseChannel: "stable",
  devMode: false,
}
```

直接读 `window.__APP_CONFIG__.csrfToken` 即可（面板还留了 hook fetch/XHR 嗅探作为兜底）。
发请求时带上：

```
X-Codeium-Csrf-Token: <token>
Connect-Protocol-Version: 1
Content-Type: application/json
```

token 在应用生命周期内不变（每次启动应用重新生成），401 时清空重取。

### ⚠ 大坑：contextIsolation 下「直读全局」是读不到的

**Antigravity 开了 `contextIsolation`**，preload 跑在 **Electron Isolated Context**，
而 `__APP_CONFIG__` 挂在 **主世界**。两者共享 DOM，但 **window 对象互不可见**。

CDP 实测（Antigravity 2.19.1，同一时刻对照）：

| 执行上下文 | `__APP_CONFIG__` | cookie | localStorage | 同一条 `GetTokenBase` |
|---|---|---|---|---|
| `default`（主世界） | ✅ `csrfLen=36` | — | — | ✅ `200 len=855` |
| `Electron Isolated Context`（preload 所在） | ❌ `NO_CONFIG` | 空 | 无 token | ❌ `401 missing CSRF token` |

**踩过的坑**：旧版 `sniffCsrf()` 只是 hook 自己（隔离世界）的 `fetch` / `XHR` —— 
但页面的真实请求发生在主世界，**根本 hook 不到**；「直读全局」又跨不过世界边界。
两条路都是死的 → 所有 RPC 401 → 面板永远停在「数据获取中… / 等待 Antigravity 响应…」。

**解法：用 DOM 搭桥**（DOM 是两个世界唯一的共享面）
往主世界注入一个 `<script>`，让它读 `__APP_CONFIG__.csrfToken` 并写到
`<html data-agl-csrf="…">`，隔离世界再从这个属性读回来。三级兜底：

1. **DOM 桥**（`installMainWorldBridge()`）—— 主世界注入，主力方案
2. **直读全局**（`readCsrfFromGlobal()`）—— 万一某版本关掉了隔离
3. **hook fetch/XHR** —— 老兜底，留着无害

桥是异步的（`<script>` 要一拍才执行），所以 `waitCsrfAndRefresh()` 轮询 25 次 × 300ms。

> 排查这类问题的通用手法：用 CDP `Runtime.enable` 枚举 `executionContextCreated`，
> 然后在**每个 context 里分别求值**对比 —— 一眼就能看出是不是被隔离世界坑了。
> 注意 CDP 的 WS 连接会被拒（403），需要 `suppress_origin=True` 或
> `--remote-allow-origins`。

## 数据来源

| 面板项 | RPC / 来源 | 说明 |
|---|---|---|
| Rules / Skills | `GetTokenBase` → `customizationTokenBase.totalTokens`（实测 1673） |
| 对话上下文 | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps`（见下方算法） |
| 模型名 | `GetUserStatus` → `cascadeModelConfigData.clientModelConfigs[].label`，动态拿，不硬编码 |
| 平台截断阈值 | **不是原生窗口**：Gemini 3.5~3.8 Flash **256K** / Gemini 3.1 Pro 128K / Claude 4.6 160K / GPT-OSS 120B 80K。Gemini 原生能吃到 1M，但平台只给 Flash 系开 256K —— 实测压缩点落在 27 万即由此而来 |

### 上下文用量算法（实测口径）

**关键事实**：`modelUsage` **不是**逐轮累加的。它就是「这一步发给模型的完整前缀长度」，
而它被拆成两块：

- `inputTokens` —— 本轮**未命中缓存**的部分（很小，实测 2721）
- `cacheReadTokens` —— **命中缓存**的部分（就是历史上下文主体，实测 191639）

所以：

```
真实上下文 = 最后一个带 modelUsage 的步的
             inputTokens + cacheReadTokens + outputTokens
           + 该步之后的 toolCallOutputTokens
           + 该步之后的字符估算量
```

字符估算公式（只在没有 usage 时兜底用）：

```js
tokens = ceil(asciiChars / 4 + nonAsciiChars / 1.5)
```

一个 usage 都没有时兜底：`系统提示词 10000 + 全部 toolCall 输出 + 字符估算`。

**⚠ 实测踩过的四点**：

1. **`modelUsage` 的位置随版本变**：Antigravity 2.19.1 实测挂在
   **`CORTEX_STEP_TYPE_PLANNER_RESPONSE`** 上（241 步的会话里 119 个 usage、**零个 CHECKPOINT**）。
   别的版本挂在 `CHECKPOINT` 上 —— **两个类型都要认**。
2. **必须算 `cacheReadTokens`**。只看 `inputTokens` 会低估约 70 倍
   （实测 2721 vs 真实 194K）。这是最初「面板数字太小」的根因。
3. **不能逐轮累加 usage**：`inputTokens/cacheReadTokens` 已经是累计前缀，
   累加会指数爆炸。只取**最后一条**，再加尾部的增量。
4. **`GetCascadeTrajectorySteps` 忽略 `startIndex`/`endIndex`** —— 不管请求哪个区间，
   回来的都是整个会话。实证：`[0,10]`、`[500,600]`、`[1000,1010]`、`[1039,1049]`
   四次调用全部返回完整 1049 条。
   ⚠ 曾经按「分批 50、5 并发」拉，以为能拿全 —— 实际是 **21 份全量副本 = 22029 条**：
   每 5 秒白拉 20 倍数据，序列回绕（尾 33.5K 掉回首 15.3K）还会**伪造出「已压缩」告警**。
   正解：**只调用一次**，大会话在本地截尾（`tailSteps`）。

其他坑：

5. `GetAllCascadeTrajectories` 必须带 `metadata:{ideName:'antigravity',extensionName:'antigravity'}`，
   否则返回空 `{}`。
6. **不能拿 `customizationBudget`(20000) 当上下文窗口** —— 那是 Rules/Skills 预算。
7. 会话选择要按状态优先级：`CASCADE_RUN_STATUS_RUNNING` > 上次跟踪的 > 最新的，
   只按 `lastModifiedTime` 排序会挑到归档的旧会话。
8. 压缩检测：相邻 usage 上下文骤降 > 5000 视为已压缩，卡片标 `⚠ 已压缩`。

## 与汉化补丁共存

两者都在 `dist/preload.js` 里，各有独立的 `/* === [START/END] ... === */` 标记。
`install` 以**当前 asar** 为基准（不是 `.bak`），先剥离旧的面板块再追加，
所以可以叠在汉化补丁之上，且可以反复执行。

备份链：
- `app.asar.bak` —— 官方基准备份（首次 install 时创建）
- `app.asar.prev.bak` —— 每次 install 前的现场快照

## 已验证

**真实页面验证**（通过 CDP 连运行中的 Antigravity，把 panel.js 注入进去看渲染）：

- 真实会话（用 CDP 实读面板 DOM）：`41% | 105K / 256K`
  - 对应原始数据 `input=7300 + cacheRead=97700 + output=130 ≈ 105K` ✅ **完全吻合**
  - 明细行：`历史上下文（缓存命中）97.7K / 本轮新增输入 7.3K / 本轮输出 130`
  - 同一会话的压缩点：`CHECKPOINT` 步携带 `checkpoint.sessionSummary`（压缩后的摘要），
    其 `retryInfos[0].usage` = `input 5849 + cacheRead 265417 = 271266` —— 这才是触发压缩的真实用量
- 四个 RPC 全部 HTTP 200：`GetTokenBase` / `GetAllCascadeTrajectories` /
  `GetCascadeModelConfigData` / `GetUserStatus`

**注入完整性**：

- asar 字节级补丁成功，注入后 preload.js 83,157 字节、语法通过
- 连续 `install` 三次，标记恒为 1 对（幂等）
- 面板块与汉化块共存（`app.asar.bak` 为官方基准；若汉化在先，起点用 `app.asar.2.18.1-patched.bak`）
- 从 asar 抽出的块实际渲染：亮 `--agl-text-primary=#191c21` / 暗 `#eceded`，卡片 244×211，`pageerror` 无

**jsdom 覆盖三条路径**：

- 真实形态（`modelUsage` 在 `PLANNER_RESPONSE`，末步 `cacheRead=191.6K`）→ `19% ~194K`
- 长会话 260 步（验证全量返回 + 本地截尾）
- 无会话（显示「还没有对话」，不虚报）

## 致谢

算法参考这两个开源实现，特此注明：

- [AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor)
  —— 字符估算公式、压缩检测阈值、单次拉取 + 尾部截断思路
- [daluoxiaojun/antigravity-context-window-monitor-win](https://github.com/daluoxiaojun/antigravity-context-window-monitor-win)
  —— 平台截断阈值映射表（Flash 256K / Pro 128K / Claude 160K / GPT-OSS 80K）、会话选择优先级
