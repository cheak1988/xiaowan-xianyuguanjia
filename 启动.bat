@echo off
title 小丸闲鱼管家 - 启动器

cd /d "%~dp0"

set "PROXY_EXE=dist-ai-proxy\win-unpacked\OpenFish.exe"
set "OPERATIONS_EXE=dist-operations\win-unpacked\OpenFish.exe"
set "SETTINGS_EXE=dist-ai-settings\win-unpacked\OpenFish.exe"
set "AI_EXE=dist-products-ai\win-unpacked\OpenFish.exe"
set "PRODUCTS_EXE=dist-products\win-unpacked\OpenFish.exe"
set "SEMI_EXE=dist-semi\win-unpacked\OpenFish.exe"
set "FIXED_EXE=dist-fixed\win-unpacked\OpenFish.exe"
set "APP_EXE=dist\win-unpacked\小丸闲鱼管家.exe"
set "APP_EXE_OLD=dist\win-unpacked\OpenFish.exe"
set "DEV_ELECTRON=node_modules\electron\dist\electron.exe"

echo.
echo   ==========================================
echo              小丸闲鱼管家
echo   ==========================================
echo.

if exist "%PROXY_EXE%" (
    start "" "%PROXY_EXE%"
    exit /b 0
)

if exist "%OPERATIONS_EXE%" (
    start "" "%OPERATIONS_EXE%"
    exit /b 0
)

if exist "%SETTINGS_EXE%" (
    start "" "%SETTINGS_EXE%"
    exit /b 0
)

if exist "%AI_EXE%" (
    start "" "%AI_EXE%"
    exit /b 0
)

if exist "%PRODUCTS_EXE%" (
    start "" "%PRODUCTS_EXE%"
    exit /b 0
)

if exist "%SEMI_EXE%" (
    start "" "%SEMI_EXE%"
    exit /b 0
)

if exist "%FIXED_EXE%" (
    start "" "%FIXED_EXE%"
    exit /b 0
)

if exist "%APP_EXE%" (
    echo   [启动] 打包版
    start "" "%APP_EXE%"
    exit /b 0
)

if exist "%APP_EXE_OLD%" (
    echo   [启动] 打包版
    start "" "%APP_EXE_OLD%"
    exit /b 0
)

if exist "%DEV_ELECTRON%" (
    echo   [启动] 开发模式
    echo          源码目录: %cd%
    echo.
    start "" "%DEV_ELECTRON%" .
    exit /b 0
)

echo   [!] 找不到程序文件
echo.
echo   请先在本目录执行:
echo.
echo       npm install
echo       npm run dist
echo.
echo   或者只安装依赖用开发模式:
echo.
echo       npm install
echo       npm start
echo.
pause
exit /b 1
