# Changelog

## 0.3.1 — 2026-10-02

### 修复

- **对话用量口径漏掉缓存命中**：真实上下文改为 `inputTokens + cacheReadTokens + outputTokens`。
  旧实现只算 `input + output`，启用 prompt 缓存后会低估一个数量级
  （实测同一会话：5.3K vs 82K）。
- **对话用量恒为 0**：实测 `modelUsage` 挂在 `PLANNER_RESPONSE` 步上
  （该会话 1049 步：520 个 PLANNER_RESPONSE 全带用量，2 个 CHECKPOINT 一个都不带），
  而解析只认 `CHECKPOINT` → 状态栏的对话段永远不显示。改为两种类型都认。
- **取步接口忽略区间导致 21 倍重复拉取**：`GetCascadeTrajectorySteps` 忽略
  `startIndex`/`endIndex`，任何区间都返回整个会话（实测请求 `[1039,1049]` 仍回 1049 条）。
  桌面版面板曾按 50 一批分批拉 → 拿到 **21 份全量副本（1049 步 → 22029 条）**：
  每 5 秒白拉 20 倍数据，序列回绕（尾 33.5K 掉回首 15.3K）还会**伪造「已压缩」告警**。
  改为单次调用 + 本地尾部截断。
- **进度条与百分比对不上**：`Rules / Skills` 已被 LS 注入进 prompt、包含在 `modelUsage`
  里，进度条再画一段属重复计入。移除该段，明细行标注「已计入」。

### 变更

- 状态栏 / 明细文案：`checkpoints N · input X + output Y`
  → `用量步 N · 新增输入 X + 缓存命中 Y + 输出 Z`
- `conversation` 新增 `cacheReadTokens` / `usageSteps` 字段（`checkpoints` 保留兼容）
- 新增 `tailSteps()`：本地截尾，防大会话刷新时全量遍历
- 新增 `tools/verify-inject.js`：注入后校验 preload 内容与标记唯一性

### 测试

- 24 条（9 E2E + 15 纯函数）。新补：`PLANNER_RESPONSE` 形态、`cacheReadTokens` 计入 `used`、
  `tailSteps` 截尾、以及「重复副本回绕会伪造压缩判定」的回归锁。

## 0.3.0 — 2026-10-01

### 新增
- **官方额度视图（GetUserStatus）**：状态栏 tooltip 与明细弹层展示服务端下发的每模型剩余比例与重置时间、套餐名（Google AI Pro/Ultra/Free）、Credits
  - 数据与云端 `retrieveUserQuotaSummary` 同源，但由本地 LS 带凭据代理——扩展内零 OAuth、零云端请求
  - 处理 proto3 float 0.0 缺省坑：remainingFraction 缺失时按 resetTime 判定（epoch → 满额，未来时间 → 已用尽）
- 测试用例补齐（7 用例）

### 调研来源
- [Hhz0823/ZCode-Antigravity](https://github.com/Hhz0823/ZCode-Antigravity)（开源）：其 Windows 托盘的"5 小时/本周额度、重置时间"来自 Google 云端 quota 接口 + 自建网关 OAuth 代理；本项目改为走 LS 本地 `GetUserStatus` 等价实现
- [AGI-is-going-to-arrive](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor) 的 `fetchFullUserStatus()` 验证了 `GetUserStatus` 响应结构与 proto3 缺省坑

## 0.2.0 — 2026-10-01

### 新增
- **对话级用量监控**：状态栏新增第二段显示，展示当前 cascade 会话的实际 token 用量与模型上限百分比
  - 数据链路：`GetAllCascadeTrajectories`（带 metadata）→ 最近会话 → `GetCascadeTrajectorySteps` → 末个 CHECKPOINT 的 `modelUsage`
  - 模型上下文上限自动映射：Claude 系 160k / Gemini Pro 128k / Gemini 3.5+ Flash 256k / GPT-OSS 80k
  - 压缩检测：相邻 checkpoint input 骤降 >5000 判定发生过自动压缩，UI 显示 ⚠ 与回落量
  - 明细弹层列出最近 8 个历史会话（状态 / 步数 / 修改时间）
- **截断告警**：上下文预算发生截断（部分 Rules/Skills 未完整注入）时弹警告，同一会话只提醒一次
- **配置项** `aglContext.showConversation`（默认开）：关闭后状态栏只显示预算段
- **测试设施**：`test/mock-ls.js`（自签证书模拟 LS）+ `test/run-tests.js`（6 用例离线 E2E），`npm test` 一键运行
- **CI**：GitHub Actions 工作流（语法检查 + 测试 + VSIX 打包）

### 变更
- 状态栏颜色/告警阈值改为预算与对话两者取最差
- `package.json` 补充 `repository` / `homepage` / `bugs` 字段

## 0.1.0 — 2026-10-01

首个可用版本。

- 预算监控：`GetTokenBase` 全量拆解（总量 / 剩余 / Rules / Skills 逐项 / 截断标志）
- LS 自动发现：PowerShell CIM 提取 `--csrf_token` → netstat 反查端口 → HTTPS 探活筛选，热查询 ~20ms，与 IDE / 桌面版谁启动无关
- 三层展示：状态栏单行 / 悬停 Markdown / QuickPick 逐项明细，概要行一键复制全文
- 离线 VSIX 打包器 `build.py`（纯 Python zipfile，无 vsce 依赖）
