param(
  [string]$DefaultServerUrl = "https://kho-anh.anhduong-vault.workers.dev"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$jdkParent = Join-Path $env:LOCALAPPDATA "jdk-21"
$sdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"

$javaExe = Get-ChildItem -Path $jdkParent -Filter "java.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $javaExe) {
  throw "OpenJDK 21 not found in $jdkParent"
}
$jdkHome = Split-Path (Split-Path $javaExe.FullName -Parent) -Parent

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:PATH = "$jdkHome\bin;$sdkRoot\platform-tools;$env:PATH"
$env:VITE_MOBILE_DEFAULT_API_URL = $DefaultServerUrl

Push-Location $repoRoot
try {
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Push-Location (Join-Path $repoRoot "apps\web")
  try {
    npx.cmd cap sync android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Push-Location (Join-Path $repoRoot "apps\web\android")
    try {
      & .\gradlew.bat assembleDebug --no-daemon
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
      Pop-Location
    }
  }
  finally {
    Pop-Location
  }

  $srcApk = Join-Path $repoRoot "apps\web\android\app\build\outputs\apk\debug\app-debug.apk"
  $dstRelease = Join-Path $repoRoot "releases\vault-photos-v1.0.1-android-debug.apk"
  $dstLegacyRelease = Join-Path $repoRoot "releases\vault-photos-v1.0-android-debug.apk"
  $apkSigner = Get-ChildItem -Path (Join-Path $sdkRoot "build-tools") -Filter "apksigner.bat" -Recurse |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $apkSigner) {
    throw "apksigner.bat not found in Android SDK Build Tools"
  }
  & $apkSigner.FullName verify --verbose $srcApk
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  New-Item -ItemType Directory -Force -Path (Split-Path $dstRelease) | Out-Null
  Copy-Item $srcApk $dstRelease -Force
  Copy-Item $srcApk $dstLegacyRelease -Force

  $sizeMb = [math]::Round((Get-Item $dstRelease).Length / 1MB, 2)
  $sha256 = (Get-FileHash $dstRelease -Algorithm SHA256).Hash
  Write-Output "APK verified: $dstRelease ($sizeMb MB, SHA-256: $sha256)"
  Write-Output "APK refreshed: $dstLegacyRelease"
}
finally {
  Pop-Location
}
