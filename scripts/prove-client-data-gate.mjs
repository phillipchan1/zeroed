#!/usr/bin/env node
/**
 * Grep gate: when VITE_API_BASE_URL is the Worker, no live supabase.from()
 * is reachable. Every src call goes through supabaseClient, which swaps in
 * the /api/data facade. Remaining supabase-js entry points are listed as gated.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = 'src'
const fails = []

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const files = walk(root)
const fromFiles = []
const createClientFiles = []
const authFiles = []
const fnFiles = []
const rpcFiles = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (file !== 'src/lib/dataClient.ts' && /\.from\s*\(/.test(text) && /supabase/.test(text)) {
    if (/supabase\.from\s*\(|await supabase\s*\n\s*\.from|supabase\s*\n\s*\.from/.test(text) || /from\('[\w]+'\)/.test(text) && /supabase/.test(text)) {
      if (/supabase/.test(text) && /\.from\(/.test(text)) fromFiles.push(file)
    }
  }
  if (/createClient\s*\(/.test(text)) createClientFiles.push(file)
  if (/supabase\.auth\./.test(text)) authFiles.push(file)
  if (/supabase\.functions\./.test(text)) fnFiles.push(file)
  if (/supabase\.rpc\s*\(/.test(text)) rpcFiles.push(file)
}

const client = readFileSync('src/lib/supabaseClient.ts', 'utf8')
if (!client.includes('isCloudflareApi()')) {
  fails.push('supabaseClient.ts must gate on isCloudflareApi()')
}
if (!client.includes('createDataFacade()')) {
  fails.push('supabaseClient.ts must export createDataFacade() when the API base is set')
}
if (!client.includes('createClient(')) {
  fails.push('supabaseClient.ts must keep createClient for the empty API-base path')
}

for (const file of fromFiles) {
  const text = readFileSync(file, 'utf8')
  if (file === 'src/lib/supabaseClient.ts') continue
  if (file === 'src/lib/dataClient.ts') continue
  const importsClient = /from ['"].*supabaseClient['"]/.test(text) || /from ['"]\.\/supabaseClient['"]/.test(text)
  if (!importsClient) fails.push(`${file}: supabase.from() must import supabase from supabaseClient`)
}

const unexpectedCreate = createClientFiles.filter((f) => f !== 'src/lib/supabaseClient.ts')
if (unexpectedCreate.length) {
  fails.push(`createClient is only allowed in supabaseClient.ts; found ${unexpectedCreate.join(', ')}`)
}

console.log('gated supabase.from() sites (facade when VITE_API_BASE_URL is set):')
for (const f of fromFiles.filter((x) => x !== 'src/lib/supabaseClient.ts')) console.log(`  ${f}`)

console.log('\ngated remaining supabase-js entry points:')
for (const f of authFiles) console.log(`  ${f}  (authClient: !isCloudflareApi → supabase.auth)`)
for (const f of fnFiles) console.log(`  ${f}  (agentClient: agentUrl() empty → functions.invoke)`)
for (const f of rpcFiles) console.log(`  ${f}  (rpc goes through supabase export; cloud → /api/data)`)
console.log(`  src/lib/supabaseClient.ts  (createClient only when API base is empty)`)

if (fails.length) {
  for (const f of fails) console.error('FAIL', f)
  process.exit(1)
}
if (fromFiles.length < 10) {
  console.error('FAIL expected to find the existing supabase.from() call sites')
  process.exit(1)
}
console.log('\nclient data gate: ok')
