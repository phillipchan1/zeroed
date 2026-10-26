#!/usr/bin/env node
// Write manual Apple Distribution signing onto the App target only.
//
// xcodebuild SETTING=value applies to every target in the workspace.
// The App Store profile is for app.zeroed.app; CocoaPods targets use
// org.cocoapods.* ids and CODE_SIGNING_ALLOWED=NO (Podfile). A global
// PROVISIONING_PROFILE_SPECIFIER still makes Xcode resolve that profile
// for the pod targets — the same class of bug as passing
// PRODUCT_BUNDLE_IDENTIFIER. These settings therefore live in the App
// target's pbxproj configs (Debug + Release). They are not committed;
// APPLE_TEAM_ID and the profile name come from CI.

import { readFileSync, writeFileSync } from 'node:fs'

const APP_BUNDLE_LINE = 'PRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;'

export function quotePbx(value) {
  if (/^[A-Za-z0-9._/$]+$/.test(value)) return value
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function withAppSigning(pbx, { teamId, profileSpecifier, identity = 'Apple Distribution' }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(`team id must be 10 letters or digits, got ${JSON.stringify(teamId)}`)
  }
  if (!profileSpecifier || typeof profileSpecifier !== 'string') {
    throw new Error('profile specifier is required')
  }
  if (/[\n\r;]/.test(profileSpecifier)) {
    throw new Error('profile specifier contains invalid characters')
  }

  let hits = 0
  let next = pbx.replace(new RegExp(`^(\\t*)${APP_BUNDLE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'), (line, indent) => {
    hits += 1
    return (
      `${indent}CODE_SIGN_IDENTITY = ${quotePbx(identity)};\n` +
      `${indent}PROVISIONING_PROFILE_SPECIFIER = ${quotePbx(profileSpecifier)};\n` +
      `${indent}DEVELOPMENT_TEAM = ${teamId};\n` +
      line
    )
  })
  if (hits !== 2) throw new Error(`expected 2 app.zeroed.app bundle id lines, found ${hits}`)

  const styleHits = (next.match(/CODE_SIGN_STYLE = Automatic;/g) || []).length
  if (styleHits !== 2) {
    throw new Error(`expected 2 CODE_SIGN_STYLE = Automatic lines on the App target, found ${styleHits}`)
  }
  next = next.replace(/CODE_SIGN_STYLE = Automatic;/g, 'CODE_SIGN_STYLE = Manual;')
  next = next.replace(/ProvisioningStyle = Automatic;/g, 'ProvisioningStyle = Manual;')
  return next
}

function parseArgs(argv) {
  const out = { teamId: '', profileSpecifier: '', pbxPath: 'ios/App/App.xcodeproj/project.pbxproj' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--team') out.teamId = argv[++i] ?? ''
    else if (arg === '--profile') out.profileSpecifier = argv[++i] ?? ''
    else if (arg === '--identity') out.identity = argv[++i] ?? ''
    else if (arg === '--self-test' || arg === '--help') continue
    else if (!arg.startsWith('-')) out.pbxPath = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return out
}

function selfTest() {
  const sample = [
    '\t\t\tbuildSettings = {',
    '\t\t\t\tCODE_SIGN_STYLE = Automatic;',
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;',
    '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
    '\t\t\t};',
    '\t\t\tbuildSettings = {',
    '\t\t\t\tCODE_SIGN_STYLE = Automatic;',
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;',
    '\t\t\t};',
    '\t\t\tbuildSettings = {',
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = org.cocoapods.Capacitor;',
    '\t\t\t};',
    '\t\t\tTargetAttributes = {',
    '\t\t\t\tProvisioningStyle = Automatic;',
    '\t\t\t};',
  ].join('\n')

  const out = withAppSigning(sample, { teamId: 'ABCDE12345', profileSpecifier: 'Zeroed App Store' })
  const required = [
    'CODE_SIGN_STYLE = Manual;',
    'CODE_SIGN_IDENTITY = "Apple Distribution";',
    'PROVISIONING_PROFILE_SPECIFIER = "Zeroed App Store";',
    'DEVELOPMENT_TEAM = ABCDE12345;',
    'ProvisioningStyle = Manual;',
  ]
  for (const needle of required) {
    if (!out.includes(needle)) throw new Error(`self-test missing ${needle}`)
  }
  if (out.includes('CODE_SIGN_STYLE = Automatic;') || out.includes('ProvisioningStyle = Automatic;')) {
    throw new Error('self-test left Automatic signing in place')
  }
  if (out.includes('PRODUCT_BUNDLE_IDENTIFIER = org.cocoapods.Capacitor;') === false) {
    throw new Error('self-test dropped the pod bundle id')
  }
  if (out.split('CODE_SIGN_IDENTITY').length !== 3) {
    throw new Error('self-test expected CODE_SIGN_IDENTITY on the App configs only')
  }
  if (out.includes('org.cocoapods.Capacitor') && /Capacitor;[\s\S]*CODE_SIGN_IDENTITY/.test(out)) {
    throw new Error('self-test applied signing to a pod target')
  }
  const podBlock = out.slice(out.indexOf('org.cocoapods.Capacitor') - 80, out.indexOf('org.cocoapods.Capacitor') + 80)
  if (podBlock.includes('CODE_SIGN_IDENTITY') || podBlock.includes('DEVELOPMENT_TEAM')) {
    throw new Error('self-test applied signing next to the pod bundle id')
  }
  console.log('ios-apply-app-signing self-test ok')
}

const isMain = process.argv[1] && process.argv[1].endsWith('ios-apply-app-signing.mjs')
if (isMain && process.argv.includes('--self-test')) {
  try {
    selfTest()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  process.exit(0)
}

if (isMain) {
  try {
    if (process.argv.includes('--help')) {
      console.error('usage: ios-apply-app-signing.mjs --team TEAMID --profile NAME [pbxproj]')
      process.exit(1)
    }
    const { teamId, profileSpecifier, identity, pbxPath } = parseArgs(process.argv.slice(2))
    if (!teamId || !profileSpecifier) {
      console.error('usage: ios-apply-app-signing.mjs --team TEAMID --profile NAME [pbxproj]')
      process.exit(1)
    }
    const updated = withAppSigning(readFileSync(pbxPath, 'utf8'), {
      teamId,
      profileSpecifier,
      ...(identity ? { identity } : {}),
    })
    writeFileSync(pbxPath, updated)
    console.log(`Set manual Apple Distribution signing on the App target in ${pbxPath}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
