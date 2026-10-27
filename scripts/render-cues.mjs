// Render the interval timer's cues to the WAVs the iOS plugin bundles.
// Run: npm run cues:render   (after changing src/engine/cueSound.ts)
//
// The browser renders the same design live; these files are the native copy.
// src/engine/cueSound.check.ts fails if they drift from the design.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CUE_NAMES, CUE_FILE_RATE, renderCue, encodeWav } from '../src/engine/cueSound.ts'

const dir = new URL('../plugins/zeroed-cues/ios/Sources/ZeroedCuesPlugin/Sounds/', import.meta.url)
for (const name of CUE_NAMES) {
  const wav = encodeWav(renderCue(name, CUE_FILE_RATE), CUE_FILE_RATE)
  writeFileSync(new URL(`${name}.wav`, dir), wav)
  console.log(`${name}.wav  ${(wav.length / 1024).toFixed(1)} KB`)
}
console.log(`→ ${fileURLToPath(dir)}`)
