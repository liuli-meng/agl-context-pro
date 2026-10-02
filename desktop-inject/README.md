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
| Rules / Skills | `GetTokenBase` | `customizationTokenBase.totalTokens`（实测 1673） |
| 对话消息 | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps` | `inputTokens + cacheReadTokens` |
| 模型名 | `GetCascadeModelConfigData` | 动态拿官方 `label`，不硬编码 |
| 窗口上限 | 本地推断 | Gemini 3.x = 1M / Claude 4.6 = 200K / GPT-OSS 120B = 128K |

**关键坑（踩过）**：
1. `modelUsage` 挂在 `CORTEX_STEP_TYPE_PLANNER_RESPONSE` 步上，**不在 CHECKPOINT 步**。
2. 真实上下文 = `inputTokens + cacheReadTokens`（实测 input 仅 2679，cacheRead 256172）。
3. `GetAllCascadeTrajectories` 必须带 `metadata:{ideName:'antigravity',extensionName:'antigravity'}`，
   否则返回空 `{}`。
4. **不能拿 `customizationBudget`(20000) 当上下文窗口** —— 那是 Rules/Skills 的预算，
   会让人误以为用了 44%。拿不到会话时应显示 `···` 而不是编造百分比。

## 与汉化补丁共存

两者都在 `dist/preload.js` 里，各有独立的 `/* === [START/END] ... === */` 标记。
`install` 以**当前 asar** 为基准（不是 `.bak`），先剥离旧的面板块再追加，
所以可以叠在汉化补丁之上，且可以反复执行。

备份链：
- `app.asar.bak` —— 官方基准备份（首次 install 时创建）
- `app.asar.prev.bak` —— 每次 install 前的现场快照

## 已验证

- asar 字节级补丁成功，preload.js 语法通过（62,150 字节）
- 面板块与汉化块共存，标记各 1 份（幂等）
- Electron 启动日志无 preload 报错、无 asar 完整性失败
- jsdom 环境完整跑通渲染链路（有会话 / 无会话两条路径）
