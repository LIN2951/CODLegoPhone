@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PORT=1030"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    pause
    exit /b 1
)

echo [START] launching server on port %PORT% ...

REM MiniMax API 若在默认国际站失败，可尝试大陆线路（取消下一行 rem）:
REM set "MINIMAX_API_BASE=https://api.minimaxi.chat"

REM MiniMax 若仅 URL 带 GroupId 仍报错，可取消下一行 rem（在 body 中附加 extra.group_id）:
REM set "MINIMAX_INCLUDE_EXTRA_GROUP=1"

REM Verify that the port belongs to this project before restarting it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1" -Port %PORT%
pause
