#!/usr/bin/env node
// Structural check of the committed Capacitor iOS project.
// Runs on Linux CI — as far as we can go without Xcode / signing.
//
// Verifies the bundle ID, marketing version, encryption export flag,
// App Store icon (1024 RGB, no alpha), and that capacitor.config.ts agrees.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ID = 'app.zeroed.app'
let failed = 0

function ok(label) {
  console.log(`ok  ${label}`)
}

function fail(label, detail) {
  failed++
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`)
}

function read(rel) {
  const path = join(root, rel)
  if (!existsSync(path)) {
    fail(`missing ${rel}`)
    return null
  }
  return readFileSync(path, 'utf8')
}

const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
if (pbx) {
  const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1])
  if (ids.length >= 2 && ids.every((id) => id === BUNDLE_ID)) ok(`pbxproj bundle id ${BUNDLE_ID} (${ids.length} configs)`)
  else fail('pbxproj bundle id', `got ${JSON.stringify(ids)}`)

  if (/MARKETING_VERSION = 0\.1\.0;/.test(pbx)) ok('pbxproj MARKETING_VERSION 0.1.0')
  else fail('pbxproj MARKETING_VERSION', 'expected 0.1.0 (package.json major.minor)')

  if (/CODE_SIGN_STYLE = Automatic;/.test(pbx)) ok('pbxproj automatic signing (CI overrides for manual fallback)')
  else fail('pbxproj CODE_SIGN_STYLE')
}

const plist = read('ios/App/App/Info.plist')
if (plist) {
  if (plist.includes('<string>Zeroed</string>') && plist.includes('CFBundleDisplayName')) {
    ok('Info.plist display name Zeroed')
  } else fail('Info.plist CFBundleDisplayName')

  if (
    /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(plist)
  ) {
    ok('Info.plist ITSAppUsesNonExemptEncryption=false')
  } else fail('Info.plist encryption export flag')

  if (plist.includes('$(MARKETING_VERSION)') && plist.includes('$(CURRENT_PROJECT_VERSION)')) {
    ok('Info.plist versions come from Xcode build settings (CI stamps them)')
  } else fail('Info.plist version keys')
}

const podfile = read('ios/App/Podfile')
if (podfile) {
  if (podfile.includes("@capacitor/ios")) ok('Podfile points at @capacitor/ios')
  else fail('Podfile Capacitor pods')
}

const cap = read('capacitor.config.ts')
if (cap) {
  if (cap.includes(`appId: '${BUNDLE_ID}'`)) ok(`capacitor.config.ts appId ${BUNDLE_ID}`)
  else fail('capacitor.config.ts appId')
}

const iconPath = join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
if (!existsSync(iconPath)) {
  fail('App Store icon missing')
} else {
  const buf = readFileSync(iconPath)
  const png = buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (!png) fail('App Store icon is not a PNG')
  else {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    const colorType = buf[25]
    // PNG color type 2 = RGB (no alpha). 6 = RGBA — App Store rejects that.
    if (width === 1024 && height === 1024) ok(`App Store icon ${width}x${height}`)
    else fail('App Store icon size', `got ${width}x${height}, expected 1024x1024`)
    if (colorType === 2) ok('App Store icon is RGB (no alpha channel)')
    else fail('App Store icon color type', `got ${colorType} (2=RGB, 6=RGBA)`)
    const kb = Math.round(statSync(iconPath).size / 1024)
    ok(`App Store icon ${kb} KB`)
  }
}

const workflow = read('.github/workflows/ios-release.yml')
if (workflow) {
  if (workflow.includes('workflow_dispatch:')) ok('ios-release.yml is manually dispatched')
  else fail('ios-release.yml trigger')
  for (const secret of [
    'APPSTORE_KEY_ID',
    'APPSTORE_ISSUER_ID',
    'APPSTORE_PRIVATE_KEY',
    'APPLE_TEAM_ID',
    'IOS_CERTIFICATE',
    'IOS_CERTIFICATE_PASSWORD',
    'IOS_MOBILE_PROVISION',
  ]) {
    if (workflow.includes(secret)) ok(`workflow references ${secret}`)
    else fail(`workflow missing secret ${secret}`)
  }
}

const exportScript = join(root, 'scripts/ios-write-export-options.sh')
if (!existsSync(exportScript)) fail('scripts/ios-write-export-options.sh missing')
else ok('export-options writer present')

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nios project check passed')
