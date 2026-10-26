#!/usr/bin/env node
// Fail if any embedded bundle in an .ipa / .app reuses the main CFBundleIdentifier.
// ITMS-90685: passing PRODUCT_BUNDLE_IDENTIFIER to xcodebuild stamps every
// CocoaPods framework (Capacitor, CapacitorCordova, Pods_App) with the app id.
//
// Usage:
//   node scripts/ios-check-ipa-bundle-ids.mjs <path-to.ipa|.app>
//   node scripts/ios-check-ipa-bundle-ids.mjs --self-test

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'

const MAIN_ID = 'app.zeroed.app'

function walkInfoPlists(root, out = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkInfoPlists(full, out)
    else if (name === 'Info.plist') out.push(full)
  }
  return out
}

function readBundleId(plistPath) {
  const buf = readFileSync(plistPath)
  if (buf.slice(0, 6).toString('ascii') === 'bplist') {
    try {
      return execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '--', plistPath], {
        encoding: 'utf8',
      }).trim()
    } catch (err) {
      throw new Error(`binary Info.plist at ${plistPath}: ${err.message}`)
    }
  }
  const text = buf.toString('utf8')
  const match = text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)
  if (!match) throw new Error(`no CFBundleIdentifier in ${plistPath}`)
  return match[1].trim()
}

function findAppBundle(root) {
  if (existsSync(join(root, 'Info.plist')) && extname(root) === '.app') return root
  const payload = join(root, 'Payload')
  if (existsSync(payload)) {
    const apps = readdirSync(payload).filter((n) => n.endsWith('.app'))
    if (apps.length === 1) return join(payload, apps[0])
  }
  const nested = walkInfoPlists(root)
    .map((p) => dirname(p))
    .filter((d) => d.endsWith('.app'))
  if (nested.length === 1) return nested[0]
  throw new Error(`could not find a single .app under ${root}`)
}

function inspectApp(appDir) {
  const mainPlist = join(appDir, 'Info.plist')
  if (!existsSync(mainPlist)) throw new Error(`missing ${mainPlist}`)
  const mainId = readBundleId(mainPlist)
  const entries = walkInfoPlists(appDir).map((plist) => ({
    path: relative(appDir, dirname(plist)) || '.',
    id: readBundleId(plist),
    plist,
  }))
  const collisions = entries.filter((e) => e.path !== '.' && e.id === mainId)
  return { mainId, entries, collisions }
}

function writeXmlPlist(path, bundleId) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
</dict>
</plist>
`,
  )
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'zeroed-ipa-check-'))
  try {
    const dirty = join(root, 'Dirty.app')
    writeXmlPlist(join(dirty, 'Info.plist'), MAIN_ID)
    writeXmlPlist(join(dirty, 'Frameworks', 'Capacitor.framework', 'Info.plist'), MAIN_ID)
    writeXmlPlist(join(dirty, 'Frameworks', 'CapacitorCordova.framework', 'Info.plist'), MAIN_ID)
    const dirtyResult = inspectApp(dirty)
    if (dirtyResult.collisions.length < 2) {
      throw new Error(
        `self-test expected collisions in Capacitor + CapacitorCordova, got ${JSON.stringify(dirtyResult)}`,
      )
    }

    const clean = join(root, 'Clean.app')
    writeXmlPlist(join(clean, 'Info.plist'), MAIN_ID)
    writeXmlPlist(
      join(clean, 'Frameworks', 'Capacitor.framework', 'Info.plist'),
      'org.cocoapods.Capacitor',
    )
    writeXmlPlist(
      join(clean, 'Frameworks', 'CapacitorCordova.framework', 'Info.plist'),
      'org.cocoapods.CapacitorCordova',
    )
    const cleanResult = inspectApp(clean)
    if (cleanResult.collisions.length !== 0) {
      throw new Error(`self-test clean app should have no collisions, got ${JSON.stringify(cleanResult)}`)
    }
    console.log('ok  ios-check-ipa-bundle-ids self-test (collision + clean fixtures)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function report(result) {
  console.log(`main CFBundleIdentifier: ${result.mainId}`)
  for (const e of result.entries) {
    console.log(`  ${e.path || '.'}: ${e.id}`)
  }
  if (result.collisions.length) {
    console.error(`\nITMS-90685: ${result.collisions.length} embedded bundle(s) reuse ${result.mainId}:`)
    for (const e of result.collisions) console.error(`  ${e.path}`)
    process.exit(1)
  }
  console.log('no embedded CFBundleIdentifier collisions')
}

const arg = process.argv[2]
if (!arg || arg === '--help') {
  console.error('usage: node scripts/ios-check-ipa-bundle-ids.mjs <path-to.ipa|.app> | --self-test')
  process.exit(2)
}

if (arg === '--self-test') {
  selfTest()
  process.exit(0)
}

if (!existsSync(arg)) {
  console.error(`missing ${arg}`)
  process.exit(2)
}

let appDir = arg
let tmp
if (extname(arg) === '.ipa') {
  tmp = mkdtempSync(join(tmpdir(), 'zeroed-ipa-'))
  execFileSync('unzip', ['-q', arg, '-d', tmp])
  appDir = findAppBundle(tmp)
} else if (extname(arg) !== '.app') {
  appDir = findAppBundle(arg)
}

try {
  report(inspectApp(appDir))
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
