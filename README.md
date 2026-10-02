# AGL Context Pro

[![CI](https://github.com/liuli-meng/agl-context-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/liuli-meng/agl-context-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)

Antigravity IDE 的上下文用量三重监控扩展：状态栏同时显示 **① 预算占用**、**② 当前对话用量** 和 **③ 官方额度**，纯 Node 实现、零 npm 依赖、无编译步骤。

## 它监控什么

| | 预算（Budget） | 对话（Conversation） | 官方额度（Quota） |
|---|---|---|---|
| 含义 | 自定义内容吃掉多少注入预算 | 当前 cascade 会话实际消耗 token | 服务端视角的模型剩余额度 |
| 数据源 | `GetTokenBase` | `GetAllCascadeTrajectories` + `GetCascadeTrajectorySteps` | `GetUserStatus` |
| 显示 | `1.7k/20k (8.4%)` | `82.1k/256k (32.1%)` | 每模型剩余 % + 重置时间 + 套餐 |
| 附加 | Rules/Skills 逐项拆解、截断告警 | 模型上限映射、压缩检测、会话列表 | tooltip 汇总、明细逐模型 |

三者的关系：预算是**每次请求固定注入的底噪**，对话是**随聊天增长的动态开销**，官方额度是**平台计费视角的剩余配额**（与云端接口同源，由本地 LS 带凭据代理）。

## 安装

从 [Releases](https://github.com/liuli-meng/agl-context-pro/releases) 下载 `.vsix`，然后在 Antigravity IDE 里：

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
│   → 末个 PLANNER_RESPONSE 的 modelUsage 即当前用量       │
│     （⚠ 挂在该步，不在 CHECKPOINT 步）                   │
│   → 真实上下文 = inputTokens + cacheReadTokens           │
│   → 相邻用量骤降 >20000 判定发生过压缩                  │
└──────────────────────────────────────────────────┘
```

模型上下文上限按家族推断（Gemini 3.x = 1M / Claude 4.6 = 200K / GPT-OSS 120B = 128K）——LS 不返回窗口字段，只能本地估算，与平台真实阈值可能相差一档，知悉即可。模型**显示名**则从 `GetCascadeModelConfigData` 动态拉取官方 `label`，官方加模型自动跟上，无需改代码。

**隐私**：所有请求只发往 `127.0.0.1`，不产生任何外部网络流量，不写任何文件。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `aglContext.pollSeconds` | `5` | 轮询间隔（秒），最小 2 |
| `aglContext.showConversation` | `true` | 状态栏是否显示对话用量段 |

状态栏颜色阈值：占用 ≥85% 红底告警，状态点 🔵<65% / 🟠<85% / 🔴≥85%（预算与对话取最差者）。预算发生截断时弹一次告警（换会话后重新启用）。

## Windows 托盘版

不想装扩展？[tray/](tray/) 目录提供同一数据链路的**独立托盘程序**（Python + pystray）：托盘圆环图标显示预算占用、悬停看明细、可开机自启，IDE 之外全局可用。详见 [tray/README.md](tray/README.md)。

## 桌面版主界面悬浮面板

Antigravity **桌面版**是纯 Electron 壳（非 VS Code 内核，装不了 VSIX）。[desktop-inject/](desktop-inject/) 提供直接注入方案：把一段脚本追加进 `app.asar` 内的 `dist/preload.js`，在**主界面右下角**渲染一个 DeepSeek / ZCode 风格的浮动胶囊 —— 点击展开分段彩条 + 明细卡片。

```
20%  ~200K / ~1.0M  Gemini 3.8 Flash (High)     ← 胶囊
┌─────────────────────────────────────┐
│ 上下文已用 20%          ~200K / ~1.0M │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ■ 历史上下文（缓存命中）        ~196K │
│ ■ 本轮新增输入                  ~3.2K │
│ ■ 本轮输出                       ~588 │
│ ■ Rules / Skills                ~1.7K │
│ 剩余可用 ~800K · 精确               │
│ 会话：遗留问题与设计梳理  步数：248   │
└─────────────────────────────────────┘
```

**认证**：LS 的每个 RPC 都要 CSRF token（缺了返回 `401 missing CSRF token`）。页面把它挂在全局 `window.__APP_CONFIG__.csrfToken`，面板直接读，请求时带 `X-Codeium-Csrf-Token` + `Connect-Protocol-Version: 1`。

**用量口径（实测）**：`modelUsage` 挂在**末个 `PLANNER_RESPONSE`** 步上（2.19.1 实测无 CHECKPOINT 步），真实上下文 = `inputTokens + cacheReadTokens`（+ 本轮 `outputTokens`）。`inputTokens` 只是未命中缓存的增量（实测 2.7K），`cacheReadTokens` 才是历史上下文主体（实测 196K）——**两个都要算**。

**为什么能这么做**：主界面由 `language_server.exe` 提供的本地页 `https://127.0.0.1:<动态端口>/` 渲染，preload 与页面**同源**，可以直接 `fetch` LS 的 RPC —— 不需要 CIM 探测进程、不需要 netstat 找端口、不解析日志。

与汉化补丁共存：两者都在 `dist/preload.js`，各有独立的 START/END 标记；`install` 以当前 asar 为基准，可反复执行不叠加。

详见 [desktop-inject/README.md](desktop-inject/README.md)。

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

- [AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor) —— 对话级监控的开创者，本扩展的 trajectory RPC 用法与压缩检测阈值（`COMPRESSION_MIN_DROP=5000`）逆向自其发行版代码；`GetUserStatus` 的响应结构与 proto3 remainingFraction 缺省坑也来自其 `fetchFullUserStatus()`。
- [Hhz0823/ZCode-Antigravity](https://github.com/Hhz0823/ZCode-Antigravity)（智谱 ZCode 生态，2026-09 开源）—— 其系统托盘的"5 小时/本周额度、重置时间"实现走了 Google 云端 `retrieveUserQuotaSummary` + 自建网关 OAuth；受此启发，本项目改用 LS 本地 `GetUserStatus` 拿同源数据，扩展内零凭据、零额外网络配置。
- `GetTokenBase` 预算接口为本项目独立发现（2026-09 实测），截至 v0.3.0 未见其他开源扩展使用。

## 已知边界

- Antigravity（桌面版或 IDE）未启动时显示「未连接」，启动后自动重连
- 同时开桌面版和 IDE 时连接先探活成功的那个（两者配置同源，预算数值一致；对话会话归属各自实例）
- `engines.vscode: ^1.85.0`，实测 Antigravity IDE 1.107.0 可用；未在 VS Code / Cursor 等其他 IDE 测试
- Windows 专用实现（PowerShell CIM + netstat），Linux/macOS 未适配（PR 欢迎改用 `ps` 探测）

## License

[MIT](LICENSE)
