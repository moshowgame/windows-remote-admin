@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Windows Remote Admin - Service

rem ---- 带参数时直接透传给 service.ps1 ----
if not "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" %*
  goto :eof
)

rem ---- 无参数：交互菜单（双击运行） ----
:menu
cls
echo ==================================================
echo    Windows Remote Admin - NSSM 服务管理
echo ==================================================
echo    1. 安装服务  （开机自启 + 崩溃自动重启，需管理员）
echo    2. 卸载服务  （需管理员）
echo    3. 启动服务
echo    4. 停止服务
echo    5. 重启服务
echo    6. 查看服务状态
echo    0. 退出
echo ==================================================
set "choice="
set /p choice=请选择:
if "%choice%"=="0" goto :eof
if "%choice%"=="1" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" install
if "%choice%"=="2" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" uninstall
if "%choice%"=="3" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" start
if "%choice%"=="4" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" stop
if "%choice%"=="5" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" restart
if "%choice%"=="6" powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\service.ps1" status
echo.
pause
goto :menu
