@echo off
rem 移除 Antigravity 上下文用量面板（保留汉化补丁）
setlocal
set "NODE=C:\Users\灵梦\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0inject.js" uninstall
echo.
pause
