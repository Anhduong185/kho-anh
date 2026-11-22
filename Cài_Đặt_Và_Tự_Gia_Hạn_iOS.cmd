@echo off
chcp 65001 >nul
title Kho Anh - Bo Cong Cu Cai Dat va Tu Dong Gia Han iOS (.IPA)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0infrastructure\ios\KhoAnh-iOS-Toolkit.ps1"
pause
