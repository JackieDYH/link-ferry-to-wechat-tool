@echo off
rem ============================================================
rem  XHS/Toutiao -> WeChat uploader (Vue3 web + Express server)
rem  Double-click to start. First run installs deps & builds.
rem ============================================================
cd /d "%~dp0"

if not exist "web\node_modules\vite\bin\vite.js" (
    echo [first run] Installing frontend dependencies, please wait...
    pushd web
    call pnpm install
    popd
)

if not exist "web\dist\index.html" (
    echo [first run] Building frontend, please wait...
    pushd web
    call pnpm run build
    popd
)

if not exist "server\node_modules\express" (
    echo [first run] Installing backend dependencies...
    pushd server
    call pnpm install
    popd
)

node server\xhs-web-server.mjs
pause
