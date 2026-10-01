# AGL Context Pro

[![CI](https://github.com/XiaoZuliang/agl-context-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoZuliang/agl-context-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](CHANGELOG.md)

Antigravity IDE 的上下文用量双监控扩展：状态栏同时显示 **① 预算占用** 和 **② 当前对话用量**，纯 Node 实现、零 npm 依赖、无编译步骤。

## 它监控什么

| | 预算（Budget） | 对话（Conversation） |
|---|---|---|
| 含义 | 自定义内容（Rules / Skills）吃掉多少注入预算 | 当前 cascade 会话实际消耗的 token |
| 数据源 | `GetTokenBase` | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps` |
| 显示 | `1.7k/20k (8.4%)` | `82.1k/256k (32.1%)` |
| 附加 | Rules / Skills 逐项拆解、截断告警 | 模型上限自动映射、压缩检测、会话列表 |

两者的关系：预算是**每次请求固定注入的底噪**，对话是**随聊天增长的动态开销**。现有扩展只看后者，本扩展两个都看。

## 安装

从 [Releases](https://github.com/XiaoZuliang/agl-context-pro/releases) 下载 `.vsix`，然后在 Antigravity IDE 里：

- 界面安装：`Ctrl+Shift+X` → 扩展面板右上角 `…` → **从 VSIX 安装**
- 或命令行安装（见 [docs/install-cli.md](docs/install-cli.md)，Antigravity 的 CLI 装扩展需要一点小技巧）

装完重启 IDE，左下角状态栏出现 `$(dashboard) …` 即生效。

## 工作原理

所有数据来自本机 Antigravity 自带的 language_server，通过它的 Connect-RPC HTTPS 接口直接读取：

```
┌─ 发现链路（与 IDE / 桌面版谁启动无关）──────────────────┐
│ 1. PowerShell CIM 找到所有 language_server.exe          │
│    → 命令行参数里提取 --csrf_token                       │
│ 2. netstat -ano 按 PID 反查 LISTENING 端口               │
│ 3. 对候选端口探活 RPC —— LS 开 HTTPS/HTTP 两个口，      │
│    只有 HTTPS 口能完成 TLS 握手，天然筛选               │
└──────────────────────────────────────────────────┘
┌─ 数据链路（热查询 ~20ms/路）───────────────────────────┐
│ GetTokenBase → 预算总量/剩余/分组拆解/截断标志          │
│ GetAllCascadeTrajectories（须带 metadata，否则返回空）   │
│   → 取最近修改的会话 → GetCascadeTrajectorySteps         │
│   → 末个 CHECKPOINT 的 modelUsage 即当前用量             │
│   → 相邻 checkpoint input 骤降 >5000 判定发生过压缩     │
└──────────────────────────────────────────────────┘
```

模型上下文上限按模型名映射（Claude 系 160k / Gemini Pro 128k / Gemini 3.5+ Flash 256k / GPT-OSS 80k），未知模型兜底 160k。上限映射是静态启发式，与平台真实 checkpointer 阈值可能相差一档，知悉即可。

**隐私**：所有请求只发往 `127.0.0.1`，不产生任何外部网络流量，不写任何文件。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `aglContext.pollSeconds` | `5` | 轮询间隔（秒），最小 2 |
| `aglContext.showConversation` | `true` | 状态栏是否显示对话用量段 |

状态栏颜色阈值：占用 ≥85% 红底告警，状态点 🔵<65% / 🟠<85% / 🔴≥85%（预算与对话取最差者）。预算发生截断时弹一次告警（换会话后重新启用）。

## 开发

```bash
node --check extension.js   # 语法检查
npm test                    # 离线 E2E：自签证书 + mock LS 全链路（无需启动 Antigravity）
python build.py             # 打包 VSIX 到 releases\（纯 Python zipfile 手搓，无 vsce）
node lsclient.js            # 真机联调：直连本机 LS 打印预算 + 对话数据
```

测试不依赖 Antigravity：`test/mock-ls.js` 用自签证书起一个模拟 LS，实现 4 个 RPC 方法返回固定数据（含压缩、截断场景），`test/run-tests.js` 断言解析与展示全链路。首次跑测试需生成证书：

```bash
openssl req -x509 -newkey rsa:2048 -keyout test/key.pem -out test/cert.pem \
  -days 3650 -nodes -subj "/CN=localhost"
```

## 致谢与出处

- [AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor) —— 对话级监控的开创者，本扩展的 trajectory RPC 用法与压缩检测阈值（`COMPRESSION_MIN_DROP=5000`）逆向自其发行版代码，模型上限映射参考其 `models.js`。本项目与它是**互补关系**：它专精对话级深度分析（成本估算、模型名动态解析），本项目胜在零依赖、双监控和状态栏轻量展示。
- `GetTokenBase` 预算接口为本项目独立发现（2026-09 实测），截至 v0.2.0 未见其他开源扩展使用。

## 已知边界

- Antigravity（桌面版或 IDE）未启动时显示「未连接」，启动后自动重连
- 同时开桌面版和 IDE 时连接先探活成功的那个（两者配置同源，预算数值一致；对话会话归属各自实例）
- `engines.vscode: ^1.85.0`，实测 Antigravity IDE 1.107.0 可用；未在 VS Code / Cursor 等其他 IDE 测试
- Windows 专用实现（PowerShell CIM + netstat），Linux/macOS 未适配（PR 欢迎改用 `ps` 探测）

## License

[MIT](LICENSE)
