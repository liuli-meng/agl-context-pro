# Changelog

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
