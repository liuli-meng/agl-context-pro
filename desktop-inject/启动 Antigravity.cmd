@echo off
rem ============================================================
rem  Antigravity 启动器（带代理 + 上下文用量面板）
rem  说明：Antigravity 的 language_server 是 Go 程序，只认
rem  HTTP_PROXY/HTTPS_PROXY，不读 Windows 系统代理。
rem  不设这两项，token 校验会卡 30 秒，主窗口白屏退出。
rem ============================================================
setlocal
set "PROXY=http://127.0.0.1:10808"

set "EXE="
if exist "%~dp0..\app\Antigravity.exe" set "EXE=%~dp0..\app\Antigravity.exe"
if not defined EXE if exist "%~dp0app\Antigravity.exe" set "EXE=%~dp0app\Antigravity.exe"
if not defined EXE if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" set "EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
if not defined EXE (
  echo [ERROR] 找不到 Antigravity.exe
  echo   已查找: %~dp0..\app\Antigravity.exe
  echo           %LOCALAPPDATA%\Programs\antigravity\Antigravity.exe
  pause
  exit /b 1
)
echo Using: %EXE%

echo [1/2] 关闭旧实例 ...
taskkill /F /IM Antigravity.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul

echo [2/2] 启动 ...
set "HTTP_PROXY=%PROXY%"
set "HTTPS_PROXY=%PROXY%"
set "ALL_PROXY=%PROXY%"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=localhost,127.0.0.1,::1"
start "" "%EXE%"

echo.
echo Done. 右下角应出现上下文用量胶囊。
endlocal
