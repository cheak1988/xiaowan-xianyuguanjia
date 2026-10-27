@echo off
title 创建桌面快捷方式
cd /d "%~dp0"

echo.
echo   正在创建带图标的桌面快捷方式...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$dir = '%CD%';" ^
  "$exe = Join-Path $dir 'dist-ai-proxy\win-unpacked\OpenFish.exe'; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-operations\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-ai-settings\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-products-ai\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-products\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-semi\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist-fixed\win-unpacked\OpenFish.exe' }; if (!(Test-Path $exe)) { $exe = Join-Path $dir 'dist\win-unpacked\OpenFish.exe' };" ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '小丸闲鱼管家.lnk';" ^
  "$stage = Join-Path $dir '_bench\desktop-launcher.lnk'; [IO.Directory]::CreateDirectory((Split-Path $stage)) | Out-Null; $s = $ws.CreateShortcut($stage);" ^
  "if (Test-Path $exe) { $s.TargetPath = $exe; $s.WorkingDirectory = (Split-Path $exe) } else { $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"' + (Join-Path $dir '启动.vbs') + '\"'; $s.WorkingDirectory = $dir };" ^
  "$s.IconLocation = Join-Path $dir 'build\icon.ico';" ^
  "$s.Description = '小丸闲鱼管家 - 多店铺客服工作台';" ^
  "$s.Save(); Copy-Item -LiteralPath $stage -Destination $lnk -Force;" ^
  "Write-Host '  [完成] 已创建:' $lnk"

echo.
timeout /t 3 >nul
