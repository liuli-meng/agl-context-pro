@echo off
rem ============================================================
rem  Antigravity 上下文用量托盘监控 —— 启动器
rem  双击即可在后台运行（不弹黑框）
rem ============================================================
setlocal
set "HERE=%~dp0"
set "PYW=C:\Users\灵梦\.workbuddy\binaries\python\envs\default\Scripts\pythonw.exe"

if not exist "%PYW%" (
    echo [错误] 找不到 Python 解释器：
    echo        %PYW%
    echo        请修改本文件中的 PYW 变量指向正确的 pythonw.exe
    pause
    exit /b 1
)
if not exist "%HERE%tray.py" (
    echo [错误] 找不到 tray.py，请确认目录完整。
    pause
    exit /b 1
)

rem start 启动独立进程，pythonw 不弹控制台窗口
start "" "%PYW%" "%HERE%tray.py"
echo.
echo  已启动，托盘图标在任务栏右下角（若没看到请点 ^^ 箭头展开）。
echo  本窗口 3 秒后自动关闭...
timeout /t 3 > nul
exit /b 0
