@echo off
rem ============================================================
rem  开机自启配置（需要带 tkinter 的系统 Python 3.12）
rem ============================================================
setlocal
set "PY=C:\Program Files\Python312\python.exe"

if not exist "%PY%" (
    echo [错误] 找不到 Python 解释器：%PY%
    pause
    exit /b 1
)

echo.
echo   Antigravity 上下文监控 —— 开机自启设置
echo   ----------------------------------------
echo   [1] 启用开机自启
echo   [2] 取消开机自启
echo   [3] 查看当前状态
echo   [0] 退出
echo.
set /p CH=请选择：

if "%CH%"=="1" "%PY%" "%~dp0autostart.py" enable
if "%CH%"=="2" "%PY%" "%~dp0autostart.py" disable
if "%CH%"=="3" "%PY%" "%~dp0autostart.py" status
if "%CH%"=="0" exit /b 0

echo.
pause
