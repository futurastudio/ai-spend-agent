#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_ROOT="$APP_ROOT/dist/release"
BUNDLE="$APP_ROOT/dist/aibill Glance.app"

required=(
  AIBILL_GLANCE_SIGN_IDENTITY
  AIBILL_GLANCE_VERSION
  AIBILL_GLANCE_BUILD_NUMBER
  AIBILL_NOTARY_KEYCHAIN_PROFILE
  AIBILL_SPARKLE_FEED_URL
  AIBILL_SPARKLE_PUBLIC_KEY
  AIBILL_SPARKLE_PRIVATE_KEY_FILE
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required release setting: $name" >&2
    exit 1
  fi
done
if [[ "$AIBILL_SPARKLE_FEED_URL" != https://* ]]; then
  echo "AIBILL_SPARKLE_FEED_URL must use HTTPS" >&2
  exit 1
fi
if [[ ! -f "$AIBILL_SPARKLE_PRIVATE_KEY_FILE" ]]; then
  echo "Sparkle private key file was not found" >&2
  exit 1
fi

export AIBILL_GLANCE_UNIVERSAL=1
"$SCRIPT_DIR/build-app.sh"

mkdir -p "$RELEASE_ROOT"
SUBMISSION_ZIP="$RELEASE_ROOT/aibill-Glance-notary-submission.zip"
FINAL_ZIP="$RELEASE_ROOT/aibill-Glance.zip"
rm -f "$SUBMISSION_ZIP" "$FINAL_ZIP"

ditto -c -k --sequesterRsrc --keepParent "$BUNDLE" "$SUBMISSION_ZIP"
xcrun notarytool submit "$SUBMISSION_ZIP" \
  --keychain-profile "$AIBILL_NOTARY_KEYCHAIN_PROFILE" \
  --wait
xcrun stapler staple "$BUNDLE"
xcrun stapler validate "$BUNDLE"
spctl --assess --type execute --verbose=4 "$BUNDLE"
ditto -c -k --sequesterRsrc --keepParent "$BUNDLE" "$FINAL_ZIP"
rm -f "$SUBMISSION_ZIP"

GENERATE_APPCAST="$(find "$APP_ROOT/.build" -type f -name generate_appcast -perm -111 -print -quit)"
if [[ -z "$GENERATE_APPCAST" ]]; then
  echo "Sparkle generate_appcast tool was not found in SwiftPM artifacts" >&2
  exit 1
fi
"$GENERATE_APPCAST" -f "$AIBILL_SPARKLE_PRIVATE_KEY_FILE" "$RELEASE_ROOT"

echo "Signed/notarized update archive: $FINAL_ZIP"
echo "Generated appcast: $RELEASE_ROOT/appcast.xml"
