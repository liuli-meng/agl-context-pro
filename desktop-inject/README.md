# Antigravity 上下文用量悬浮面板

给 **Antigravity 桌面版**主界面右下角加一个 DeepSeek / ZCode 风格的上下文用量胶囊。

- 右下角浮动胶囊：`27% ~266K / ~1.0M Gemini 3.8 Flash (High)`
- 点击展开卡片：分段彩条 + 明细（系统提示词 / 工具定义 / 对话消息 / Rules·Skills）+ 剩余可用
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

## 数据来源

| 面板项 | RPC | 说明 |
|---|---|---|
| 项目 | 来源 |
|---|---|
| Rules / Skills | `GetTokenBase` → `customizationTokenBase.totalTokens`（实测 1673） |
| 对话上下文 | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps`（见下方算法） |
| 模型名 | `GetUserStatus` → `cascadeModelConfigData.clientModelConfigs[].label`，动态拿，不硬编码 |
| 窗口上限 | 本地推断：Gemini 3.x = 1M / Claude 4.6 = 200K / GPT-OSS 120B = 128K |

### 上下文用量算法

对齐开源实现 [Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor)
及其 [Windows 移植版](https://github.com/daluoxiaojun/antigravity-context-window-monitor-win)：

```
contextUsed = 末个 CHECKPOINT 的 inputTokens
            + 该 CHECKPOINT 的 outputTokens
            + 之后所有 toolCallOutputTokens
            + 之后的字符估算量
```

字符估算公式：

```js
tokens = ceil(asciiChars / 4 + nonAsciiChars / 1.5)
```

无 CHECKPOINT 时兜底：`系统提示词 10000 + 全部 toolCall 输出 + 字符估算`。

**⚠ 三个曾经搞错、被开源实现纠正的点**：

1. **`modelUsage` 属于 `CHECKPOINT` 步**（开源实现都在这里读）。
   只在 `PLANNER_RESPONSE` 找会漏掉真正的 checkpoint 值。
2. **绝不能用 `cacheReadTokens`** —— 那是缓存命中量（实测 256172），
   加进去会把 20% 的会话算成 104%。真实上下文就是 `input + output`。
3. **必须拉全部步骤，不能只取尾部** —— CHECKPOINT 可能在中段。
   要分批（50/批，5 并发）拉完 `stepCount` 条。

其他坑：
4. `GetAllCascadeTrajectories` 必须带 `metadata:{ideName:'antigravity',extensionName:'antigravity'}`，
   否则返回空 `{}`。
5. **不能拿 `customizationBudget`(20000) 当上下文窗口** —— 那是 Rules/Skills 预算。
6. 会话选择要按状态优先级：`CASCADE_RUN_STATUS_RUNNING` > 上次跟踪的 > 最新的，
   只按 `lastModifiedTime` 排序会挑到归档的旧会话。

## 与汉化补丁共存

两者都在 `dist/preload.js` 里，各有独立的 `/* === [START/END] ... === */` 标记。
`install` 以**当前 asar** 为基准（不是 `.bak`），先剥离旧的面板块再追加，
所以可以叠在汉化补丁之上，且可以反复执行。

备份链：
- `app.asar.bak` —— 官方基准备份（首次 install 时创建）
- `app.asar.prev.bak` —— 每次 install 前的现场快照

## 已验证

- asar 字节级补丁成功，preload.js 语法通过（68,052 字节）
- 面板块与汉化块共存，标记各 1 份（幂等）
- Electron 启动日志无 preload 报错、无 asar 完整性失败
- jsdom 跑通三条路径：
  - 真实 checkpoint（`input=200K, output=4K` → `20% ~204K / ~1.0M`）
  - 长会话 260 步（验证分批拉取）
  - 无会话（显示「还没有对话」，不虚报）

## 致谢

算法参考这几个开源实现，特此注明：

- [AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor)
  —— `computeUsageFromSteps` 的整体结构、字符估算公式、压缩检测阈值
- [daluoxiaojun/antigravity-context-window-monitor-win](https://github.com/daluoxiaojun/antigravity-context-window-monitor-win)
  —— 窗口上限映射表（Gemini 1M / Claude 200K / GPT-OSS 128K）、分批拉取策略、会话选择优先级
