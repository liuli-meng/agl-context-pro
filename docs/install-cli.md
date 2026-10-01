# 用命令行给 Antigravity IDE 装 VSIX

Antigravity IDE 内置 `cli.js`，但直接跑 `bin/antigravity` 不一定能装扩展。可用的姿势是让主程序以 Node 模式执行 cli.js：

Windows PowerShell（路径按实际安装位置调整）：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& "D:\Antigravity\IDE\Antigravity IDE.exe" "D:\Antigravity\IDE\resources\app\out\cli.js" `
  --install-extension "D:\path\to\agl-context-pro-0.2.0.vsix" --force
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

装完**重启 IDE** 生效。可在扩展面板（`Ctrl+Shift+X`）搜索 "AGL" 确认已启用。

> 更省事：IDE 内 `Ctrl+Shift+P` → `Extensions: Install from VSIX...`，图形界面选文件即可。

## 验证装好了

状态栏左下出现 `$(dashboard) …` 字样；或命令面板执行 **AGL: 立即刷新上下文用量**，有反应即安装成功。Antigravity 未启动时显示「AGL 未连接」属正常，启动 Antigravity 后 5 秒内自动连接。
