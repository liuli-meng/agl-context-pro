@echo off
REM ============================================================
REM  Antigravity update helper (junction -> real dir -> junction)
REM
REM  WHY: Antigravity lives at D:\Antigravity\app, with a C: junction
REM  pointing at it. The NSIS uninstaller does NOT follow junctions,
REM  so it fails with "Failed to uninstall old application files"
REM  and the update never completes.
REM
REM  HOW: temporarily "restore" the install to a real C: directory so
REM  NSIS can uninstall/install normally, then move it back to D: and
REM  rebuild the junction, then re-apply our patches.
REM
REM  NOTE: this file is intentionally ASCII-only and CRLF. Chinese
REM  text in a .cmd breaks under the GBK/UTF-8 + cmd parser combo.
REM  Full Chinese guide: see update-antigravity.md
REM
REM  USAGE:
REM    update-antigravity.cmd            interactive update
REM    update-antigravity.cmd --check    inspect state only, no changes
REM ============================================================
setlocal EnableDelayedExpansion

set "SRC_BASE=D:\Antigravity"
set "APP_DIR=%SRC_BASE%\app"
set "C_LINK=%LOCALAPPDATA%\Programs\antigravity"
set "BACKUP_DIR=%SRC_BASE%\backup"
set "FLAG=%BACKUP_DIR%\_update_in_progress.flag"
set "PENDING=%LOCALAPPDATA%\antigravity-updater\pending\Antigravity-x64.exe"
set "AGL_DIR=E:\AGL Context Pro"
set "PROBE=%AGL_DIR%\tools\probe-antigravity.js"
set "STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%-%TIME:~0,2%%TIME:~3,2%"
set "STAMP=%STAMP: =0%"
set "BACKUP_THIS=%BACKUP_DIR%\app-%STAMP%"

echo ============================================================
echo   Antigravity update helper
echo ============================================================
echo.

REM ---------- 0. state check ----------
echo [0/7] Checking current state...

REM  NOTE: `dir /AL` CANNOT see the junction here. cmd.exe runs under a
REM  non-UTF8 codepage and fails to resolve the Chinese profile path, so it
REM  reports "file not found" for a link that does exist. We therefore ask
REM  Node (which handles the path correctly) and parse KEY=VALUE output.
if not exist "%PROBE%" (
  echo   [X] Missing probe helper: %PROBE%
  goto :fail
)

for /F "usebackq tokens=1,2 delims==" %%A in (`node "%PROBE%" "%SRC_BASE%"`) do (
  set "P_%%A=%%B"
)

if not "!P_APP_EXISTS!"=="1" (
  echo   [X] Not found: !P_APP_DIR!\Antigravity.exe
  echo       Expected Antigravity installed at D:\Antigravity\app
  goto :fail
)
echo   [OK] D: target exists: !P_APP_DIR!

if "!P_C_IS_JUNCTION!"=="1" (
  echo   [i] C: path IS a junction -^> !P_C_TARGET!
  set "HAS_LINK=1"
) else (
  echo   [!] C: path is NOT a junction
  if "!P_C_EXISTS!"=="1" (
    echo       C: holds a REAL directory. This script expects a junction;
    echo       refusing to touch it. Rebuild the junction manually first.
    goto :fail
  )
  set "HAS_LINK=0"
)

echo   [i] C: path      : !P_C_LINK!
echo   [i] App size     : !P_APP_MB! MB
if "!P_PENDING_EXISTS!"=="1" (
  echo   [i] Pending pkg  : FOUND ^(!P_PENDING_MB! MB^)
) else (
  echo   [i] Pending pkg  : MISSING
)

if /I "%1"=="--check" (
  echo.
  echo   Check complete. No changes were made.
  goto :done
)

REM ---------- 1. make sure Antigravity is closed ----------
echo.
echo [1/7] Checking whether Antigravity is running...
tasklist /FI "IMAGENAME eq Antigravity.exe" 2>nul | find /I "Antigravity.exe" >nul
if not errorlevel 1 (
  echo   [!] Antigravity is running and must be closed first.
  choice /C YN /M "     Close it now"
  if errorlevel 2 goto :abort
  taskkill /F /IM Antigravity.exe >nul 2>&1
  taskkill /F /IM language_server.exe >nul 2>&1
  timeout /t 2 >nul
  echo   [OK] Closed
) else (
  echo   [OK] Not running
)

if exist "%FLAG%" (
  echo.
  echo   [!] A previous run did not finish (found _update_in_progress.flag)
  echo       Backup dir: %BACKUP_DIR%
  echo       Restore manually, or delete that flag and retry.
  goto :abort
)

REM ---------- 2. backup ----------
echo.
echo [2/7] Backing up to %BACKUP_THIS% ...
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%" >nul 2>&1
robocopy "%APP_DIR%" "%BACKUP_THIS%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo   [X] Backup failed (robocopy rc=%ERRORLEVEL%)
  goto :fail
)
echo   [OK] Backup done
echo in-progress > "%FLAG%"

REM ---------- 3. drop junction, move real dir back to C: ----------
echo.
echo [3/7] Restoring the install to a real C: directory...

if "%HAS_LINK%"=="1" (
  rmdir "%C_LINK%" 2>nul
  if exist "%C_LINK%" (
    echo   [X] Could not remove the junction (file handle in use?)
    goto :restore_lock
  )
  echo   [OK] Junction removed
)

if not exist "%C_LINK%" mkdir "%C_LINK%" >nul 2>&1

echo   Moving ~572MB (about 1-2 min)...
robocopy "%APP_DIR%" "%C_LINK%" /MOVE /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo   [X] Move failed (robocopy rc=%ERRORLEVEL%)
  goto :restore_lock
)
echo   [OK] Restored to %C_LINK%

REM ---------- 4. run the official installer ----------
echo.
echo [4/7] Running the official installer...

if not exist "!P_PENDING!" (
  echo   [!] Pending package not found
  echo       Trigger a download inside Antigravity, or point at one manually.
  echo       Download page: https://antigravity.google/download
  set /p "PENDING=     Full path to installer: "
  if not exist "!PENDING!" (
    echo   [X] Path does not exist
    goto :restore_lock
  )
)

echo   Package: !PENDING!
echo   (An installer window may appear - complete it as prompted)
echo.
start /wait "" "!PENDING!"
echo   [Installer exited, rc=!ERRORLEVEL!]
echo.
echo   [i] If it succeeded, %C_LINK% now holds the new version.
pause

REM ---------- 5. verify ----------
echo.
echo [5/7] Verifying the install...
if not exist "%C_LINK%\Antigravity.exe" (
  echo   [X] %C_LINK%\Antigravity.exe missing - install probably failed
  echo       Site preserved; restore from %BACKUP_THIS% if needed.
  goto :restore_lock
)
echo   [OK] New version is in place

REM ---------- 6. move back to D: and rebuild the junction ----------
echo.
echo [6/7] Moving back to D: and rebuilding the junction...

if exist "%APP_DIR%" (
  echo   D: target already exists, renaming to app_old_%STAMP%
  move "%APP_DIR%" "%SRC_BASE%\app_old_%STAMP%" >nul 2>&1
)

robocopy "%C_LINK%" "%APP_DIR%" /MOVE /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo   [X] Move back to D: failed
  goto :restore_lock
)
echo   [OK] Moved back to %APP_DIR%

REM Junction rebuild. `mklink /J` is a cmd builtin and handles non-ASCII
REM paths correctly - verified against this machine's Chinese-named profile.
REM Preferred over PowerShell New-Item (which also works, but via -Command
REM the path has to survive another encoding hop).
set "MKOK=0"
mklink /J "%C_LINK%" "%APP_DIR%" >nul 2>&1
if not errorlevel 1 set "MKOK=1"

if "!MKOK!"=="0" (
  echo   [!] mklink failed, falling back to PowerShell...
  powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Junction -Path '%C_LINK%' -Target '%APP_DIR%' -Force | Out-Null" >nul 2>&1
  if not errorlevel 1 set "MKOK=1"
)

if "!MKOK!"=="0" (
  echo   [X] Failed to create the junction
  goto :restore_lock
)
echo   [OK] Junction rebuilt: %C_LINK% -^> %APP_DIR%

REM Verify with the Node probe - `dir /AL` cannot be trusted here (see docs).
for /F "usebackq tokens=1,2 delims==" %%A in (`node "%PROBE%" "%SRC_BASE%"`) do (
  set "V_%%A=%%B"
)
if not "!V_C_IS_JUNCTION!"=="1" (
  echo   [X] Verification failed: %C_LINK% is not a working junction
  goto :restore_lock
)
echo   [OK] Verified: realpath = !V_C_TARGET!

del "%FLAG%" >nul 2>&1

REM ---------- 7. re-apply patches ----------
echo.
echo [7/7] Re-injecting the AGL panel...
if exist "%AGL_DIR%\desktop-inject\inject.js" (
  pushd "%AGL_DIR%"
  node desktop-inject\inject.js install
  popd
  echo   [OK] Panel re-injected
) else (
  echo   [!] Not found: %AGL_DIR%\desktop-inject\inject.js - skipped
)

echo.
echo   [!] The Antigravity-CN translation patch is also wiped by updates.
echo       Re-run its patcher manually if you want it back.

echo.
echo ============================================================
echo   Done.
echo   Backup kept at: %BACKUP_THIS%
echo   Delete it once the new version runs fine.
echo ============================================================
echo.
pause
goto :done

REM ---------- error paths ----------
:abort
echo.
echo Aborted. No changes were made.
pause
goto :eof

:restore_lock
echo.
echo ************************************************************
echo  The flow stopped early; the site has been preserved.
echo.
echo  Manual recovery:
echo    1. Remove the C: directory (if not a junction):
echo         rmdir /S /Q "%C_LINK%"
echo    2. Move the backup back to D::
echo         robocopy "%BACKUP_THIS%" "%APP_DIR%" /E /MOVE
echo    3. Rebuild the junction (PowerShell):
echo         New-Item -ItemType Junction -Path "%C_LINK%" -Target "%APP_DIR%"
echo    4. Delete the flag:
echo         del "%FLAG%"
echo ************************************************************
pause
goto :eof

:fail
echo.
echo Failed. No changes were made.
pause
goto :eof

:done
endlocal
