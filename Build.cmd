@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Windows Remote Admin - Build

echo [WRA] 构建 / 校验 Windows Remote Admin ...

rem ---- 1. Node.js 检测 ----
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
  goto :fail
)

rem ---- 2. 安装/同步依赖（幂等，已安装时速度很快）----
echo [WRA] 正在安装 / 同步依赖 ...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络后重试。
  goto :fail
)

rem ---- 3. 复制静态资源（Tabler / HTMX 图标样式等）----
echo [WRA] 正在复制静态资源 ...
node scripts\copy-assets.js
if errorlevel 1 (
  echo [错误] 静态资源复制失败。
  goto :fail
)

rem ---- 4. 语法检查（src / scripts 下全部 JS + 入口）----
echo [WRA] 正在进行语法检查 ...
set BAD=
for /r src %%f in (*.js) do (
  node --check "%%f" 1>nul 2>&1
  if errorlevel 1 set BAD=%%f
)
for /r scripts %%f in (*.js) do (
  node --check "%%f" 1>nul 2>&1
  if errorlevel 1 set BAD=%%f
)
node --check server.js 1>nul 2>&1
if errorlevel 1 set BAD=server.js
if defined BAD (
  echo [错误] 语法检查未通过：!BAD!
  goto :fail
)

echo.
echo [WRA] 构建完成，可运行 Run.cmd 启动服务。
endlocal
pause
exit /b 0

:fail
echo.
pause
exit /b 1
