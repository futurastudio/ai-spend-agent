#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE="$APP_ROOT/dist/aibill Glance.app"
CONTENTS="$BUNDLE/Contents"
PLIST="$CONTENTS/Info.plist"
SIGN_IDENTITY="${AIBILL_GLANCE_SIGN_IDENTITY:--}"
UNIVERSAL="${AIBILL_GLANCE_UNIVERSAL:-0}"
FEED_URL="${AIBILL_SPARKLE_FEED_URL:-}"
PUBLIC_KEY="${AIBILL_SPARKLE_PUBLIC_KEY:-}"
VERSION="${AIBILL_GLANCE_VERSION:-}"
BUILD_NUMBER="${AIBILL_GLANCE_BUILD_NUMBER:-}"

BUILD_ARGS=(--package-path "$APP_ROOT" -c release)
if [[ "$UNIVERSAL" == "1" ]]; then
  BUILD_ARGS+=(--arch arm64 --arch x86_64)
fi
swift build "${BUILD_ARGS[@]}"
BIN_DIR="$(swift build "${BUILD_ARGS[@]}" --show-bin-path)"

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$CONTENTS/Frameworks"
install -m 755 "$BIN_DIR/AibillGlance" "$CONTENTS/MacOS/AibillGlance"
install -m 644 "$APP_ROOT/Info.plist" "$PLIST"
touch "$CONTENTS/Resources/.keep"

if [[ -n "$VERSION" || -n "$BUILD_NUMBER" ]]; then
  if [[ ! "$VERSION" =~ ^[0-9]+([.][0-9]+){1,2}$ || ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "A release requires semantic AIBILL_GLANCE_VERSION and numeric AIBILL_GLANCE_BUILD_NUMBER" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"
fi

SPARKLE_FRAMEWORK="$(find "$APP_ROOT/.build" -path "*/release/Sparkle.framework" -print -quit)"
if [[ -z "$SPARKLE_FRAMEWORK" ]]; then
  echo "Sparkle.framework was not produced by SwiftPM" >&2
  exit 1
fi
ditto "$SPARKLE_FRAMEWORK" "$CONTENTS/Frameworks/Sparkle.framework"

# SwiftPM's command-line product does not add the conventional app-bundle
# Frameworks search path. Embed it before signing so dyld can resolve Sparkle
# from Contents/Frameworks in both local and release bundles.
if ! otool -l "$CONTENTS/MacOS/AibillGlance" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" \
    "$CONTENTS/MacOS/AibillGlance"
fi

if [[ -n "$FEED_URL" || -n "$PUBLIC_KEY" ]]; then
  if [[ "$FEED_URL" != https://* || -z "$PUBLIC_KEY" ]]; then
    echo "A release updater requires both an HTTPS AIBILL_SPARKLE_FEED_URL and AIBILL_SPARKLE_PUBLIC_KEY" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $FEED_URL" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $PUBLIC_KEY" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool true" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUScheduledCheckInterval integer 86400" "$PLIST"
fi

SIGN_ARGS=(--force --deep --sign "$SIGN_IDENTITY")
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  SIGN_ARGS+=(--options runtime --timestamp)
fi
codesign "${SIGN_ARGS[@]}" "$BUNDLE"
codesign --verify --deep --strict --verbose=2 "$BUNDLE"

echo "$BUNDLE"
