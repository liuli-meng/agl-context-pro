# Windows 托盘版（独立运行，无需 IDE 扩展）

不想装扩展、或者想在 IDE 之外随时看上下文占用？这是同一条 `GetTokenBase` 数据链路的 **Windows 托盘形态**：

- 托盘图标 = **环形进度条**，外环弧长即预算占用，中心点变色（蓝=正常 / 橙≥65% / 红≥85%）
- 悬停显示 已用/上限、Rules/Skills 分组拆解、最近一次查询耗时
- 菜单：立即刷新 / 查看明细 / 复制到剪贴板 / 打开程序目录 / 退出
- 查询走「复用运行中 LS 优先，否则自拉实例」策略，不常驻后台

![图标设计](compare.png)

## 运行环境

- Windows 10/11
- Python 3.8+，依赖 `pystray`、`pillow`、`psutil`：
  ```
  pip install pystray pillow psutil
  ```
- Google Antigravity 桌面版（脚本自动在 `D:\Antigravity\app`、`%LOCALAPPDATA%\Programs\antigravity`、`%ProgramFiles%\Antigravity` 定位 `language_server.exe`，也可用环境变量 `AGL_LS_PATH` 手动指定）

## 使用

| 文件 | 作用 |
|---|---|
| `启动监控.cmd` | 双击启动托盘（后台 pythonw，不弹控制台） |
| `设置开机自启.cmd` | 菜单式启用/取消/查看开机自启（启动文件夹方案，免管理员、不碰注册表） |
| `tray.py` | 托盘主程序（启动 1.5s 后弹气泡确认存活；异常写入 `tray_error.log`） |
| `agl_ls.py` | LS 客户端。直接运行 `python agl_ls.py` 可在命令行查看用量明细 |

> **注意**：`启动监控.cmd` / `设置开机自启.cmd` 必须保持 **GBK/ANSI 编码**。cmd.exe 按 GBK 解析批处理文件，存成 UTF-8 会导致含中文的路径（如 `C:\Users\<中文名>\...`）被误判为不存在，报「找不到 Python 解释器」。

## 与 IDE 扩展版的关系

| | 扩展版（仓库根目录） | 托盘版（本目录） |
|---|---|---|
| 形态 | IDE 状态栏，随 IDE 启动 | Windows 托盘，随系统启动 |
| 数据 | 预算 + 对话用量 + 官方额度 | 预算（GetTokenBase） |
| 依赖 | 零依赖（Node 内置模块） | Python + pystray/pillow/psutil |
| 适用 | 写代码时顺带看 | IDE 之外全局可用、提醒更醒目 |

两者可同时使用，互不冲突（都只读 LS 接口，不写入任何状态）。
