param(
  [Parameter(Mandatory = $true)]
  [string]$GitHubRepoUrl,
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

if (-not (Test-Path ".git")) {
  git init
  git branch -M $Branch
}

if (-not (Test-Path ".gitignore")) {
  @"
node_modules/
dist/
*.log
.DS_Store
apps/web/android/.gradle/
apps/web/android/app/build/
apps/web/ios/App/Pods/
apps/web/ios/App/build/
backend/data/
"@ | Set-Content -Path ".gitignore" -Encoding UTF8
}

git add .
git commit -m "chore(ios): sync Capacitor iOS project & GitHub Actions macOS IPA builder" --allow-empty

$remotes = git remote
if ($remotes -contains "origin") {
  git remote set-url origin $GitHubRepoUrl
} else {
  git remote add origin $GitHubRepoUrl
}

Write-Host "==> Pushing to $GitHubRepoUrl ($Branch) to trigger macOS Xcode .ipa build..."
git push -u origin $Branch --force
Write-Host "==> Done! Open your GitHub repo -> Actions tab -> 'Build iOS IPA' to download vault-photos-v1.0.2-ios-unsigned.ipa"
