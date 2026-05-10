@echo off
chcp 65001 >nul
title NanoClaw
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo  ================================
echo   NanoClaw - Restarting...
echo  ================================
echo.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo  [0/3] Checking system dependencies...
where rg >nul 2>&1
if errorlevel 1 (
    echo.
    echo   WARNING: ripgrep ^(rg^) is NOT installed.
    echo   Agent grep/glob tools will use a slower Node.js fallback.
    echo   Install: winget install BurntSushi.ripgrep.MSVC
    echo        or: choco install ripgrep
    echo.
)

echo  [1/3] Stopping existing NanoClaw (if running)...
if exist "%SCRIPT_DIR%\stop.bat" (
    call "%SCRIPT_DIR%\stop.bat"
)
echo        Done.
echo.

call node "%SCRIPT_DIR%\scripts\start-runtime.mjs"
exit /b %errorlevel%
