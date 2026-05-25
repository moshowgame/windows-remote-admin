@echo off
chcp 65001 >nul
echo ========================================================
echo   Windows Remote Admin (Go Edition) - Package Script
echo ========================================================
echo.

REM Check if binary exists
if not exist "windows-remote-admin.exe" (
    echo [ERROR] windows-remote-admin.exe not found. Run @Build.cmd first.
    pause
    exit /b 1
)

REM Create package directory
set PKG_DIR=WindowsRemoteAdmin-Go
if exist "%PKG_DIR%" rd /s /q "%PKG_DIR%"
mkdir "%PKG_DIR%"
mkdir "%PKG_DIR%\web"
mkdir "%PKG_DIR%\web\templates"
mkdir "%PKG_DIR%\data"

REM Copy binary
echo [INFO] Copying binary...
copy /Y windows-remote-admin.exe "%PKG_DIR%\" >nul

REM Copy web templates
echo [INFO] Copying web templates...
xcopy /E /I /Y web\templates "%PKG_DIR%\web\templates" >nul

REM Copy static assets
echo [INFO] Copying static assets...
xcopy /E /I /Y web\static "%PKG_DIR%\web\static" >nul

REM Copy data
echo [INFO] Copying data...
copy /Y data\entitlement.csv "%PKG_DIR%\data\" >nul 2>&1

REM Copy run script
echo [INFO] Copying run script...
copy /Y @Run.cmd "%PKG_DIR%\" >nul

REM Create zip
echo [INFO] Creating ZIP archive...
powershell -command "Compress-Archive -Path '%PKG_DIR%\*' -DestinationPath '%PKG_DIR%.zip' -Force"

echo.
echo [SUCCESS] Package created: %PKG_DIR%.zip
echo.
echo Distribution contents:
echo   - windows-remote-admin.exe  (Go binary)
echo   - web\templates\            (HTML templates)
echo   - web\static\               (CSS, JS, fonts)
echo   - data\entitlement.csv      (User credentials)
echo   - @Run.cmd                  (Run script)
echo.
pause
