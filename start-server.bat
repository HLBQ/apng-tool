@echo off
chcp 65001 >nul
title APNG 伪装图工坊 - 本地服务
cd /d "%~dp0"

echo ============================================================
echo  APNG 伪装图工坊
echo  正在启动本地静态服务（ES Module 需要通过 http 协议访问）
echo  启动后请在浏览器打开： http://localhost:8080
echo  按 Ctrl+C 可停止服务
echo ============================================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8080
    python -m http.server 8080
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8080
    py -m http.server 8080
    goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
    echo 未检测到 Python，改用 Node 的 http 服务（需要 npx）。
    start "" http://localhost:8080
    npx --yes http-server . -p 8080 -c-1
    goto :eof
)

echo 未检测到 Python 或 Node，无法自动启动服务。
echo 请安装 Python 后重新运行本脚本，或直接用 VS Code 的 Live Server 打开 index.html。
pause
