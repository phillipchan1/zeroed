#!/usr/bin/env node
// Revoke Apple Development certificates that CI created and then lost.
//
// Each GitHub runner that signs with -allowProvisioningUpdates mints an
// "Apple Development: Created via API" certificate. The private key dies
// with the runner, but the certificate still counts. Once the account is
// full, the next archive stops with "Choose a certificate to revoke" and
// never uploads. Distribution certificates are left alone — Nuvo shares
// this team and still needs them.
//
// Usage:
//   node scripts/asc-revoke-api-dev-certs.mjs \
//     --key-id XXXX --issuer-id YYYY --key-path /path/AuthKey.p8

import { readFileSync } from 'node:fs'
import { createSign, createPrivateKey } from 'node:crypto'

const DEV_TYPES = new Set(['DEVELOPMENT', 'IOS_DEVELOPMENT'])

export function isStaleApiDevCert(attrs) {
  if (!attrs || !DEV_TYPES.has(attrs.certificateType)) return false
  const label = `${attrs.name ?? ''}\n${attrs.displayName ?? ''}`
  return /via api/i.test(label)
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
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
  const signature = createSign('SHA256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64url(signature)}`
}

async function get(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}: ${await res.text()}`)
  return res.json()
}

async function listCertificates(token) {
  const all = []
  let url = 'https://api.appstoreconnect.apple.com/v1/certificates?limit=200'
  while (url) {
    const page = await get(url, token)
    all.push(...(page.data ?? []))
    url = page.links?.next ?? null
  }
  return all
}

const isMain = process.argv[1] && process.argv[1].endsWith('asc-revoke-api-dev-certs.mjs')

if (isMain && process.argv.includes('--self-test')) {
  const api = { certificateType: 'DEVELOPMENT', name: 'Apple Development: Created via API', displayName: 'Created via API' }
  const person = { certificateType: 'DEVELOPMENT', name: 'Apple Development: Phillip Chan', displayName: 'Phillip Chan' }
  const dist = { certificateType: 'DISTRIBUTION', name: 'Apple Distribution: Created via API', displayName: 'Created via API' }
  if (!isStaleApiDevCert(api) || isStaleApiDevCert(person) || isStaleApiDevCert(dist)) {
    console.error('self-test failed')
    process.exit(1)
  }
  console.log('asc-revoke-api-dev-certs self-test ok')
  process.exit(0)
}

if (isMain) {
  const keyId = arg('key-id')
  const issuerId = arg('issuer-id')
  const keyPath = arg('key-path')
  if (!keyId || !issuerId || !keyPath) {
    console.error('usage: asc-revoke-api-dev-certs.mjs --key-id --issuer-id --key-path')
    process.exit(1)
  }

  const token = makeJwt(keyId, issuerId, keyPath)
  const certs = await listCertificates(token)
  for (const cert of certs) {
    const a = cert.attributes ?? {}
    console.log(`cert ${a.certificateType ?? '?'} | ${a.name ?? ''} | ${a.displayName ?? ''} | expires ${a.expirationDate ?? '?'}`)
  }
  const stale = certs.filter((c) => isStaleApiDevCert(c.attributes))
  if (stale.length === 0) {
    console.log('No API-created development certificates to revoke.')
    process.exit(0)
  }
  for (const cert of stale) {
    const res = await fetch(`https://api.appstoreconnect.apple.com/v1/certificates/${cert.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok && res.status !== 204) {
      throw new Error(`revoke ${cert.id} failed: ${res.status} ${await res.text()}`)
    }
    console.log(`Revoked ${cert.attributes?.name ?? cert.id}`)
  }
  console.log(`Revoked ${stale.length} API-created development certificate(s).`)
}
