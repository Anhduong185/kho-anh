param(
  [ValidateSet("Menu", "InstallIPA", "EnableAutoRenew", "WatchdogTick", "UpdateIPA", "Doctor")]
  [string]$Action = "Menu"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$IpaPath = Join-Path $RootDir "releases\vault-photos-v1.0.2-ios-unsigned.ipa"
$SideloadlyDir = Join-Path $env:LOCALAPPDATA "Sideloadly"
$SideloadlyExe = Join-Path $SideloadlyDir "sideloadly.exe"
$SideloadlyDaemon = Join-Path $SideloadlyDir "SideloadlyDaemon.exe"
$AltServerExe = "${env:ProgramFiles(x86)}\AltServer\AltServer.exe"
if (-not (Test-Path $AltServerExe)) {
  $AltServerExe = "$env:ProgramFiles\AltServer\AltServer.exe"
}
$ReleaseIpaUrl = "https://github.com/Anhduong185/kho-anh/releases/download/v1.0.2/vault-photos-v1.0.2-ios-unsigned.ipa"
$AltStoreSourceUrl = "https://raw.githubusercontent.com/Anhduong185/kho-anh/main/infrastructure/sidestore/source.json"
$TaskName = "KhoAnh-iOS-AutoRenew"

function Ensure-AppleMobileDeviceService {
  $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    Write-Host "[!] Chưa tìm thấy 'Apple Mobile Device Service' (iTunes/Apple Devices bản EXE ngoài Microsoft Store)." -ForegroundColor Yellow
    return $false
  }
  if ($svc.Status -ne "Running") {
    Write-Host "[*] Đang khởi động dịch vụ Apple Mobile Device Service..." -ForegroundColor Cyan
    Start-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
  if ($svc.Status -eq "Running") {
    Write-Host "[OK] Apple Mobile Device Service đang chạy (hỗ trợ đồng bộ iPhone qua cáp & Wi-Fi)." -ForegroundColor Green
    return $true
  }
  return $false
}

function Ensure-SideloadlyInstalled {
  if (Test-Path $SideloadlyExe) {
    Write-Host "[OK] Đã tìm thấy Sideloadly tại: $SideloadlyExe" -ForegroundColor Green
    return $true
  }

  Write-Host "[*] Máy chưa có Sideloadly. Đang tải bộ cài Sideloadly 64-bit chính thức..." -ForegroundColor Cyan
  $InstallerPath = Join-Path $env:TEMP "sideloadlysetup64.exe"
  try {
    Invoke-WebRequest -Uri "https://sideloadly.io/sideloadlysetup64.exe" -OutFile $InstallerPath -UseBasicParsing
    Write-Host "[*] Đang chạy cài đặt Sideloadly..." -ForegroundColor Cyan
    Start-Process -FilePath $InstallerPath -Wait
  } catch {
    Write-Host "[!] Không tải tự động được Sideloadly: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    Bạn có thể tải thủ công tại: https://sideloadly.io" -ForegroundColor Yellow
    return $false
  }

  if (Test-Path $SideloadlyExe) {
    Write-Host "[OK] Đã cài đặt Sideloadly thành công!" -ForegroundColor Green
    return $true
  }
  return $false
}

function Start-AutoRenewDaemons {
  Ensure-AppleMobileDeviceService | Out-Null

  if (Test-Path $SideloadlyDaemon) {
    $proc = Get-Process -Name "SideloadlyDaemon" -ErrorAction SilentlyContinue
    if (-not $proc) {
      Write-Host "[*] Đang khởi động ngầm Sideloadly Wi-Fi Auto-Refresh Daemon..." -ForegroundColor Cyan
      Start-Process -FilePath $SideloadlyDaemon -WindowStyle Minimized
    } else {
      Write-Host "[OK] SideloadlyDaemon đang chạy ngầm (Tự động gia hạn iPhone qua Wi-Fi)." -ForegroundColor Green
    }
  }

  if (Test-Path $AltServerExe) {
    $altProc = Get-Process -Name "AltServer" -ErrorAction SilentlyContinue
    if (-not $altProc) {
      Write-Host "[*] Đang khởi động ngầm AltServer Wi-Fi Daemon..." -ForegroundColor Cyan
      Start-Process -FilePath $AltServerExe -WindowStyle Minimized
    } else {
      Write-Host "[OK] AltServer đang chạy ngầm." -ForegroundColor Green
    }
  }
}

function Install-IpaToIphone {
  Write-Host "`n================ CÀI ĐẶT KHO ẢNH (.IPA) & BẬT GIA HẠN WI-FI ================" -ForegroundColor Cyan
  Ensure-AppleMobileDeviceService | Out-Null

  if (-not (Test-Path $IpaPath)) {
    Write-Host "[*] Chưa thấy file .ipa cục bộ, đang tải từ GitHub Release..." -ForegroundColor Yellow
    Update-LatestIpa
  }

  if (-not (Ensure-SideloadlyInstalled)) {
    return
  }

  Start-AutoRenewDaemons

  Write-Host "`n[*] Đang mở Sideloadly nạp sẵn file: $IpaPath" -ForegroundColor Green
  Write-Host "HƯỚNG DẪN CÀI LẦN ĐẦU (CHỈ CẦN CẮM CÁP 1 LẦN DUY NHẤT):" -ForegroundColor Yellow
  Write-Host "  1. Cắm cáp iPhone vào máy tính (bấm 'Tin cậy / Trust' trên iPhone nếu được hỏi)."
  Write-Host "  2. Trong cửa sổ Sideloadly vừa mở: nhập Apple ID (tài khoản phụ hoặc chính đều được)."
  Write-Host "  3. Đảm bảo ô 'Automatic Refresh' (biểu tượng Wi-Fi) được BẬT."
  Write-Host "  4. Bấm 'Start' -> Đợi ~30 giây app 'Kho Ảnh' sẽ xuất hiện trên màn hình iPhone!"
  Write-Host "  5. Trên iPhone: vào Cài đặt -> Cài đặt chung -> Quản lý VPN & Thiết bị -> Tin cậy Apple ID của bạn (và bật Developer Mode nếu iOS 16+)."
  Write-Host "  -> Từ lần sau, mỗi khi máy tính và iPhone cùng bắt 1 mạng Wi-Fi, Sideloadly Daemon sẽ TỰ ĐỘNG GIA HẠN 7 ngày mà không cần cắm cáp!" -ForegroundColor Green

  Start-Process -FilePath $SideloadlyExe -ArgumentList "`"$IpaPath`""
}

function Enable-WindowsAutoRenewTask {
  Write-Host "`n================ CÀI Tác Vụ Tự Động Gia Hạn Ngầm (Windows Task Scheduler) ================" -ForegroundColor Cyan
  $ScriptFullPath = $MyInvocation.MyCommand.Definition
  if (-not $ScriptFullPath) {
    $ScriptFullPath = Join-Path $RootDir "infrastructure\ios\KhoAnh-iOS-Toolkit.ps1"
  }

  $ArgStr = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptFullPath`" -Action WatchdogTick"

  # 1. Tạo Shortcut trong Startup folder của User (luôn chạy khi mở máy, không cần quyền Admin)
  $StartupDir = [Environment]::GetFolderPath("Startup")
  $CmdStartup = Join-Path $StartupDir "KhoAnh-iOS-AutoRenew.cmd"
  "@echo off`r`npowershell.exe $ArgStr" | Set-Content -Path $CmdStartup -Encoding ASCII
  Write-Host "[OK] Đã kích hoạt khởi động cùng Windows tại: $CmdStartup" -ForegroundColor Green

  # 2. Tạo Scheduled Task chạy định kỳ mỗi 6 tiếng để tự bật lại Apple Mobile Device + SideloadlyDaemon nếu bị tắt
  try {
    & schtasks.exe /Create /TN $TaskName /TR "powershell.exe $ArgStr" /SC HOURLY /MO 6 /F | Out-Null
    Write-Host "[OK] Đã tạo lịch tự động kiểm tra & gia hạn mỗi 6 tiếng ($TaskName)." -ForegroundColor Green
  } catch {
    Write-Host "[!] Không tạo được schtasks (đã có Startup script thay thế)." -ForegroundColor Yellow
  }

  Start-AutoRenewDaemons
  Write-Host "`n[HOÀN TẤT] Từ giờ mỗi khi bạn mở máy tính (và mỗi 6 tiếng), hệ thống sẽ tự động giữ dịch vụ Apple Wi-Fi Sync & Sideloadly Daemon chạy ngầm để gia hạn app Kho Ảnh trên iPhone!" -ForegroundColor Green
}

function Update-LatestIpa {
  Write-Host "`n[*] Đang tải bản Kho Ảnh iOS (.ipa) mới nhất từ GitHub..." -ForegroundColor Cyan
  $ReleasesDir = Join-Path $RootDir "releases"
  if (-not (Test-Path $ReleasesDir)) {
    New-Item -ItemType Directory -Path $ReleasesDir | Out-Null
  }
  try {
    Invoke-WebRequest -Uri $ReleaseIpaUrl -OutFile $IpaPath -UseBasicParsing
    $sizeKb = [Math]::Round((Get-Item $IpaPath).Length / 1KB, 1)
    Write-Host "[OK] Đã cập nhật thành công: $IpaPath ($sizeKb KB)" -ForegroundColor Green
  } catch {
    Write-Host "[!] Không tải được từ Release URL ($($_.Exception.Message)). Giữ nguyên file cục bộ hiện tại." -ForegroundColor Yellow
  }
}

function Show-Doctor {
  Write-Host "`n================ KIỂM TRA HỆ THỐNG CÀI & GIA HẠN IOS ================" -ForegroundColor Cyan
  Ensure-AppleMobileDeviceService | Out-Null
  Write-Host ("- File .IPA cục bộ       : " + ($(if (Test-Path $IpaPath) { "CÓ ($IpaPath)" } else { "CHƯA CÓ" })))
  Write-Host ("- Sideloadly             : " + ($(if (Test-Path $SideloadlyExe) { "ĐÃ CÀI ($SideloadlyExe)" } else { "CHƯA CÀI (Chọn phím 1 để tự tải & cài)" })))
  $daemonRunning = $null -ne (Get-Process -Name "SideloadlyDaemon" -ErrorAction SilentlyContinue)
  Write-Host ("- Sideloadly Wi-Fi Daemon: " + ($(if ($daemonRunning) { "ĐANG CHẠY NGẦM (Tự động gia hạn BẬT)" } else { "ĐANG TẮT" })))
  $startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "KhoAnh-iOS-AutoRenew.cmd"
  Write-Host ("- Tự khởi động cùng Win  : " + ($(if (Test-Path $startupCmd) { "ĐÃ BẬT" } else { "CHƯA BẬT (Chọn phím 2 để bật)" })))
  Write-Host "`n================ LINK NGUỒN TỰ ĐỘNG CHO ALTSTORE / SIDESTORE / FEATHER ================" -ForegroundColor Cyan
  Write-Host "  - Link Source JSON (Tự cập nhật & gia hạn): $AltStoreSourceUrl" -ForegroundColor Green
  Write-Host "  - Link tải trực tiếp file .IPA            : $ReleaseIpaUrl" -ForegroundColor Green
}

if ($Action -eq "WatchdogTick") {
  Start-AutoRenewDaemons
  exit 0
}
if ($Action -eq "InstallIPA") {
  Install-IpaToIphone
  exit 0
}
if ($Action -eq "EnableAutoRenew") {
  Enable-WindowsAutoRenewTask
  exit 0
}
if ($Action -eq "UpdateIPA") {
  Update-LatestIpa
  exit 0
}
if ($Action -eq "Doctor") {
  Show-Doctor
  exit 0
}

while ($true) {
  Write-Host "`n======================================================================" -ForegroundColor Cyan
  Write-Host "   BỘ CÔNG CỤ CÀI ĐẶT & TỰ ĐỘNG GIA HẠN KHO ẢNH CHO IPHONE (.IPA)   " -ForegroundColor White
  Write-Host "======================================================================" -ForegroundColor Cyan
  Write-Host "  [1] Cài đặt Kho Ảnh (.ipa) vào iPhone & bật Wi-Fi Auto-Refresh (Sideloadly)"
  Write-Host "  [2] Bật Tự Động Gia Hạn Ngầm trên Windows (Tự chạy mỗi khi bật máy & mỗi 6h)"
  Write-Host "  [3] Kiểm tra trạng thái dịch vụ Apple Wi-Fi Sync & xem link AltStore/Feather Source"
  Write-Host "  [4] Tải/Cập nhật file .ipa mới nhất từ GitHub về máy"
  Write-Host "  [0] Thoát"
  Write-Host "----------------------------------------------------------------------"
  $choice = Read-Host "Chọn chức năng (0-4)"
  switch ($choice) {
    "1" { Install-IpaToIphone }
    "2" { Enable-WindowsAutoRenewTask }
    "3" { Show-Doctor }
    "4" { Update-LatestIpa }
    "0" { exit 0 }
    default { Write-Host "Vui lòng chọn từ 0 đến 4." -ForegroundColor Yellow }
  }
}
