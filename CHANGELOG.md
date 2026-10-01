# Changelog

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
