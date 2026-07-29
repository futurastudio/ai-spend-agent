#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE="$APP_ROOT/dist/aibill Glance.app"
CONTENTS="$BUNDLE/Contents"

swift build --package-path "$APP_ROOT" -c release

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
install -m 755 "$APP_ROOT/.build/release/AibillGlance" "$CONTENTS/MacOS/AibillGlance"
install -m 644 "$APP_ROOT/Info.plist" "$CONTENTS/Info.plist"
touch "$CONTENTS/Resources/.keep"

# Ad-hoc signing is appropriate for this local prototype. Public downloads
# must use Developer ID signing and Apple notarization instead.
codesign --force --deep --sign - "$BUNDLE"

echo "$BUNDLE"
