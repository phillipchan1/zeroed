#!/usr/bin/env bash
# Write an ExportOptions.plist for xcodebuild -exportArchive.
# Manual App Store signing with a pre-imported Apple Distribution
# certificate and App Store provisioning profile. Never uses
# allowProvisioningUpdates.
#
# Usage:
#   APPLE_DEVELOPMENT_TEAM=... \
#   PROVISIONING_PROFILE_SPECIFIER=... \
#   IOS_BUNDLE_ID=app.zeroed.app \
#   scripts/ios-write-export-options.sh /path/ExportOptions.plist
set -euo pipefail

out="${1:?export options path}"
team="${APPLE_DEVELOPMENT_TEAM:?APPLE_DEVELOPMENT_TEAM is required}"
profile="${PROVISIONING_PROFILE_SPECIFIER:?PROVISIONING_PROFILE_SPECIFIER is required}"
bundle="${IOS_BUNDLE_ID:?IOS_BUNDLE_ID is required}"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>teamID</key>
  <string>$(xml_escape "$team")</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$(xml_escape "$bundle")</key>
    <string>$(xml_escape "$profile")</string>
  </dict>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF
