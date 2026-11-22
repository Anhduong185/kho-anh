#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/4] Building @smb/shared & @smb/web..."
npm run build --workspace=packages/shared
npm run build --workspace=apps/web

echo "==> [2/4] Syncing Capacitor iOS project..."
cd "$ROOT_DIR/apps/web"
npx cap sync ios

echo "==> [3/4] Running CocoaPods & xcodebuild (Unsigned Release)..."
cd "$ROOT_DIR/apps/web/ios/App"
pod install
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath build \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  AD_HOC_CODE_SIGNING_ALLOWED=YES \
  clean build

echo "==> [4/4] Packaging .ipa..."
rm -rf Payload
mkdir -p Payload "$ROOT_DIR/releases"
cp -R build/Build/Products/Release-iphoneos/App.app Payload/App.app
IPA_PATH="$ROOT_DIR/releases/vault-photos-v1.0.2-ios-unsigned.ipa"
zip -qry "$IPA_PATH" Payload
rm -rf Payload

echo "==> DONE! IPA generated at: $IPA_PATH"
