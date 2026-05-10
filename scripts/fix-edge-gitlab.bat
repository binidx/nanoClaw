@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -ExecutionPolicy Bypass -File "%SCRIPT_DIR%fix-edge-gitlab.ps1"
if errorlevel 1 (
  echo.
  echo fix-edge-gitlab failed.
  pause
  exit /b 1
)
echo.
echo fix-edge-gitlab completed.
pause
