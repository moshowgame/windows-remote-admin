@echo off
chcp 65001 >nul
title Windows Remote Admin (Go Edition)

echo ========================================================
echo   Windows Remote Admin (Go Edition)
echo   Portable Windows Management Tool
echo ========================================================
echo.
echo   Access: http://localhost:12306/
echo   Default: admin / admin123
echo   Press Ctrl+C to stop
echo ========================================================
echo.

REM Ensure web and data directories exist
if not exist "web\templates" (
    echo [ERROR] web\templates directory not found!
    pause
    exit /b 1
)

if not exist "data" (
    echo [WARNING] data directory not found, creating...
    mkdir data
    echo username,password > data\entitlement.csv
    echo admin,admin123 >> data\entitlement.csv
    echo [INFO] Default user created: admin / admin123
)

REM Run the server
windows-remote-admin.exe

pause
