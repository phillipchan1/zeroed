#!/usr/bin/env node
// Structural check of the committed Capacitor iOS project.
// Runs on Linux CI — as far as we can go without Xcode / signing.
//
// Verifies the bundle ID, marketing version, encryption export flag,
// App Store icon (1024 RGB, no alpha), and that capacitor.config.ts agrees.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
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

  if (/CODE_SIGN_STYLE = Automatic;/.test(pbx)) ok('pbxproj automatic signing (local Xcode; CI overrides to Manual Distribution)')
  else fail('pbxproj CODE_SIGN_STYLE')

  // A forced identity makes `xcodebuild archive` request a development
  // profile (iPhone Developer) or fight automatic signing (Apple Distribution).
  const releaseBlocks = [...pbx.matchAll(/\/\* Release \*\/ = \{[\s\S]*?name = Release;\n\t\t\};/g)].map((m) => m[0])
  if (releaseBlocks.length >= 2 && releaseBlocks.every((b) => !b.includes('CODE_SIGN_IDENTITY'))) {
    ok('Release does not force CODE_SIGN_IDENTITY')
  } else fail('Release CODE_SIGN_IDENTITY', 'leave it unset so archive can select the App Store certificate')

  const deployTargets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g)].map((m) => m[1])
  if (deployTargets.length && deployTargets.every((t) => t === '15.0')) {
    ok(`pbxproj IPHONEOS_DEPLOYMENT_TARGET 15.0 (${deployTargets.length} configs)`)
  } else fail('pbxproj IPHONEOS_DEPLOYMENT_TARGET', `got ${JSON.stringify(deployTargets)}, expected 15.0`)
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

  if (/<key>UIRequiresFullScreen<\/key>\s*<true\/>/.test(plist)) {
    ok('Info.plist UIRequiresFullScreen=true (ITMS-90474, portrait-only iPad)')
  } else fail('Info.plist UIRequiresFullScreen')
}

const podfile = read('ios/App/Podfile')
if (podfile) {
  if (podfile.includes("@capacitor/ios")) ok('Podfile points at @capacitor/ios')
  else fail('Podfile Capacitor pods')
  if (/platform :ios, ['"]15\.0['"]/.test(podfile)) ok('Podfile platform iOS 15.0')
  else fail('Podfile platform', 'expected platform :ios, \'15.0\'')
  if (podfile.includes("org.cocoapods.") && podfile.includes('PRODUCT_BUNDLE_IDENTIFIER')) {
    ok('Podfile assigns unique PRODUCT_BUNDLE_IDENTIFIER to pod targets')
  } else fail('Podfile pod bundle ids')
  if (podfile.includes("CODE_SIGNING_ALLOWED'] = 'NO'")) {
    ok('Podfile does not let pod targets sign themselves')
  } else fail('Podfile CODE_SIGNING_ALLOWED', 'pod targets must not request their own certificate')
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
  if (workflow.includes('workflow_dispatch:')) ok('ios-release.yml keeps workflow_dispatch')
  else fail('ios-release.yml workflow_dispatch')
  if (
    /push:\s*\n\s*branches:\s*\[master\]/.test(workflow) ||
    workflow.includes('branches: [master]')
  ) {
    ok('ios-release.yml runs on push to master')
  } else fail('ios-release.yml push-to-master trigger')

  if (workflow.includes('vars.VITE_API_BASE_URL')) {
    ok('workflow reads VITE_API_BASE_URL from a repo variable')
  } else fail('workflow VITE_API_BASE_URL var')
  if (workflow.includes('unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY')) {
    ok('workflow does not bake VITE_SUPABASE_* when VITE_API_BASE_URL is set')
  } else fail('workflow still bakes VITE_SUPABASE_* unconditionally')

  if (
    workflow.includes('::error::Missing GitHub Actions secrets required for iOS TestFlight') &&
    workflow.includes('exit 1') &&
    !workflow.includes('ready=false') &&
    !workflow.includes('Skipping iOS TestFlight')
  ) {
    ok('workflow fails when TestFlight secrets are missing')
  } else fail('workflow missing-secrets fail', 'must exit 1 with ::error:: — no skip-green, no automatic-signing fallback')

  for (const secret of [
    'ASC_API_KEY_ID',
    'ASC_API_ISSUER_ID',
    'ASC_API_KEY_P8',
    'APPLE_TEAM_ID',
    'IOS_DIST_CERT_P12_BASE64',
    'IOS_DIST_CERT_PASSWORD',
    'IOS_APPSTORE_PROFILE_BASE64',
  ]) {
    if (workflow.includes(secret)) ok(`workflow references ${secret}`)
    else fail(`workflow missing secret ${secret}`)
  }

  for (const dropped of [
    'IOS_CERTIFICATE',
    'IOS_CERTIFICATE_PASSWORD',
    'IOS_MOBILE_PROVISION',
    'APPSTORE_KEY_ID',
    'APPSTORE_ISSUER_ID',
    'APPSTORE_PRIVATE_KEY',
  ]) {
    if (workflow.includes(dropped)) fail(`workflow still references dropped secret ${dropped}`)
    else ok(`workflow dropped ${dropped}`)
  }

  if (workflow.includes('-allowProvisioningUpdates')) {
    fail('workflow uses -allowProvisioningUpdates', 'manual Distribution signing must not mint certificates')
  } else ok('workflow does not pass -allowProvisioningUpdates')

  if (workflow.includes('asc-revoke-api-dev-certs') || workflow.includes('Drop stale API')) {
    fail('workflow still revokes certificates')
  } else ok('workflow does not revoke certificates')
  if (existsSync(join(root, 'scripts/asc-revoke-api-dev-certs.mjs'))) {
    fail('scripts/asc-revoke-api-dev-certs.mjs is still present')
  } else ok('revoke-certs script is gone')

  if (workflow.includes('ios-apply-app-signing.mjs')) {
    ok('workflow writes Distribution signing onto the App target only')
  } else fail('workflow App-target signing', 'must call ios-apply-app-signing.mjs so pods do not inherit the App Store profile')

  // xcodebuild SETTING=value applies to CocoaPods too. Identity / profile /
  // team / style belong on the App target, not on the archive command line.
  if (/^\s+CODE_SIGN_IDENTITY=/.test(workflow)) {
    fail('workflow passes CODE_SIGN_IDENTITY to xcodebuild', 'scope it to the App target — pods have different bundle IDs')
  } else ok('workflow does not pass CODE_SIGN_IDENTITY to every target')
  if (/^\s+PROVISIONING_PROFILE_SPECIFIER=/.test(workflow)) {
    fail('workflow passes PROVISIONING_PROFILE_SPECIFIER to xcodebuild', 'scope it to the App target — the App Store profile is for app.zeroed.app only')
  } else ok('workflow does not pass PROVISIONING_PROFILE_SPECIFIER to every target')
  if (/^\s+DEVELOPMENT_TEAM=/.test(workflow)) {
    fail('workflow passes DEVELOPMENT_TEAM to xcodebuild', 'scope it to the App target')
  } else ok('workflow does not pass DEVELOPMENT_TEAM to every target')
  if (/^\s+CODE_SIGN_STYLE=/.test(workflow)) {
    fail('workflow passes CODE_SIGN_STYLE to xcodebuild', 'scope it to the App target')
  } else ok('workflow does not pass CODE_SIGN_STYLE to every target')

  if (workflow.includes('create-keychain') && workflow.includes('security import') && workflow.includes('delete-keychain')) {
    ok('workflow imports the Distribution .p12 into a temporary keychain')
  } else fail('workflow keychain import / cleanup')

  if (/if:\s*always\(\)/.test(workflow) && workflow.includes('Delete signing keychain')) {
    ok('workflow deletes the signing keychain and .p8 in an always() step')
  } else fail('workflow keychain / .p8 cleanup')

  if (workflow.includes('umask 077')) ok('workflow sets umask 077 before writing the .p8')
  else fail('workflow umask 077')

  if (
    workflow.includes('${{ runner.temp }}/zeroed-asc.p8') &&
    workflow.includes('AuthKey_"*.p8')
  ) {
    ok('workflow cleanup uses a fixed path/glob, not earlier-step env')
  } else fail('workflow .p8 cleanup path')

  if (/cancel-in-progress:\s*false/.test(workflow)) {
    ok('workflow will not cancel an in-progress TestFlight upload')
  } else fail('workflow cancel-in-progress should be false')

  const writeAt = workflow.indexOf('- name: Write App Store Connect API key')
  const syncAt = workflow.indexOf('- name: Build web assets and sync Capacitor iOS')
  const archiveAt = workflow.indexOf('- name: Build signed IPA')
  if (writeAt !== -1 && syncAt !== -1 && archiveAt !== -1 && syncAt < writeAt && writeAt < archiveAt) {
    ok('workflow writes the .p8 after cap sync and before xcodebuild')
  } else fail('workflow .p8 write timing')

  if (
    /uses:\s*actions\/checkout@[0-9a-f]{40}/.test(workflow) &&
    /uses:\s*actions\/setup-node@[0-9a-f]{40}/.test(workflow)
  ) {
    ok('ios-release.yml pins checkout and setup-node to full SHAs')
  } else fail('ios-release.yml floating action tags')

  if (workflow.includes('PRODUCT_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID"')) {
    fail('workflow passes PRODUCT_BUNDLE_IDENTIFIER to xcodebuild (ITMS-90685)')
  } else ok('workflow does not stamp every target with app.zeroed.app')

  if (workflow.includes('ios-check-ipa-bundle-ids.mjs')) {
    ok('workflow inspects the IPA for duplicate CFBundleIdentifier values')
  } else fail('workflow missing IPA bundle-id check')
}

const exportScript = join(root, 'scripts/ios-write-export-options.sh')
if (!existsSync(exportScript)) fail('scripts/ios-write-export-options.sh missing')
else {
  ok('export-options writer present')
  const exportOut = join(root, 'scripts/.ios-export-options-self-test.plist')
  try {
    execFileSync('bash', [exportScript, exportOut], {
      env: {
        ...process.env,
        APPLE_DEVELOPMENT_TEAM: 'ABCDE12345',
        PROVISIONING_PROFILE_SPECIFIER: 'Zeroed App Store',
        IOS_BUNDLE_ID: BUNDLE_ID,
      },
    })
    const plist = readFileSync(exportOut, 'utf8')
    if (
      plist.includes('<string>app-store</string>') &&
      plist.includes('<string>manual</string>') &&
      plist.includes('<string>Apple Distribution</string>') &&
      plist.includes(`<key>${BUNDLE_ID}</key>`) &&
      plist.includes('<string>Zeroed App Store</string>') &&
      plist.includes('<string>ABCDE12345</string>')
    ) {
      ok('export-options writer emits manual app-store signing')
    } else fail('export-options writer contents', plist)
  } catch (err) {
    fail('export-options writer self-test', err instanceof Error ? err.message : String(err))
  } finally {
    try {
      unlinkSync(exportOut)
    } catch {
      // ignore
    }
  }
}

try {
  execFileSync(process.execPath, [join(root, 'scripts/ios-check-ipa-bundle-ids.mjs'), '--self-test'], {
    stdio: 'inherit',
  })
} catch {
  fail('ios-check-ipa-bundle-ids --self-test')
}

if (existsSync(join(root, 'scripts/ios-set-development-team.mjs'))) {
  fail('scripts/ios-set-development-team.mjs is still present', 'unused after App-target signing moved to ios-apply-app-signing.mjs')
} else ok('ios-set-development-team.mjs is gone')

try {
  execFileSync(process.execPath, [join(root, 'scripts/ios-apply-app-signing.mjs'), '--self-test'], {
    stdio: 'inherit',
  })
} catch {
  fail('ios-apply-app-signing --self-test')
}

if (pbx) {
  try {
    const { withAppSigning } = await import(new URL('./ios-apply-app-signing.mjs', import.meta.url))
    const signed = withAppSigning(pbx, { teamId: 'ABCDE12345', profileSpecifier: 'Zeroed App Store' })
    const appRelease = [...signed.matchAll(/\/\* Release \*\/ = \{[\s\S]*?name = Release;\n\t\t\};/g)].map((m) => m[0])
    const appBlocks = appRelease.filter((b) => b.includes('PRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;'))
    const projectBlocks = appRelease.filter((b) => !b.includes('PRODUCT_BUNDLE_IDENTIFIER'))
    if (
      appBlocks.length === 1 &&
      appBlocks[0].includes('CODE_SIGN_STYLE = Manual;') &&
      appBlocks[0].includes('CODE_SIGN_IDENTITY = "Apple Distribution";') &&
      appBlocks[0].includes('PROVISIONING_PROFILE_SPECIFIER = "Zeroed App Store";') &&
      appBlocks[0].includes('DEVELOPMENT_TEAM = ABCDE12345;')
    ) {
      ok('apply-app-signing writes Manual Distribution onto the App Release target')
    } else fail('apply-app-signing App Release target')
    if (projectBlocks.every((b) => !b.includes('CODE_SIGN_IDENTITY') && !b.includes('DEVELOPMENT_TEAM'))) {
      ok('apply-app-signing does not write signing onto project-level Release')
    } else fail('apply-app-signing leaked signing onto project-level Release')
    if (signed.includes('ProvisioningStyle = Manual;') && !signed.includes('ProvisioningStyle = Automatic;')) {
      ok('apply-app-signing sets TargetAttributes ProvisioningStyle=Manual')
    } else fail('apply-app-signing ProvisioningStyle')
  } catch (err) {
    fail('apply-app-signing against committed pbxproj', err instanceof Error ? err.message : String(err))
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nios project check passed')
