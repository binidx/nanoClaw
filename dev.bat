@echo off
chcp 65001 >nul
title NanoClaw Dev

cd /d "%~dp0"

echo.
echo  ================================
echo   NanoClaw - Dev Mode
echo  ================================
echo   Backend: tsx (auto-reload)
echo   Frontend: http://localhost:5173
echo  ================================
echo.

:: Start frontend dev server in background
if exist "web\package.json" (
    if not exist "web\node_modules" (
        echo  Installing frontend dependencies...
        cd web
        call npm install >nul 2>&1
        cd ..
    )
    echo  Starting frontend dev server...
    start "NanoClaw-Web" cmd /c "cd web && npm run dev"
    echo  Frontend: http://localhost:5173
    echo.
)

:: Start backend with tsx (live reload) and system CA
echo  Starting backend (tsx)...
echo  Press Ctrl+C to stop.
echo.
set NODE_TLS_REJECT_UNAUTHORIZED=0
npx tsx --use-system-ca src/index.ts
