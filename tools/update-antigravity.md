# Antigravity 更新兼容方案

## 问题

Antigravity 实际装在 `D:\Antigravity\app`（571 MB），但 C 盘用一个 **junction（目录联接）** 指过去：

```
C:\Users\灵梦\AppData\Local\Programs\antigravity
    └─ junction ──> D:\Antigravity\app
```

这么做当初是为了省 C 盘空间。代价是：**官方更新器永远失败**，弹框报

```
Failed to uninstall old application files
```

原因：Antigravity 用的是 **NSIS** 安装包（156 MB，Nullsoft）。NSIS 的卸载器在清理旧文件时**不跟随 junction / 重解析点**。它按注册表里记的路径去 `C:\...\Programs\antigravity` 删东西，而那里只是个链接，真实的 571 MB 在 D 盘动都不动 —— 卸载"成功"了但实际上没删干净，接着安装又发现目标存在，于是报错回滚。**死循环，更新永远装不上。**

## 思路

更新的时候，临时把安装"还原"成 C 盘的真目录，骗过 NSIS：

```
① 备份 D:\Antigravity\app          → D:\Antigravity\backup\app-<时间戳>
② 摘掉 C 盘 junction
③ D:\Antigravity\app  ──搬──> C:\...\Programs\antigravity   （真目录了）
④ 跑官方 NSIS 安装包                  ← 这次它能正常卸载+安装
⑤ 验证新版本就位
⑥ C 盘真目录 ──搬──> D:\Antigravity\app
   重建 junction
⑦ 重新注入自研面板 + 提示重打汉化
```

装完之后结构跟原来**一模一样**，还是 junction 指 D 盘。下次更新再跑一遍这个脚本即可。

## 用法

```cmd
cd "E:\AGL Context Pro\tools"

REM 只看状态，不做任何改动
update-antigravity.cmd --check

REM 正式更新（有交互确认）
update-antigravity.cmd
```

要求：**待装包已下载好**。它的位置在

```
C:\Users\灵梦\AppData\Local\antigravity-updater\pending\Antigravity-x64.exe
```

让 Antigravity 自己触发一次更新下载（就是它在弹"更新失败"对话框之前，其实已经把包下好了），或者去 https://antigravity.google/download 手动下。脚本会自己找到它；找不到会提示你手输路径。

## 每一步在干什么

| 步骤 | 动作 | 风险 |
|---|---|---|
| 0 | 用 Node 探针检查 D 盘实体、C 盘 junction、待装包 | 无（只读） |
| 1 | 确认 Antigravity / language_server 已退出，并做防重入锁检查 | 无 |
| 2 | `robocopy /E` 全量备份到 `D:\Antigravity\backup\app-<时间戳>` | 只增不删 |
| 3 | 摘 junction → 实体搬回 C 盘真目录 | **有**，中断会留在中间态 |
| 4 | `start /wait` 跑官方安装包 | **有**，会走官方卸载+安装 |
| 5 | 验证 `C:\...\antigravity\Antigravity.exe` 存在 | 无 |
| 6 | 搬回 D 盘 → PowerShell 重建 junction → 删 flag | **有** |
| 7 | `node inject.js install` 重注入面板 | 无 |

## 中断了怎么办

脚本在步骤 2 之后会写一个 `D:\Antigravity\backup\_update_in_progress.flag`。如果中途挂了，这个 flag 会留着，下次运行**会直接拒绝启动**（防重入）。

手动恢复：

```cmd
REM 1. 删掉 C 盘那个目录（先确认它不是 junction）
rmdir /S /Q "C:\Users\灵梦\AppData\Local\Programs\antigravity"

REM 2. 备份搬回 D 盘
robocopy "D:\Antigravity\backup\app-<时间戳>" "D:\Antigravity\app" /E /MOVE

REM 3. 重建 junction（中文用户名下必须用 PowerShell）
powershell -Command "New-Item -ItemType Junction -Path 'C:\Users\灵梦\AppData\Local\Programs\antigravity' -Target 'D:\Antigravity\app'"

REM 4. 删 flag
del "D:\Antigravity\backup\_update_in_progress.flag"
```

## 两个附带坑

**坑 A：更新会冲掉自研面板。**
AGL Context Pro 的面板是通过补丁 `app.asar` 注入的。更新后 asar 被整个换掉，补丁自然没了。脚本第 7 步会自动重跑 `node desktop-inject/inject.js install`。

**坑 B：更新也会冲掉汉化补丁（Antigravity-CN）。**
这个脚本管不了，需要更新完后手动重跑汉化 patcher。

---

## 附：另一个更常遇到的坑 —— 窗口全黑

### 现象

打开 Antigravity，窗口出来了、标题栏正常，但**内容区一片黑**，什么都没有。

### 病因（跟 asar、汉化、面板都无关）

Antigravity 的界面**不是静态文件**，而是由 `language_server.exe` 通过
`https://127.0.0.1:<随机端口>/` 提供的（LS 日志里那句
`Serving UI bundle from embedded assets`）。渲染进程加载这个 URL 有
**30 秒硬超时**。

而 LS 冷启动可能超过 30 秒。日志里的典型样子：

```
13:43:23  Starting language server process with pid 26556
13:43:40  URL: https://daily-cloudcode-pa.googleapis.com/...:loadCodeAssist
13:43:51  URL: https://daily-cloudcode-pa.googleapis.com/...:loadCodeAssist   ← 隔了 11s，超时重试
13:43:53  URL: https://daily-cloudcode-pa.googleapis.com/...:loadCodeAssist
13:43:55  initialized server successfully in 31.9092809s                       ← 31.9s！
```

渲染进程在 13:43:53 就 `ERR_TIMED_OUT` 放弃了，LS 只差 2 秒。于是 Chromium
停在错误页 `chrome-error://chromewebdata/`，就是你看到的全黑窗口。

### 为什么 LS 会慢到 30 秒

**`language_server.exe` 是 Go 二进制，只认 `HTTP_PROXY` / `HTTPS_PROXY`
环境变量，不认 Windows 系统代理（WinINET）**，也就是 v2rayN 设的那个。

如果直接双击 `Antigravity.exe`（开始菜单快捷方式就是这么指过去的），
LS 会**直连** `oauth2.googleapis.com` / `cloudcode-pa.googleapis.com`。
国内直连这俩就是超时重试，启动自然被拖到 30 秒开外。

`D:\Antigravity\Antigravity-proxy.cmd` 就是为了解决这个而存在的 —— 它先设好

```bat
set "HTTP_PROXY=http://127.0.0.1:10808"
set "HTTPS_PROXY=http://127.0.0.1:10808"
set "NO_PROXY=localhost,127.0.0.1,::1"
```

再启动 exe（v2rayN 的 10808 是 mixed 入站，同时支持 socks5 和 HTTP CONNECT）。
`NO_PROXY` 里排除 127.0.0.1，保证应用自己的本地 gRPC 走直连。

**但开始菜单的 `Antigravity.lnk` 指向的是 `Antigravity.exe`，不是这个启动器** ——
proxy 环境变量根本没生效。

### 怎么判断当前实例有没有走代理

```bat
netstat -ano | findstr :10808
```

看 `language_server.exe` 的 PID 在不在这个列表里。不在 = 直连 = 随时可能黑屏。

### 立即修复（不重启应用）

```cmd
cd "E:\AGL Context Pro\tools"
node fix-black-screen.js
```

它会：找出 CDP 端口 → 判断窗口是否停在错误页 → 轮询等 LS 真正就绪 →
发一次 `Page.reload` → 复验渲染与面板。加 `--check` 只检测不重载。

### 根治

让 Antigravity 始终带上代理环境变量启动，二选一：

1. **把开始菜单快捷方式改成指向 `Antigravity-proxy.cmd`**（最简单）
2. **改造 `Antigravity-proxy.cmd` 成自适应版**：先探测 10808 是否在监听，
   在才设代理变量；不在就直连启动（避免 v2rayN 没开时反而连不上）

方案 2 更稳，因为 v2rayN 不运行时，写死代理会让 LS 直接连不上。

---

## 为什么脚本里全是英文

这个 `.cmd` **故意只写 ASCII 字符 + CRLF 换行**。

原因是我们踩过：在中文用户名（`灵梦`）的机器上，`.cmd` 里混中文 + `setlocal EnableDelayedExpansion` + `echo` 组合，会被 cmd 解析器按 GBK/UTF-8 字节切碎，出现

```
'P_DIR' 不是内部或外部命令
'X]' 不是内部或外部命令
'柯?' 不是内部或外部命令
```

这类把一整行切成碎片的报错。转成 GBK 也救不了（我们试过）。**纯 ASCII 是唯一稳的做法**，中文说明就放这个文档里。

## 另一个隐蔽的坑：`dir /AL` 检测不到 junction

脚本原本用 `dir /AL "%C_LINK%"` 判断 C 盘是不是 junction。**它在这台机器上会给出错误答案**：

```
> dir /AL C:\Users\灵梦\AppData\Local\Programs\antigravity
 找不到文件        ← 假的！junction 明明存在
```

原因是 `cmd.exe` 继承的代码页解析不了 `灵梦` 这两个字，直接把路径判成"不存在"。如果用这个结果，脚本会**误以为 C 盘是真目录，跳过摘 junction 那一步**，后面全崩。

解决办法：改用 Node 写的探针 `tools/probe-antigravity.js`，用 `fs.lstatSync().isSymbolicLink()` 判断 —— Node 处理中文路径没问题：

```
> node tools/probe-antigravity.js
APP_EXISTS=1
C_IS_JUNCTION=1
C_TARGET=D:\Antigravity\app
PENDING_EXISTS=1
PENDING_MB=156
APP_MB=571
```

脚本用 `for /F "tokens=1,2 delims=="` 读这些 KEY=VALUE，顺带避开了所有中文过 cmd 解析器的问题。

> 顺带记一笔：`fsutil reparsepoint query` 其实**能**正确识别（返回 tag `0xa0000003` = Mount Point），但它从 git bash 里调用时会被路径引号搞坏，报 "错误 123: 文件名、目录名或卷标语法不正确"。别用它做判断。
