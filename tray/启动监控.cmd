@echo off
rem ============================================================
rem  Antigravity 上下文用量托盘监控 —— 启动器
rem  双击即可在后台运行（不弹黑框）
rem  注意：用系统 Python 3.12（带 tkinter），别换 venv 版
rem ============================================================
setlocal
set "HERE=%~dp0"
set "PYW=C:\Program Files\Python312\pythonw.exe"

if not exist "%PYW%" (
    echo [错误] 找不到 Python 解释器：
    echo        %PYW%
    echo        本程序需要带 tkinter 的 Python（系统 Python 3.12）
    pause
    exit /b 1
)
if not exist "%HERE%tray.py" (
    echo [错误] 找不到 tray.py，请确认目录完整。
    pause
    exit /b 1
)

start "" "%PYW%" "%HERE%tray.py"
echo.
echo  已启动，托盘图标在任务栏右下角（若没看到请点 ^^ 箭头展开）。
echo  本窗口 3 秒后自动关闭...
timeout /t 3 > nul
exit /b 0
