@echo off
chcp 65001 >nul
title Kho Anh - Bo Cong Cu Cai Dat va Tu Dong Gia Han iOS (.IPA)
set "LOCAL_PS1=%~dp0infrastructure\ios\KhoAnh-iOS-Toolkit.ps1"
if exist "%LOCAL_PS1%" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCAL_PS1%"
) else (
  echo [*] Dang chay tren may tinh moi: Tu dong tai KhoAnh-iOS-Toolkit.ps1 tu GitHub...
  curl.exe -sL "https://raw.githubusercontent.com/Anhduong185/kho-anh/main/infrastructure/ios/KhoAnh-iOS-Toolkit.ps1" -o "%~dp0KhoAnh-iOS-Toolkit.ps1"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0KhoAnh-iOS-Toolkit.ps1"
)
pause
