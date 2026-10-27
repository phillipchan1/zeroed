// The interval timer's voice: the 3-2-1, the go, the rest, the finish.
//
// The rest timer gets away with a fresh AudioContext per beep because the
// athlete has just tapped a set — the gesture is seconds old. An interval block
// is twenty minutes of cues with no tap anywhere near most of them, and iOS
// starts a context created outside a gesture suspended, with no way to wake it.
// So there is ONE context, created and unlocked by the tap that starts the
// block (primeCueAudio, called from the button's click handler — including the
// Train tab's, a screen before the timer exists), and every cue plays on it.
//
// The palette is the brand's: short sine figures. Work resolves UP (the same
// rising fifth as a PR), rest falls away, the finish is the session chord.
// Haptics carry every cue too, so a muted phone or a loud gym still gets it.

import { tick, record, alert, success } from './haptics'

const SOUND_KEY = 'zeroed.interval_sound'

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext }

let ctx: AudioContext | null = null

/** On by default: an interval timer you have to watch is a stopwatch. */
export function intervalSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setIntervalSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch { /* non-persistent session */ }
}

/**
 * Create (or wake) the shared context. Call it synchronously inside a tap
 * handler — that is what unlocks audio on iOS for the rest of the block.
 */
export function primeCueAudio(): void {
  try {
    const Ctor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext
    if (!Ctor) return
    if (!ctx || ctx.state === 'closed') ctx = new Ctor()
    void ctx.resume().catch(() => {})
    // A one-sample silent buffer, played inside the gesture: older WebKit only
    // counts the context as unlocked once something has actually played on it.
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
  } catch { /* no audio here — haptics and the screen carry the cues */ }
}

/** Let the hardware go once the block is over; a held context can duck music. */
export function releaseCueAudio(): void {
  const c = ctx
  ctx = null
  if (c) void c.close().catch(() => {})
}

/** `[offset s, Hz, peak gain, length s]` per tone, on the shared context. */
function tones(spec: [number, number, number, number][]): void {
  if (!intervalSoundOn()) return
  try {
    if (!ctx || ctx.state === 'closed') primeCueAudio()
    const c = ctx
    if (!c) return
    if (c.state === 'suspended') void c.resume().catch(() => {})
    const now = c.currentTime
    spec.forEach(([offset, hz, peak, len]) => {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(peak, now + offset + Math.min(0.02, len / 4))
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + len - 0.02)
      osc.connect(gain).connect(c.destination)
      osc.start(now + offset)
      osc.stop(now + offset + len)
    })
  } catch { /* audio refused — the haptic still lands */ }
}

/** The three seconds before a change: one dry blip each. */
export function cueCount(): void {
  tones([[0, 880, 0.22, 0.09]])
  tick()
}

/** Work starts: a rising fifth, louder than anything else in the app. */
export function cueGo(): void {
  tones([[0, 988, 0.3, 0.12], [0.1, 1480, 0.32, 0.26]])
  record()
}

/** Rest starts: the same interval, falling away. */
export function cueRest(): void {
  tones([[0, 784, 0.24, 0.14], [0.12, 523, 0.22, 0.26]])
  alert()
}

/** The block is done: the session chord, closing onto the octave. */
export function cueDone(): void {
  tones([[0, 523, 0.22, 0.16], [0.12, 784, 0.22, 0.16], [0.24, 1047, 0.26, 0.4]])
  success()
}
