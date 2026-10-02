# Antigravity 上下文用量悬浮面板

给 **Antigravity 桌面版**主界面右下角加一个 DeepSeek / ZCode 风格的上下文用量胶囊。

- 右下角浮动胶囊：`20% ~200K / ~1.0M Gemini 3.8 Flash (High)`
- 点击展开卡片：分段彩条 + 明细（历史上下文 / 本轮新增 / 输出 / Rules·Skills）+ 剩余可用
- 5 秒轮询自动刷新，只在页面可见时拉取

## 原理

Antigravity 桌面版是**纯 Electron 壳**（不是 VS Code 内核，装不了 VSIX）。
它的主界面由 `language_server.exe` 提供的本地页 `https://127.0.0.1:<动态端口>/` 渲染。

所以做法是：**把一段脚本追加进 `app.asar` 内的 `dist/preload.js`**。
preload 在每个页面加载前执行，且**与页面同源** —— 可以直接 `fetch` LS 的 RPC，
不需要 psutil 探测进程、也不解析日志。

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

node 用 `C:\Users\<user>\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`。

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

## 数据来源

| 面板项 | RPC / 来源 | 说明 |
|---|---|---|
| Rules / Skills | `GetTokenBase` → `customizationTokenBase.totalTokens`（实测 1673） |
| 对话上下文 | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps`（见下方算法） |
| 模型名 | `GetUserStatus` → `cascadeModelConfigData.clientModelConfigs[].label`，动态拿，不硬编码 |
| 窗口上限 | 本地推断：Gemini 3.x = 1M / Claude 4.6 = 200K / GPT-OSS 120B = 128K |

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
4. **必须拉全部步骤**：usage 可能出现在中段，只取尾部会漏。分批 50、5 并发拉完 `stepCount` 条。

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

- 真实会话「遗留问题与设计梳理」（241 步）：面板 **`20% ~200K / ~1.0M`**
  - 对应原始数据 `input=3xxx + cacheRead=196xxx + output=588 = 200xxx` ✅ **完全吻合**
  - 明细行：`历史上下文（缓存命中）196K / 本轮新增输入 3.2K / 本轮输出 588`
- 四个 RPC 全部 HTTP 200：`GetTokenBase` / `GetAllCascadeTrajectories` /
  `GetCascadeModelConfigData` / `GetUserStatus`

**注入完整性**：

- asar 字节级补丁成功，注入后 preload.js 73,689 字节、语法通过
- 面板块与汉化块共存，标记各 1 份（幂等）

**jsdom 覆盖三条路径**：

- 真实形态（`modelUsage` 在 `PLANNER_RESPONSE`，末步 `cacheRead=191.6K`）→ `19% ~194K`
- 长会话 260 步（验证分批拉取）
- 无会话（显示「还没有对话」，不虚报）

## 致谢

算法参考这两个开源实现，特此注明：

- [AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor)
  —— 字符估算公式、压缩检测阈值、分批拉取思路
- [daluoxiaojun/antigravity-context-window-monitor-win](https://github.com/daluoxiaojun/antigravity-context-window-monitor-win)
  —— 窗口上限映射表（Gemini 1M / Claude 200K / GPT-OSS 128K）、会话选择优先级
