@echo off
chcp 65001 >nul
title Code Review Backend

:: 杀掉占用 8000 端口的进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo Stopping PID %%a ...
    taskkill /PID %%a /F /T >nul 2>&1
)

timeout /t 2 /nobreak >nul

cd /d "%~dp0backend"
echo Starting backend at http://127.0.0.1:8000 ...
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
