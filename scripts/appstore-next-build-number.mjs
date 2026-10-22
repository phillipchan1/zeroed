#!/usr/bin/env node
// Auto-remediate iOS build-number collisions against App Store Connect.
//
// ios-release.yml derives its build number from the commit count
// (`git rev-list --count HEAD`) so each commit is unique. That's unique per
// commit, but not per *upload attempt* — a manual re-run of the workflow on a
// commit that was already successfully uploaded would reuse the same
// CFBundleVersion, and App Store Connect rejects an upload whose build number
// isn't strictly greater than the last one for that marketing version
// (CFBundleShortVersionString).
//
// This script asks App Store Connect for the highest build number already
// uploaded for the target marketing version and prints
// max(proposed, existingMax + 1) to stdout. The common case (first upload of
// a commit) has no prior build, so it just echoes the proposed number back.
// Only a genuine retry-on-the-same-commit diverges, and only by the minimum
// needed to satisfy Apple.
//
// BEST-EFFORT: any API/auth problem falls back to the proposed number (with a
// stderr warning) rather than failing the build — a transient App Store
// Connect hiccup shouldn't block a release the version-sync guarantee doesn't
// actually need in the common case.
//
// Ported from phillipchan1/nuvo `scripts/appstore-next-build-number.mjs`
// (same account-level App Store Connect API key).
//
// Usage:
//   node scripts/appstore-next-build-number.mjs \
//     --bundle-id app.zeroed.app --version 0.1.245 --proposed 245 \
//     --key-id XXXX --issuer-id YYYY --key-path /path/AuthKey_XXXX.p8

import { readFileSync } from 'node:fs'
import { createSign, createPrivateKey } from 'node:crypto'
import process from 'node:process'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const bundleId = arg('bundle-id')
const version = arg('version')
const proposed = Number(arg('proposed'))
const keyId = arg('key-id')
const issuerId = arg('issuer-id')
const keyPath = arg('key-path')

function fallback(reason) {
  process.stderr.write(`[appstore-next-build-number] falling back to proposed (${proposed}): ${reason}\n`)
  process.stdout.write(String(proposed))
  process.exit(0)
}

if (!bundleId || !version || !Number.isFinite(proposed) || !keyId || !issuerId || !keyPath) {
  fallback('missing required arguments')
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeJwt() {
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 1140, aud: 'appstoreconnect-v1' }))
  const signingInput = `${header}.${payload}`
  // App Store Connect expects raw IEEE-P1363 (r||s) ES256 signatures, not DER.
  const signature = createSign('SHA256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64url(signature)}`
}

async function get(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}: ${await res.text()}`)
  return res.json()
}

try {
  const token = makeJwt()
  const base = 'https://api.appstoreconnect.apple.com/v1'

  const apps = await get(`${base}/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`, token)
  const appId = apps.data?.[0]?.id
  if (!appId) throw new Error(`no app found for bundle id ${bundleId}`)

  // The app-nested relationship listing (/v1/apps/{id}/preReleaseVersions)
  // only accepts a narrow filter set and rejects filter[version] outright.
  // The top-level collection endpoint supports filtering by both app and version.
  const preReleaseVersions = await get(
    `${base}/preReleaseVersions?filter[app]=${appId}&filter[version]=${encodeURIComponent(version)}&limit=1`,
    token
  )
  const preReleaseVersionId = preReleaseVersions.data?.[0]?.id
  if (!preReleaseVersionId) {
    process.stdout.write(String(proposed))
    process.exit(0)
  }

  const builds = await get(
    `${base}/preReleaseVersions/${preReleaseVersionId}/builds?sort=-uploadedDate&limit=1&fields[builds]=version`,
    token
  )
  const existingMax = Number(builds.data?.[0]?.attributes?.version)
  const final = Number.isFinite(existingMax) ? Math.max(proposed, existingMax + 1) : proposed
  if (final !== proposed) {
    process.stderr.write(
      `[appstore-next-build-number] build ${proposed} already used for version ${version} (highest uploaded: ${existingMax}) — bumping to ${final}\n`
    )
  }
  process.stdout.write(String(final))
} catch (err) {
  fallback(err)
}
