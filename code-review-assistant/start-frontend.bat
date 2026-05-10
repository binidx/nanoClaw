@echo off
chcp 65001 >nul
title Code Review Frontend

:: 杀掉占用 5173 端口的进程（Vite 默认端口）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo Stopping PID %%a ...
    taskkill /PID %%a /F /T >nul 2>&1
)

timeout /t 1 /nobreak >nul

cd /d "%~dp0frontend"
if not exist package.json (
    echo [ERROR] frontend\package.json not found.
    pause
    exit /b 1
)

echo Starting frontend at http://127.0.0.1:5173 ...
npm run dev
pause
