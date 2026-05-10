@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions EnableDelayedExpansion

echo.
echo  Stopping NanoClaw...
echo.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "WEB_PORT="

if exist "%SCRIPT_DIR%\nanoclaw.port" (
    set /p WEB_PORT=<"%SCRIPT_DIR%\nanoclaw.port"
    set "WEB_PORT=%WEB_PORT: =%"
)
if not defined WEB_PORT if exist "%SCRIPT_DIR%\.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%SCRIPT_DIR%\.env") do (
        if /I "%%~A"=="WEB_PORT" (
            set "WEB_PORT=%%~B"
            set "WEB_PORT=!WEB_PORT: =!"
        )
    )
)
if not defined WEB_PORT set "WEB_PORT=3377"

call :killPidFile ".nanoclaw-pid"
call :killPidFile "nanoclaw.pid"
call :killPort "%WEB_PORT%"
if exist "%SCRIPT_DIR%\nanoclaw.port" del /q "%SCRIPT_DIR%\nanoclaw.port" >nul 2>&1

echo.
echo  NanoClaw stopped.
echo.
exit /b 0

:killPidFile
set "PID_FILE=%SCRIPT_DIR%\%~1"
if not exist "%PID_FILE%" exit /b 0

set "TARGET_PID="
set /p TARGET_PID=<"%PID_FILE%"
set "TARGET_PID=%TARGET_PID: =%"
if defined TARGET_PID (
    taskkill /PID %TARGET_PID% /F >nul 2>&1
)
del /q "%PID_FILE%" >nul 2>&1
exit /b 0

:killPort
set "TARGET_PORT=%~1"
if not defined TARGET_PORT exit /b 0

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":%TARGET_PORT% .*LISTENING"') do (
    taskkill /PID %%P /F >nul 2>&1
)
exit /b 0
