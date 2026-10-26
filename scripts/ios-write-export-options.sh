#!/usr/bin/env bash
# Write an ExportOptions.plist for xcodebuild -exportArchive.
# Automatic / cloud-managed distribution signing via the App Store Connect
# API key passed as -authenticationKeyPath on archive + export.
#
# Usage:
#   APPLE_DEVELOPMENT_TEAM=... \
#   scripts/ios-write-export-options.sh /path/ExportOptions.plist
set -euo pipefail

out="${1:?export options path}"

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
