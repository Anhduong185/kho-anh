param(
  [ValidateSet("Menu", "InstallIPA", "EnableAutoRenew", "WatchdogTick", "UpdateIPA", "Doctor")]
  [string]$Action = "Menu"
)

$ErrorActionPreference = "Continue"

$RootDir = if (Test-Path (Join-Path $PSScriptRoot "..\..\package.json")) {
  Resolve-Path (Join-Path $PSScriptRoot "..\..")
} else {
  $PSScriptRoot
}
$ReleasesDir = Join-Path $RootDir "releases"
if (-not (Test-Path $ReleasesDir)) {
  New-Item -ItemType Directory -Path $ReleasesDir -Force | Out-Null
}
$IpaPath = Join-Path $ReleasesDir "vault-photos-v1.0.2-ios-unsigned.ipa"
$SideloadlyDir = Join-Path $env:LOCALAPPDATA "Sideloadly"
$SideloadlyExe = Join-Path $SideloadlyDir "sideloadly.exe"
$SideloadlyDaemon = Join-Path $SideloadlyDir "SideloadlyDaemon.exe"
$AltServerExe = "${env:ProgramFiles(x86)}\AltServer\AltServer.exe"
if (-not (Test-Path $AltServerExe)) {
  $AltServerExe = "$env:ProgramFiles\AltServer\AltServer.exe"
}
$ItunesUrl = "https://www.apple.com/itunes/download/win64"
$IcloudUrl = "https://updates.cdn-apple.com/2020/windows/001-39935-20200911-1A70AA56-F448-11EA-8CC0-99D41950005E/iCloudSetup.exe"
$ReleaseIpaUrl = "https://github.com/Anhduong185/kho-anh/releases/download/v1.0.2/vault-photos-v1.0.2-ios-unsigned.ipa"
$AltStoreSourceUrl = "https://raw.githubusercontent.com/Anhduong185/kho-anh/main/infrastructure/sidestore/source.json"
$TaskName = "KhoAnh-iOS-AutoRenew"

function Test-AppleICloudInstalled {
  $paths = @(
    "${env:ProgramFiles(x86)}\Common Files\Apple\Internet Services\iCloudServices.exe",
    "$env:ProgramFiles\Common Files\Apple\Internet Services\iCloudServices.exe",
    "${env:ProgramFiles(x86)}\Common Files\Apple\Internet Services\AOSKit.dll",
    "$env:ProgramFiles\Common Files\Apple\Internet Services\AOSKit.dll"
  )
  foreach ($p in $paths) {
    if ($p -and (Test-Path $p)) { return $true }
  }
  return $false
}

function Install-MissingPrerequisites {
  Write-Host "`n================ TU DONG CAI DAT DU CAC THANH PHAN CHO MAY TINH MOI ================" -ForegroundColor Cyan

  # 1. Apple Mobile Device Service (iTunes 64-bit Web Edition)
  $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    Write-Host "[1/4] May chua co Apple Mobile Device Service (Driver iPhone USB + Wi-Fi)." -ForegroundColor Yellow
    $ItunesInstaller = Join-Path $ReleasesDir "iTunes64Setup.exe"
    if (-not (Test-Path $ItunesInstaller)) {
      Write-Host "      Dang tai iTunes 64-bit ban Web chinh thuc tu Apple..." -ForegroundColor Cyan
      & curl.exe -L $ItunesUrl -o $ItunesInstaller
    }
    if (Test-Path $ItunesInstaller) {
      Write-Host "      Dang mo trinh cai dat iTunes 64-bit (Vui long bam Next -> Install)..." -ForegroundColor Cyan
      Start-Process -FilePath $ItunesInstaller -Wait
    }
  } else {
    Write-Host "[1/4] [OK] Da co Apple Mobile Device Service (iTunes Driver)." -ForegroundColor Green
  }

  # 2. Apple iCloud Web Edition (can thiet cho Sideloadly Anisette tren may moi)
  if (-not (Test-AppleICloudInstalled)) {
    Write-Host "[2/4] May chua co Apple iCloud Web (ho tro xac thuc Apple ID cho Sideloadly)." -ForegroundColor Yellow
    $IcloudInstaller = Join-Path $ReleasesDir "iCloudSetup.exe"
    if (-not (Test-Path $IcloudInstaller)) {
      Write-Host "      Dang tai iCloud ban Web chinh thuc tu Apple..." -ForegroundColor Cyan
      & curl.exe -L $IcloudUrl -o $IcloudInstaller
    }
    if (Test-Path $IcloudInstaller) {
      Write-Host "      Dang mo trinh cai dat iCloud Web..." -ForegroundColor Cyan
      Start-Process -FilePath $IcloudInstaller -Wait
    }
  } else {
    Write-Host "[2/4] [OK] Da co Apple iCloud Web libraries." -ForegroundColor Green
  }

  # 3. Sideloadly 64-bit
  Write-Host "[3/4] Kiem tra Sideloadly 64-bit..." -ForegroundColor Cyan
  Ensure-SideloadlyInstalled | Out-Null

  # 4. File .IPA Kho Anh
  Write-Host "[4/4] Kiem tra file Kho Anh (.ipa)..." -ForegroundColor Cyan
  if (-not (Test-Path $IpaPath)) {
    Update-LatestIpa
  } else {
    Write-Host "[OK] Da co san file .ipa tai: $IpaPath" -ForegroundColor Green
  }
}

function Ensure-AppleMobileDeviceService {
  $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    Write-Host "[!] May chua co 'Apple Mobile Device Service'. Dang tu dong tai va cai iTunes 64-bit..." -ForegroundColor Yellow
    $ItunesInstaller = Join-Path $ReleasesDir "iTunes64Setup.exe"
    if (-not (Test-Path $ItunesInstaller)) {
      & curl.exe -L $ItunesUrl -o $ItunesInstaller
    }
    if (Test-Path $ItunesInstaller) {
      Start-Process -FilePath $ItunesInstaller -Wait
    }
    $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return $false }
  }
  if ($svc.Status -ne "Running") {
    Write-Host "[*] Dang khoi dong dich vu Apple Mobile Device Service..." -ForegroundColor Cyan
    Start-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  $svc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
  if ($svc.Status -eq "Running") {
    Write-Host "[OK] Apple Mobile Device Service dang chay (ho tro dong bo iPhone qua cap va Wi-Fi)." -ForegroundColor Green
    return $true
  }
  return $false
}

function Ensure-SideloadlyInstalled {
  if (Test-Path $SideloadlyExe) {
    Write-Host "[OK] Da tim thay Sideloadly tai: $SideloadlyExe" -ForegroundColor Green
    return $true
  }

  Write-Host "[*] May chua co Sideloadly. Dang mo bo cai Sideloadly 64-bit..." -ForegroundColor Cyan
  $LocalInstaller = Join-Path $RootDir "releases\SideloadlySetup64.exe"
  $InstallerPath = if (Test-Path $LocalInstaller) { $LocalInstaller } else { Join-Path $env:TEMP "SideloadlySetup64.exe" }
  try {
    if (-not (Test-Path $InstallerPath)) {
      Invoke-WebRequest -Uri "https://sideloadly.io/SideloadlySetup64.exe" -OutFile $InstallerPath -UseBasicParsing
    }
    Write-Host "[*] Dang chay trinh cai dat Sideloadly ($InstallerPath)..." -ForegroundColor Cyan
    Start-Process -FilePath $InstallerPath -Wait
  } catch {
    Write-Host "[!] Khong tai tu dong duoc Sideloadly: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    Ban co the chay file: $LocalInstaller" -ForegroundColor Yellow
    return $false
  }

  if (Test-Path $SideloadlyExe) {
    Write-Host "[OK] Da cai dat Sideloadly thanh cong!" -ForegroundColor Green
    return $true
  }
  return $false
}

function Start-AutoRenewDaemons {
  Ensure-AppleMobileDeviceService | Out-Null

  if (Test-Path $SideloadlyDaemon) {
    $proc = Get-Process -Name "SideloadlyDaemon" -ErrorAction SilentlyContinue
    if (-not $proc) {
      Write-Host "[*] Dang khoi dong ngam Sideloadly Wi-Fi Auto-Refresh Daemon..." -ForegroundColor Cyan
      Start-Process -FilePath $SideloadlyDaemon -WindowStyle Minimized
    } else {
      Write-Host "[OK] SideloadlyDaemon dang chay ngam (Tu dong gia han iPhone qua Wi-Fi)." -ForegroundColor Green
    }
  }

  if (Test-Path $AltServerExe) {
    $altProc = Get-Process -Name "AltServer" -ErrorAction SilentlyContinue
    if (-not $altProc) {
      Write-Host "[*] Dang khoi dong ngam AltServer Wi-Fi Daemon..." -ForegroundColor Cyan
      Start-Process -FilePath $AltServerExe -WindowStyle Minimized
    } else {
      Write-Host "[OK] AltServer dang chay ngam." -ForegroundColor Green
    }
  }
}

function Install-IpaToIphone {
  Write-Host "`n================ CAI DAT KHO ANH (.IPA) VA BAT GIA HAN WI-FI ================" -ForegroundColor Cyan
  Ensure-AppleMobileDeviceService | Out-Null

  if (-not (Test-Path $IpaPath)) {
    Write-Host "[*] Chua thay file .ipa cuc bo, dang tai tu GitHub Release..." -ForegroundColor Yellow
    Update-LatestIpa
  }

  if (-not (Ensure-SideloadlyInstalled)) {
    return
  }

  Start-AutoRenewDaemons

  Write-Host "`n[*] Dang mo Sideloadly nap san file: $IpaPath" -ForegroundColor Green
  Write-Host "HUONG DAN CAI LAN DAU (CHI CAN CAM CAP 1 LAN DUY NHAT):" -ForegroundColor Yellow
  Write-Host "  1. Cam cap iPhone vao may tinh (bam 'Tin cay / Trust' tren iPhone neu duoc hoi)."
  Write-Host "  2. Trong cua so Sideloadly vua mo: nhap Apple ID cua ban."
  Write-Host "  3. Dam bao o 'Automatic Refresh' (bieu tuong Wi-Fi) duoc BAT."
  Write-Host "  4. Bam 'Start' -> Doi ~30 giay app 'Kho Anh' se xuat hien tren man hinh iPhone!"
  Write-Host "  5. Tren iPhone: vao Cai dat -> Cai dat chung -> Quan ly VPN va Thiet bi -> Tin cay Apple ID (va bat Developer Mode neu iOS 16+)."
  Write-Host "  -> Tu lan sau, moi khi may tinh va iPhone cung bat 1 mang Wi-Fi, Sideloadly Daemon se TU DONG GIA HAN 7 ngay ma khong can cam cap!" -ForegroundColor Green

  Start-Process -FilePath $SideloadlyExe -ArgumentList "`"$IpaPath`""
}

function Enable-WindowsAutoRenewTask {
  Write-Host "`n================ CAI TAC VU TU DONG GIA HAN NGAM (WINDOWS) ================" -ForegroundColor Cyan
  $ScriptFullPath = $MyInvocation.MyCommand.Definition
  if (-not $ScriptFullPath) {
    $ScriptFullPath = Join-Path $RootDir "infrastructure\ios\KhoAnh-iOS-Toolkit.ps1"
  }

  $ArgStr = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptFullPath`" -Action WatchdogTick"

  $StartupDir = [Environment]::GetFolderPath("Startup")
  $CmdStartup = Join-Path $StartupDir "KhoAnh-iOS-AutoRenew.cmd"
  "@echo off`r`npowershell.exe $ArgStr" | Set-Content -Path $CmdStartup -Encoding ASCII
  Write-Host "[OK] Da kich hoat khoi dong cung Windows tai: $CmdStartup" -ForegroundColor Green

  try {
    & schtasks.exe /Create /TN $TaskName /TR "`"$CmdStartup`"" /SC HOURLY /MO 6 /F | Out-Null
    Write-Host "[OK] Da tao lich tu dong kiem tra va gia han moi 6 tieng ($TaskName)." -ForegroundColor Green
  } catch {
    Write-Host "[!] Khong tao duoc schtasks (da co Startup script thay the)." -ForegroundColor Yellow
  }

  Start-AutoRenewDaemons
  Write-Host "`n[HOAN TAT] Tu gio moi khi ban mo may tinh (va moi 6 tieng), he thong se tu dong giu dich vu Apple Wi-Fi Sync va Sideloadly Daemon chay ngam de gia han app Kho Anh tren iPhone!" -ForegroundColor Green
}

function Update-LatestIpa {
  Write-Host "`n[*] Dang tai ban Kho Anh iOS (.ipa) moi nhat tu GitHub..." -ForegroundColor Cyan
  $ReleasesDir = Join-Path $RootDir "releases"
  if (-not (Test-Path $ReleasesDir)) {
    New-Item -ItemType Directory -Path $ReleasesDir | Out-Null
  }
  try {
    Invoke-WebRequest -Uri $ReleaseIpaUrl -OutFile $IpaPath -UseBasicParsing
    $sizeKb = [Math]::Round((Get-Item $IpaPath).Length / 1KB, 1)
    Write-Host "[OK] Da cap nhat thanh cong: $IpaPath ($sizeKb KB)" -ForegroundColor Green
  } catch {
    Write-Host "[!] Khong tai duoc tu Release URL ($($_.Exception.Message)). Giu nguyen file cuc bo hien tai." -ForegroundColor Yellow
  }
}

function Show-Doctor {
  Write-Host "`n================ KIEM TRA HE THONG CAI VA GIA HAN IOS ================" -ForegroundColor Cyan
  Ensure-AppleMobileDeviceService | Out-Null
  Write-Host ("- File .IPA cuc bo       : " + ($(if (Test-Path $IpaPath) { "CO ($IpaPath)" } else { "CHUA CO" })))
  Write-Host ("- Bo cai Sideloadly      : " + ($(if (Test-Path (Join-Path $RootDir "releases\SideloadlySetup64.exe")) { "DA CO SAN TRONG RELEASES" } else { "CHUA TAI" })))
  Write-Host ("- Sideloadly             : " + ($(if (Test-Path $SideloadlyExe) { "DA CAI ($SideloadlyExe)" } else { "CHUA CAI (Chon phim 1 de cai ngay)" })))
  $daemonRunning = $null -ne (Get-Process -Name "SideloadlyDaemon" -ErrorAction SilentlyContinue)
  Write-Host ("- Sideloadly Wi-Fi Daemon: " + ($(if ($daemonRunning) { "DANG CHAY NGAM (Tu dong gia han BAT)" } else { "DANG TAT" })))
  $startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "KhoAnh-iOS-AutoRenew.cmd"
  Write-Host ("- Tu khoi dong cung Win  : " + ($(if (Test-Path $startupCmd) { "DA BAT" } else { "CHUA BAT (Chon phim 2 de bat)" })))
  Write-Host "`n================ LINK NGUON TU DONG CHO ALTSTORE / SIDESTORE / FEATHER ================" -ForegroundColor Cyan
  Write-Host "  - Link Source JSON (Tu cap nhat va gia han): $AltStoreSourceUrl" -ForegroundColor Green
  Write-Host "  - Link tai truc tiep file .IPA             : $ReleaseIpaUrl" -ForegroundColor Green
}

function Setup-OnDeviceRenewal {
  Write-Host "`n================ GIA HAN TRUC TIEP TREN IPHONE (KHONG CAN BAT MAY TINH) ================" -ForegroundColor Cyan
  Ensure-AppleMobileDeviceService | Out-Null
  if (-not (Ensure-SideloadlyInstalled)) {
    return
  }

  $ReleasesDir = Join-Path $RootDir "releases"
  $SideStoreIpa = Join-Path $ReleasesDir "SideStore.ipa"
  $JbZip = Join-Path $ReleasesDir "jitterbugpair-win64.zip"
  $JbDir = Join-Path $ReleasesDir "jitterbugpair"
  $JbExe = Join-Path $JbDir "jitterbugpair.exe"

  if (-not (Test-Path $SideStoreIpa)) {
    Write-Host "[*] Dang tai SideStore.ipa (ban moi nhat ho tro iOS hien tai)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "https://github.com/SideStore/SideStore/releases/download/0.7.0-alpha/SideStore.ipa" -OutFile $SideStoreIpa -UseBasicParsing
  }
  Write-Host "[OK] Da co SideStore.ipa tai: $SideStoreIpa" -ForegroundColor Green

  if (-not (Test-Path $JbExe)) {
    Write-Host "[*] Dang tai cong cu tao Pairing File (jitterbugpair-win64)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "https://github.com/osy/Jitterbug/releases/download/v1.3.1/jitterbugpair-win64.zip" -OutFile $JbZip -UseBasicParsing
    if (Test-Path $JbDir) { Remove-Item $JbDir -Recurse -Force }
    Expand-Archive -Path $JbZip -DestinationPath $JbDir -Force
  }

  Write-Host "`n[*] Dang tao Pairing File cho iPhone cua ban (Mo khoa man hinh iPhone va bam 'Tin cay / Trust' neu hien)..." -ForegroundColor Yellow
  Push-Location $ReleasesDir
  try {
    & $JbExe
  } catch {
    Write-Host "[!] Loi chay jitterbugpair: $($_.Exception.Message)" -ForegroundColor Red
  }
  Pop-Location

  $PairingFiles = Get-ChildItem -Path $ReleasesDir -Filter "*.mobiledevicepairing" -ErrorAction SilentlyContinue
  if ($PairingFiles) {
    foreach ($pf in $PairingFiles) {
      Write-Host "[OK] Da xuat Pairing File thanh cong: $($pf.FullName)" -ForegroundColor Green
    }
  } else {
    Write-Host "[!] Chua thay file .mobiledevicepairing (Hay dam bao iPhone dang cam cap va mo khoa man hinh, sau do chon lai phim 5)." -ForegroundColor Yellow
  }

  Write-Host "`n[*] Dang mo Sideloadly nap san SideStore.ipa..." -ForegroundColor Green
  Write-Host "CAC BUOC DE GIA HAN NGAY TREN DIEN THOAI (KHONG CAN MAY TINH):" -ForegroundColor Yellow
  Write-Host "  1. Bam 'Start' trong Sideloadly de cai SideStore.ipa len iPhone."
  Write-Host "  2. Gui file .mobiledevicepairing trong thu muc 'E:\app_luu_tru\releases' sang iPhone (qua Zalo/Telegram/iCloud Drive va Luu vao Tep/Files)."
  Write-Host "  3. Tren iPhone: len App Store tai app mien phi 'StosVPN' -> Mo StosVPN bam Connect."
  Write-Host "  4. Mo SideStore tren iPhone -> chon file .mobiledevicepairing -> Dang nhap Apple ID."
  Write-Host "  5. Vao tab Sources trong SideStore -> bam '+' dan link nguon cua ban:"
  Write-Host "     $AltStoreSourceUrl" -ForegroundColor Cyan
  Write-Host "  -> Tu do, ban bam 'Refresh All' ngay tren man hinh iPhone bat cu luc nao ma KHONG CAN CAM CAP hay BAT MAY TINH nua!" -ForegroundColor Green

  Start-Process -FilePath $SideloadlyExe -ArgumentList "`"$SideStoreIpa`""
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
  Write-Host "   BO CONG CU CAI DAT VA TU DONG GIA HAN KHO ANH CHO IPHONE (.IPA)    " -ForegroundColor White
  Write-Host "======================================================================" -ForegroundColor Cyan
  Write-Host "  [1] Cai dat Kho Anh (.ipa) vao iPhone va bat Wi-Fi Auto-Refresh (Tu cai iTunes/Sideloadly neu thieu)"
  Write-Host "  [2] Bat Tu Dong Gia Han Ngam tren Windows (Tu chay moi khi bat may va moi 6h)"
  Write-Host "  [3] Kiem tra trang thai dich vu Apple Wi-Fi Sync va xem link AltStore/Feather Source"
  Write-Host "  [4] Tai/Cap nhat file .ipa moi nhat tu GitHub ve may"
  Write-Host "  [5] Cai SideStore + Xuat Pairing File de GIA HAN NGAY TREN IPHONE (Khong can PC)"
  Write-Host "  [6] Cai dat tron goi cho MAY TINH MOI (iTunes 64-bit + iCloud Web + Sideloadly + .IPA)"
  Write-Host "  [0] Thoat"
  Write-Host "----------------------------------------------------------------------"
  $rawChoice = Read-Host "Chon chuc nang (0-6)"
  if ([string]::IsNullOrWhiteSpace($rawChoice)) { exit 0 }
  $choice = $rawChoice.Trim()
  switch ($choice) {
    "1" { Install-IpaToIphone }
    "2" { Enable-WindowsAutoRenewTask }
    "3" { Show-Doctor }
    "4" { Update-LatestIpa }
    "5" { Setup-OnDeviceRenewal }
    "6" { Install-MissingPrerequisites }
    "0" { exit 0 }
    default { Write-Host "Vui long chon tu 0 den 6." -ForegroundColor Yellow }
  }
}
