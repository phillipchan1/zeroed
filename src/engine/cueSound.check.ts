// Standalone integrity check for the interval cues (no test runner installed,
// same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/cueSound.check.ts
//
// The properties that matter:
//
//   · every cue is loud and never clips — the same peak, short enough to sit
//     inside a 3-2-1 without overlapping the next tick
//   · the go locks: its twin tones are apart at the start and one note at the end
//   · rest releases: one note at the start, two apart at the end
//   · the WAVs the iPhone plays are the design, not a stale render of an older one

import { readFileSync } from 'node:fs'
import {
  CUE_NAMES, CUE_PEAK, CUE_FILE_RATE, renderCue, cueSeconds, encodeWav, decodeWav, type CueName,
} from './cueSound.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const RATE = 48000

// ---- 1. loud, clean, short ----------------------------------------------------

for (const name of CUE_NAMES) {
  const s = renderCue(name, RATE)
  let peak = 0
  let finite = true
  for (const x of s) { if (!Number.isFinite(x)) finite = false; peak = Math.max(peak, Math.abs(x)) }
  ok(finite, `${name}: every sample is a number`)
  ok(Math.abs(peak - CUE_PEAK) < 1e-6, `${name}: normalised to the shared peak (${peak.toFixed(4)})`)
  ok(Math.abs(s[0]) < 0.05 && Math.abs(s[s.length - 1]) < 0.01, `${name}: starts and ends near silence — no click`)
  // Loud where it counts: the first 100 ms carries real energy.
  let rms = 0
  const early = Math.min(s.length, Math.round(0.1 * RATE))
  for (let i = 0; i < early; i++) rms += s[i] * s[i]
  rms = Math.sqrt(rms / early)
  // The halfway ping is two light pings with a gap — present, deliberately not a go.
  ok(rms > (name === 'half' ? 0.12 : 0.2), `${name}: hits hard up front (rms ${rms.toFixed(2)})`)
}
for (const n of ['count-3', 'count-2', 'count-1', 'half'] as CueName[]) {
  ok(cueSeconds(n) < 0.3, `${n} is short enough to sit inside a one-second count`)
}
ok(cueSeconds('go') < 0.8 && cueSeconds('rest') < 0.8, 'go and rest are under a second')
ok(cueSeconds('done') > cueSeconds('go'), 'done is the long one')

const deterministic = renderCue('go', RATE)
const again = renderCue('go', RATE)
ok(deterministic.every((x, i) => x === again[i]), 'rendering is deterministic')

// ---- 2. the motif: lock and release ------------------------------------------
// The twins beating against each other make the envelope wobble; locked, it
// decays smoothly. Measure the wobble as how often short-window loudness rises.

function wobble(s: Float32Array, from: number, to: number): number {
  const win = Math.round(0.004 * RATE)
  let rises = 0
  let prev = Infinity
  let windows = 0
  for (let i = Math.round(from * RATE); i + win < Math.round(to * RATE); i += win) {
    let e = 0
    for (let j = 0; j < win; j++) e = Math.max(e, Math.abs(s[i + j]))
    if (e > prev * 1.03) rises++
    prev = e
    windows++
  }
  return rises / Math.max(1, windows)
}
const go = renderCue('go', RATE)
ok(wobble(go, 0.01, 0.12) > wobble(go, 0.25, 0.4) + 0.05,
  `go locks: beating early (${wobble(go, 0.01, 0.12).toFixed(2)}) settles to a steady tone (${wobble(go, 0.25, 0.4).toFixed(2)})`)
const rest = renderCue('rest', RATE)
ok(wobble(rest, 0.3, 0.45) > wobble(rest, 0.01, 0.08),
  `rest releases: steady at first (${wobble(rest, 0.01, 0.08).toFixed(2)}), beating as it falls apart (${wobble(rest, 0.3, 0.45).toFixed(2)})`)

// ---- 3. WAV round trip --------------------------------------------------------

const src = renderCue('count-1', CUE_FILE_RATE)
const wav = encodeWav(src, CUE_FILE_RATE)
ok(String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE', 'a RIFF/WAVE file')
const back = decodeWav(wav)
ok(back.sampleRate === CUE_FILE_RATE && back.samples.length === src.length, 'rate and length survive the round trip')
ok(back.samples.every((x, i) => Math.abs(x - src[i]) < 2 / 32767), 'samples survive to within one step of 16 bits')

// ---- 4. the bundled files are this design --------------------------------------

for (const name of CUE_NAMES) {
  const url = new URL(`../../plugins/zeroed-cues/ios/Sources/ZeroedCuesPlugin/Sounds/${name}.wav`, import.meta.url)
  let file: Uint8Array | null = null
  try { file = new Uint8Array(readFileSync(url)) } catch { /* missing */ }
  ok(file != null, `${name}.wav is bundled — run npm run cues:render`)
  if (!file) continue
  const { sampleRate, samples } = decodeWav(file)
  const fresh = renderCue(name, CUE_FILE_RATE)
  const same = sampleRate === CUE_FILE_RATE && samples.length === fresh.length
    && samples.every((x, i) => Math.abs(x - fresh[i]) < 3 / 32767)
  ok(same, `${name}.wav matches the design — run npm run cues:render after changing cueSound.ts`)
}

if (fails.length) {
  console.error(`cueSound.check: ${fails.length} of ${checks} failed`)
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`cueSound.check: ${checks} checks passed`)
