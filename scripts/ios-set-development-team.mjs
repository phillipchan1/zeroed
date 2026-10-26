#!/usr/bin/env node
// Write DEVELOPMENT_TEAM into the App target before xcodebuild.
//
// Passing DEVELOPMENT_TEAM as an xcodebuild argument makes the archive
// "automatically signed for development", so CI asks for an iOS Development
// certificate and mints a new one on every runner. The team has to live in
// the project instead. It is not committed — APPLE_TEAM_ID is a GitHub secret.

import { readFileSync, writeFileSync } from 'node:fs'

export function withDevelopmentTeam(pbx, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error(`team id must be 10 letters or digits, got ${JSON.stringify(teamId)}`)
  let hits = 0
  const next = pbx.replace(
    /^(\t*)PRODUCT_BUNDLE_IDENTIFIER = app\.zeroed\.app;$/gm,
    (line, indent) => {
      hits += 1
      return `${indent}DEVELOPMENT_TEAM = ${teamId};\n${line}`
    },
  )
  if (hits !== 2) throw new Error(`expected 2 app.zeroed.app bundle id lines, found ${hits}`)
  return next
}

const isMain = process.argv[1] && process.argv[1].endsWith('ios-set-development-team.mjs')
if (isMain && process.argv.includes('--self-test')) {
  const sample = '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.zeroed.app;\n'
  const out = withDevelopmentTeam(sample, 'ABCDE12345')
  if (!out.includes('DEVELOPMENT_TEAM = ABCDE12345;') || out.split('DEVELOPMENT_TEAM').length !== 3) {
    console.error('self-test failed')
    process.exit(1)
  }
  console.log('ios-set-development-team self-test ok')
  process.exit(0)
}

if (isMain) {
  const teamId = process.argv[2]
  const path = process.argv[3] ?? 'ios/App/App.xcodeproj/project.pbxproj'
  if (!teamId) {
    console.error('usage: ios-set-development-team.mjs <TEAMID> [pbxproj]')
    process.exit(1)
  }
  const updated = withDevelopmentTeam(readFileSync(path, 'utf8'), teamId)
  writeFileSync(path, updated)
  console.log(`Set DEVELOPMENT_TEAM on ${path}`)
}
