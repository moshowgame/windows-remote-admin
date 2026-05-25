@echo off
chcp 65001 >nul
echo ========================================================
echo   Windows Remote Admin (Go Edition) - Build Script
echo ========================================================
echo.

REM Check if Go is installed
where go >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Go is not installed. Please install Go 1.21+
    pause
    exit /b 1
)

echo [INFO] Go version:
go version
echo.

REM Download dependencies
echo [INFO] Downloading dependencies...
go mod tidy
if %errorlevel% neq 0 (
    echo [ERROR] Failed to download dependencies
    pause
    exit /b 1
)

REM Build
echo [INFO] Building...
go build -ldflags="-s -w" -o windows-remote-admin.exe .
if %errorlevel% neq 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Build completed: windows-remote-admin.exe
echo.
pause
