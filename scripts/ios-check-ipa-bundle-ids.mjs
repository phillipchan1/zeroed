#!/usr/bin/env node
// Fail if any embedded bundle in an .ipa / .app reuses the main CFBundleIdentifier.
// Only the top-level Info.plist of each .app / .appex / .framework / .bundle
// is a bundle identifier. Compiled storyboards (*.storyboardc/Info.plist) and
// other nested plists are ignored.
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
const BUNDLE_EXTS = new Set(['.app', '.appex', '.framework', '.bundle'])

function isBundleDir(path) {
  return BUNDLE_EXTS.has(extname(path))
}

function walkBundles(root, out = []) {
  if (isBundleDir(root)) out.push(root)
  let names
  try {
    names = readdirSync(root)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(root, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkBundles(full, out)
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
  const apps = walkBundles(root).filter((d) => extname(d) === '.app')
  if (apps.length === 1) return apps[0]
  throw new Error(`could not find a single .app under ${root}`)
}

function inspectApp(appDir) {
  const entries = []
  for (const bundle of walkBundles(appDir)) {
    const plist = join(bundle, 'Info.plist')
    const rel = relative(appDir, bundle) || '.'
    if (!existsSync(plist)) {
      throw new Error(`unreadable bundle plist: missing ${rel}/Info.plist`)
    }
    try {
      entries.push({ path: rel, id: readBundleId(plist), plist })
    } catch (err) {
      throw new Error(`unreadable bundle plist ${rel}/Info.plist: ${err.message}`)
    }
  }
  const main = entries.find((e) => e.path === '.')
  if (!main) throw new Error(`missing top-level Info.plist in ${appDir}`)
  const collisions = entries.filter((e) => e.path !== '.' && e.id === main.id)
  return { mainId: main.id, entries, collisions }
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

function writePlistWithoutBundleId(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>LaunchScreen</string>
</dict>
</plist>
`,
  )
}

function addStoryboardc(appDir) {
  writePlistWithoutBundleId(join(appDir, 'Base.lproj', 'LaunchScreen.storyboardc', 'Info.plist'))
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'zeroed-ipa-check-'))
  try {
    const dirty = join(root, 'Dirty.app')
    writeXmlPlist(join(dirty, 'Info.plist'), MAIN_ID)
    writeXmlPlist(join(dirty, 'Frameworks', 'Capacitor.framework', 'Info.plist'), MAIN_ID)
    writeXmlPlist(join(dirty, 'Frameworks', 'CapacitorCordova.framework', 'Info.plist'), MAIN_ID)
    addStoryboardc(dirty)
    const dirtyResult = inspectApp(dirty)
    if (dirtyResult.collisions.length < 2) {
      throw new Error(
        `self-test expected collisions in Capacitor + CapacitorCordova, got ${JSON.stringify(dirtyResult)}`,
      )
    }
    if (dirtyResult.entries.some((e) => e.path.includes('storyboardc'))) {
      throw new Error('self-test must ignore compiled storyboard Info.plist files')
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
    addStoryboardc(clean)
    const cleanResult = inspectApp(clean)
    if (cleanResult.collisions.length !== 0) {
      throw new Error(`self-test clean app should have no collisions, got ${JSON.stringify(cleanResult)}`)
    }
    if (cleanResult.entries.length !== 3) {
      throw new Error(
        `self-test clean app should inspect app + 2 frameworks (not storyboardc), got ${JSON.stringify(cleanResult)}`,
      )
    }

    const broken = join(root, 'Broken.app')
    writeXmlPlist(join(broken, 'Info.plist'), MAIN_ID)
    writePlistWithoutBundleId(join(broken, 'Frameworks', 'Capacitor.framework', 'Info.plist'))
    let threw = false
    try {
      inspectApp(broken)
    } catch (err) {
      threw = /unreadable bundle plist/.test(err.message)
    }
    if (!threw) throw new Error('self-test expected fail-closed on a framework plist without CFBundleIdentifier')

    console.log('ok  ios-check-ipa-bundle-ids self-test (collision + storyboardc + fail-closed)')
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
    process.exitCode = 1
    return
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
