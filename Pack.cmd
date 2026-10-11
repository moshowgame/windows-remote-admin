@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Windows Remote Admin - Pack

echo [WRA] 正在生成分发压缩包（仅代码与页面） ...

rem ---- Node.js 检测 ----
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
  goto :fail
)

node scripts\pack.js
if errorlevel 1 (
  echo [错误] 打包失败，请检查上方错误信息。
  goto :fail
)

echo.
echo [WRA] 打包完成，产物见 dist\ 目录。
pause
exit /b 0

:fail
pause
exit /b 1
