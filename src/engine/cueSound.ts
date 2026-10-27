// =============================================================================
// CUE SOUND — the interval timer's voice, designed once and rendered sample by
// sample, so the phone's native player and the browser play the same audio.
//
// The motif is ZERO-BEAT. Two tones a few percent apart beat against each
// other; tuned together, the beat slows and stops — "zero-beating" is how a
// radio operator locks onto a signal. It is the wordmark as sound: every work
// cue starts slightly off and converges onto its note. Rest is the same move in
// reverse, a unison coming apart and falling away. The 3-2-1 climbs toward the
// note the go will lock onto, so the count itself sounds like closing in.
//
// Built to be heard over an assault bike and a playlist, not a quiet room:
// mid-high fundamentals a phone speaker reproduces well, an octave partial for
// presence, a soft saturation for loudness without clipping, every cue
// normalised to the same peak.
//
// Pure, no I/O (see cueSound.check.ts). The WAVs the iOS plugin bundles are
// rendered from here by `npm run cues:render`, and the check holds them to it.
// =============================================================================

export type CueName =
  | 'count-3' | 'count-2' | 'count-1'
  | 'go' | 'go-last' | 'rest' | 'half' | 'done'

export const CUE_NAMES: readonly CueName[] = [
  'count-3', 'count-2', 'count-1', 'go', 'go-last', 'rest', 'half', 'done',
]

/** One voice: a tone that glides from one pitch to another under an envelope. */
interface Voice {
  /** Start, seconds into the cue. */
  at: number
  /** Length, seconds. */
  dur: number
  /** Pitch at the start, Hz. */
  from: number
  /** Pitch it converges onto, Hz. */
  to: number
  /** Seconds the glide takes (exponential, so it lands the way an ear hears it). */
  glide: number
  /** Peak amplitude before mixing. */
  gain: number
  /** Attack, seconds. Everything decays exponentially after it. */
  attack: number
}

// The notes. The count climbs C6 → D6 → E6 and the go locks on G6, a fifth
// above where it started: rising, and resolving.
const C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98, A6 = 1760, C7 = 2093, D7 = 2349.32

// A lock: the note, plus a twin starting `spread` sharp that glides onto it,
// plus the octave arriving the same way. The beat between the twins is what
// you hear slow down and stop.
function lock(note: number, at: number, dur: number, gain: number, spread = 0.045, glide = 0.16): Voice[] {
  return [
    { at, dur, from: note, to: note, glide: 0.001, gain, attack: 0.004 },
    { at, dur, from: note * (1 + spread), to: note, glide, gain: gain * 0.85, attack: 0.004 },
    { at, dur: dur * 0.8, from: note * 2 * (1 - spread / 2), to: note * 2, glide, gain: gain * 0.28, attack: 0.006 },
  ]
}

// A tick: short, a touch sharp and dropping into pitch — a detent clicking home.
function tick(note: number): Voice[] {
  return [
    { at: 0, dur: 0.12, from: note * 1.06, to: note, glide: 0.025, gain: 1, attack: 0.002 },
    { at: 0, dur: 0.08, from: note * 2.1, to: note * 2, glide: 0.02, gain: 0.22, attack: 0.002 },
  ]
}

const DESIGN: Record<CueName, Voice[]> = {
  'count-3': tick(C6),
  'count-2': tick(D6),
  'count-1': tick(E6),

  // Work: the lock onto G6.
  go: lock(G6, 0, 0.62, 0.9),

  // The last round locks a chord, not a note — G6 and the D7 above it,
  // converging from opposite sides. It should feel like the final push.
  'go-last': [
    ...lock(G6, 0, 0.85, 0.75),
    ...lock(D7, 0.02, 0.8, 0.55, -0.045, 0.2),
  ],

  // Rest: one note coming apart and falling away — the lock, released.
  rest: [
    { at: 0, dur: 0.55, from: D6, to: A6 / 2, glide: 0.34, gain: 0.8, attack: 0.006 },
    { at: 0, dur: 0.55, from: D6, to: (A6 / 2) * 1.06, glide: 0.34, gain: 0.7, attack: 0.006 },
  ],

  // Halfway through a long round: two light pings, high and brief.
  half: [
    { at: 0, dur: 0.07, from: A6, to: A6, glide: 0.001, gain: 0.7, attack: 0.002 },
    { at: 0.11, dur: 0.09, from: A6, to: A6, glide: 0.001, gain: 0.7, attack: 0.002 },
  ],

  // Done: the session chord, every note zero-beating in, one after another.
  done: [
    ...lock(C6, 0, 1.15, 0.6, 0.04, 0.2),
    ...lock(G6, 0.11, 1.05, 0.5, 0.04, 0.2),
    ...lock(C7, 0.22, 0.95, 0.42, 0.04, 0.2),
  ],
}

/** Peak every cue is normalised to: -1 dBFS, loud and never clipped. */
export const CUE_PEAK = 0.89

/** Seconds a cue lasts, tail included. */
export function cueSeconds(name: CueName): number {
  return Math.max(...DESIGN[name].map((v) => v.at + v.dur)) + 0.01
}

/**
 * The cue as samples, mono, at `sampleRate`. Deterministic: the same name and
 * rate always give the same samples.
 */
export function renderCue(name: CueName, sampleRate: number): Float32Array {
  const voices = DESIGN[name]
  const n = Math.ceil(cueSeconds(name) * sampleRate)
  const out = new Float32Array(n)
  for (const v of voices) {
    const start = Math.round(v.at * sampleRate)
    const len = Math.round(v.dur * sampleRate)
    const decay = Math.log(1000) / Math.max(0.001, v.dur - v.attack)   // -60 dB by the end
    const ratio = v.to / v.from
    let phase = 0
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sampleRate
      const freq = v.from * Math.pow(ratio, Math.min(1, t / v.glide))
      phase += (2 * Math.PI * freq) / sampleRate
      const env = t < v.attack ? t / v.attack : Math.exp(-decay * (t - v.attack))
      // The last 4 ms ramp to silence, so a voice never ends on a click.
      const tail = Math.min(1, (len - i) / (0.004 * sampleRate))
      out[start + i] += Math.sin(phase) * env * tail * v.gain
    }
  }
  // Soft saturation for loudness, then the shared peak.
  let peak = 0
  for (let i = 0; i < n; i++) {
    out[i] = Math.tanh(out[i] * 1.6)
    peak = Math.max(peak, Math.abs(out[i]))
  }
  const scale = peak > 0 ? CUE_PEAK / peak : 0
  for (let i = 0; i < n; i++) out[i] *= scale
  return out
}

/** 16-bit PCM mono WAV — the file format every native player opens. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)          // PCM chunk size
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, 1, true)           // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)           // block align
  view.setUint16(34, 16, true)          // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return bytes
}

/** The PCM samples back out of a WAV encodeWav wrote, as -1…1. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = view.getUint32(24, true)
  const n = view.getUint32(40, true) / 2
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32767
  return { sampleRate, samples }
}

/** The rate the bundled files are rendered at — ample for a phone speaker, half the bytes. */
export const CUE_FILE_RATE = 22050
