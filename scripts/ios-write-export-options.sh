#!/usr/bin/env bash
# Write an ExportOptions.plist for xcodebuild -exportArchive.
# Nuvo lets Tauri emit this; Capacitor's `cap build ios` only writes a
# method=app-store-connect stub, so CI owns the full file.
#
# Usage:
#   SIGNING_STYLE=automatic|manual \
#   APPLE_DEVELOPMENT_TEAM=... \
#   IOS_BUNDLE_ID=app.zeroed.app \
#   IOS_PROFILE_NAME='Zeroed App Store' \   # manual only
#   scripts/ios-write-export-options.sh /path/ExportOptions.plist
set -euo pipefail

out="${1:?export options path}"

if [ "${SIGNING_STYLE:-automatic}" = "manual" ]; then
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>teamID</key>
  <string>${APPLE_DEVELOPMENT_TEAM:?}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${IOS_BUNDLE_ID:?}</key>
    <string>${IOS_PROFILE_NAME:?}</string>
  </dict>
</dict>
</plist>
EOF
else
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${APPLE_DEVELOPMENT_TEAM:?}</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF
fi
