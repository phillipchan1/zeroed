#!/usr/bin/env node
// Auto-remediate iOS build-number collisions against App Store Connect.
//
// ios-release.yml derives its build number from the commit count
// (`git rev-list --count HEAD`) so each commit is unique. That's unique per
// commit, but not per *upload attempt* — a manual re-run of the workflow on a
// commit that was already successfully uploaded would reuse the same
// CFBundleVersion, and App Store Connect rejects an upload whose build number
// isn't strictly greater than the last one uploaded for the app
// (Apple -19241 / ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE).
//
// This script asks App Store Connect for the latest uploaded build of the
// app (GET /v1/builds?filter[app]=…&sort=-uploadedDate) and prints
// max(proposed, latest + 1) to stdout. The common case (first upload of a
// commit, and nothing newer on file) echoes the proposed number back.
//
// Do not fall back to the proposed number if the ASC lookup fails — that
// number may already be used (run 40377169434 uploaded 187 after a 400).
//
// The nested listing GET /v1/preReleaseVersions/{id}/builds rejects `sort`
// (`PARAMETER_ERROR.ILLEGAL`). List Builds documents filter[app] and
// sort=-uploadedDate:
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
//
// Usage:
//   node scripts/appstore-next-build-number.mjs \
//     --bundle-id app.zeroed.app --version 0.1.245 --proposed 245 \
//     --key-id XXXX --issuer-id YYYY --key-path /path/AuthKey_XXXX.p8

import { readFileSync } from 'node:fs'
import { createSign, createPrivateKey } from 'node:crypto'
import process from 'node:process'

const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1'

export function nextBuildNumber(proposed, latestUploaded) {
  if (!Number.isFinite(proposed)) {
    throw new Error(`proposed must be a finite number, got ${JSON.stringify(proposed)}`)
  }
  if (latestUploaded == null) return proposed
  if (!Number.isFinite(latestUploaded)) {
    throw new Error(`latest uploaded build is not a number: ${JSON.stringify(latestUploaded)}`)
  }
  return Math.max(proposed, latestUploaded + 1)
}

export function latestBuildsUrl(appId) {
  if (!appId) throw new Error('app id is required')
  return (
    `${ASC_BASE}/builds?filter[app]=${encodeURIComponent(appId)}` +
    `&sort=-uploadedDate&limit=1&fields[builds]=version`
  )
}

function selfTest() {
  const cases = [
    [187, null, 187],
    [187, undefined, 187],
    [187, 187, 188],
    [200, 187, 200],
    [187, 200, 201],
  ]
  for (const [proposed, latest, want] of cases) {
    const got = nextBuildNumber(proposed, latest)
    if (got !== want) {
      throw new Error(`nextBuildNumber(${proposed}, ${latest}) = ${got}, want ${want}`)
    }
  }
  for (const bad of [NaN, '187', '']) {
    let threw = false
    try {
      nextBuildNumber(187, bad)
    } catch {
      threw = true
    }
    if (!threw) throw new Error(`nextBuildNumber should reject latest=${JSON.stringify(bad)}`)
  }
  const url = latestBuildsUrl('APP-ID')
  if (
    !url.startsWith(`${ASC_BASE}/builds?`) ||
    !url.includes('filter[app]=APP-ID') ||
    !url.includes('sort=-uploadedDate')
  ) {
    throw new Error(`latestBuildsUrl is not List Builds: ${url}`)
  }
  if (url.includes('preReleaseVersions')) {
    throw new Error(`latestBuildsUrl must not use preReleaseVersions: ${url}`)
  }
  console.log('appstore-next-build-number self-test ok')
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function die(reason) {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  process.stderr.write(`[appstore-next-build-number] ${message}\n`)
  process.exit(1)
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeJwt(keyId, issuerId, keyPath) {
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

const isMain = process.argv[1] && process.argv[1].endsWith('appstore-next-build-number.mjs')

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
  const bundleId = arg('bundle-id')
  const version = arg('version')
  const proposed = Number(arg('proposed'))
  const keyId = arg('key-id')
  const issuerId = arg('issuer-id')
  const keyPath = arg('key-path')

  if (!bundleId || !version || !Number.isFinite(proposed) || !keyId || !issuerId || !keyPath) {
    die(
      'usage: appstore-next-build-number.mjs --bundle-id --version --proposed --key-id --issuer-id --key-path'
    )
  }

  try {
    const token = makeJwt(keyId, issuerId, keyPath)
    const apps = await get(
      `${ASC_BASE}/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
      token
    )
    const appId = apps.data?.[0]?.id
    if (!appId) throw new Error(`no app found for bundle id ${bundleId}`)

    const builds = await get(latestBuildsUrl(appId), token)
    if (!Array.isArray(builds.data)) {
      throw new Error(`List Builds returned no data array for app ${appId}`)
    }

    let latestUploaded = null
    if (builds.data.length > 0) {
      const raw = builds.data[0]?.attributes?.version
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) {
        throw new Error(`latest uploaded build version is not a number: ${JSON.stringify(raw)}`)
      }
      latestUploaded = parsed
    }

    const final = nextBuildNumber(proposed, latestUploaded)
    if (final !== proposed) {
      process.stderr.write(
        `[appstore-next-build-number] build ${proposed} already used` +
          ` (latest uploaded for ${version}: ${latestUploaded}) — bumping to ${final}\n`
      )
    }
    process.stdout.write(String(final))
  } catch (err) {
    die(err)
  }
}
