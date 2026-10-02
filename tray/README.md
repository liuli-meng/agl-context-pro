# Antigravity 上下文用量托盘监控

托盘上直接显示 Antigravity（桌面版）的上下文占用，点击弹出**卡片式用量面板**——不用再开 IDE、也不用装扩展。

## 卡片 UI（主界面）

点击托盘图标（或右键「查看上下文用量」）弹出卡片，仿 DeepSeek / ZCode 的上下文面板：

```
上下文已用 107%                    ~273K / 256K
█████████████████████████████████████████░░░
  ■ 系统提示词                              ~1.5K
  ■ 工具定义                                ~5.6K
  ■ 对话消息                              ~266.4K
  ■ Rules / Skills                          ~1.7K
  会话：Project UI And UX Optimiza
  模型：Gemini 3.8 Flash (High)  步数: 1466  ⚠ 已压缩
```

| 分段 | 数据来源 | 口径 |
|---|---|---|
| 系统提示词 | 估计值 | LS 未单独暴露，按固定开销 ~1.5K 近似 |
| 工具定义 | 估计值 | 同上，~5.6K |
| **对话消息** | **真实接口** | `inputTokens + cacheReadTokens`（当前会话真实上下文） |
| Rules / Skills | **真实接口** | `GetTokenBase` 的 `customizationTokenBase` |

> 前三段是 Antigravity 注入请求体的组成，其中「对话消息」能精确拿到；
> 「系统提示词 / 工具定义」LS 把它们混在输入里没拆开，所以用固定值近似——
> 好在它们量级稳定且占比小，不影响整体判断。

## 托盘图标怎么看

Windows 托盘只有 16×16，放文字必然糊，所以图标是**纯圆环**：

- **圆环弧长** = 上下文占用比例（12 点方向顺时针增长）
- **环的颜色** = 状态：🔵 蓝 < 65% / 🟠 橙 65~85% / 🔴 红 ≥ 85%
- 精确数值看**悬停提示**或**点击弹出的卡片**

## 怎么用

| 文件 | 作用 |
|---|---|
| `启动监控.cmd` | 双击启动（后台运行，不弹黑框） |
| `设置开机自启.cmd` | 配置开机自动启动 |
| `tray.py` | 托盘主程序 |
| `agl_ls.py` | Language Server 客户端（也可单独当 CLI 用） |

### 右键菜单

- **查看上下文用量**（左键单击同效）— 弹出卡片 UI
- **立即刷新** — 重新查询一次
- **复制到剪贴板** — 明细直接进剪贴板
- **打开程序目录**
- **退出**

## 命令行用法

```bat
python agl_ls.py            :: 打印用量和明细
python agl_ls.py --json     :: 输出原始 JSON
python agl_ls.py --probe    :: 只探测 Antigravity 是否在运行、能否复用
python agl_ls.py --no-reuse :: 不复用，强制自己起一个实例
```

输出示例：

```
上下文用量  ██░░░░░░░░░░░░░░░░░░░░░░░░░░    8.4%
            1673 / 20000 tokens（剩余 18509）
            复用运行中实例 · 耗时 19 ms

分组         项目                                    tokens
Rules      （小计）                                     182
Rules      C:\Users\<user>\.gemini\config\GEMINI.md        182
Skills     （小计）                                    1491
Skills     modern-web-guidance                          364
Skills     chrome-extensions                            325
...
```

## 技术说明

**用到的接口**：

| 接口 | 拿什么 |
|---|---|
| `GetTokenBase` | Rules / Skills 自定义内容预算（逐项拆解） |
| `GetAllCascadeTrajectories` | 会话列表 → 定位最近会话 |
| `GetCascadeTrajectorySteps` | 会话步骤 → 提取 `modelUsage` |

**两种连接方式，自动选择**：

1. **复用正在运行的实例**（约 20 毫秒）
   - CSRF token：从 LS 进程的命令行参数里读（`--csrf_token`）
   - 端口：从 `%APPDATA%\Antigravity\logs\language_server.log` 解析
   - **不会额外占内存，也不会干扰 Antigravity 运行**

2. **自己拉起一个实例**（约 8-23 秒）—— Antigravity 没开时的回退方案
   - 用系统随机分配的端口，复用相同的 `app_data_dir`，只读不写
   - 查完立即退出，不留常驻进程

所以：**Antigravity 开着时几乎秒出结果，关着时要等十几秒。**

**踩过的坑**（都在代码里绕开了）：

1. `--app_data_dir` 必须传**相对目录名**（如 `antigravity`），传绝对路径会让 LS 直接 Fatal 退出。
2. 本地 HTTPS 请求会被系统代理劫持，报 `502 Bad Gateway`。
   代码里用 `ProxyHandler({})` 显式禁用代理绕开。
3. 复用模式下**绝不能 terminate** 进程 —— 那是用户自己的 Antigravity。
   代码里用 `self.reused` 标志做了硬保护。
4. **`GetAllCascadeTrajectories` 请求体必须带 `metadata`**（`{ideName:'antigravity', extensionName:'antigravity'}`），
   否则返回空 `{}`。官方扩展同样如此。
5. **`modelUsage` 挂在 `PLANNER_RESPONSE` 步上**，不在 `CHECKPOINT` 步（这点与直觉相反）。
6. **真实上下文 ≈ `inputTokens + cacheReadTokens`**。只看 `inputTokens` 会严重低估——
   实测 `inputTokens=2679` 但 `cacheReadTokens=256172`，真实占用是 25 万而非 2 千。

**找 LS 的位置**：按以下顺序自动探测，也支持用环境变量 `AGL_LS_PATH` 覆盖。

1. `D:\Antigravity\app\resources\bin\language_server.exe`
2. `%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe`
3. `%PROGRAMFILES%\Antigravity\resources\bin\language_server.exe`

## 依赖

```
pip install pystray pillow psutil
```

**必须用带 `tkinter` 的 Python**（卡片 UI 靠它绘制）——推荐系统 Python 3.12：
`C:\Program Files\Python312\pythonw.exe`。
WorkBuddy 自带的 venv (`envs\default`) **没有 tkinter**，用它跑会看不到卡片。

## 版本兼容

针对 Antigravity 桌面版 2.19.1 验证（LS 2.18.1）。
Antigravity 更新后若失效，通常是 LS 启动参数变了——
改 `agl_ls.py` 的 `LanguageServer.start()` 里的 `args` 即可，
端口、CSRF 这些是自动处理的。
