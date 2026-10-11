@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Windows Remote Admin

echo [WRA] 正在启动 Windows Remote Admin ...

rem ---- 1. Node.js 检测（版本需 >= 18）----
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  goto :fail
)
set NODE_MAJOR=
for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
if not defined NODE_MAJOR (
  echo [错误] 无法识别 Node.js 版本，请重新安装 Node.js。
  goto :fail
)
if %NODE_MAJOR% LSS 18 (
  echo [错误] Node.js 版本过低（检测到 v%NODE_MAJOR%），需要 18 及以上版本。
  goto :fail
)

rem ---- 2. 依赖缺失时自动安装 ----
if not exist "node_modules\fastify" (
  echo [WRA] 首次运行，正在安装依赖（视网络约 1-2 分钟）...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行。
    goto :fail
  )
)

rem ---- 3. 静态资源缺失时自动复制 ----
if not exist "public\css\tabler.min.css" (
  echo [WRA] 检测到静态资源缺失，正在复制 ...
  node scripts\copy-assets.js
  if errorlevel 1 (
    echo [错误] 静态资源复制失败，请重新运行 Build.cmd。
    goto :fail
  )
)

echo [WRA] 服务地址：http://127.0.0.1:12306  （停止服务请按 Ctrl+C）
node server.js %*
goto :eof

:fail
echo.
pause
exit /b 1
