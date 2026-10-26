// The rest timer's end-of-rest signal.
//
// The clock was silent, which makes it useless for the one thing it is for:
// knowing when to lift again WITHOUT looking at your phone. So it beeps.
//
// Two mechanisms, because neither is reliable alone:
//   · a short WebAudio tone — works everywhere, and the athlete has just tapped
//     a set complete, so the autoplay gesture requirement is satisfied
//   · a haptic buzz — silent, better in a loud gym. Native in the iOS shell
//     (@capacitor/haptics); navigator.vibrate on the web, which iOS Safari
//     doesn't support at all — exactly why it can't be the only one
//
// Both are best-effort: a browser that refuses either must never break the
// timer, so every call is wrapped.

import { alert as hapticAlert } from './haptics'

const KEY = 'zeroed.rest_alert'
const CLICK_KEY = 'zeroed.set_click'

/** Off is a deliberate choice; the default is on, because a silent timer is a stopwatch. */
export function restAlertEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setRestAlertEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* ignore — non-persistent session */
  }
}

/** Sound effects are opt-in: a sound a dozen times a session is a lot to
 *  assume, and every Web Audio play can duck the athlete's own music. One switch
 *  for the whole set: the set click, the PR chime, the finish chord. */
export function setClickEnabled(): boolean {
  try {
    return localStorage.getItem(CLICK_KEY) === 'on'
  } catch {
    return false
  }
}

export function setSetClickEnabled(on: boolean): void {
  try {
    localStorage.setItem(CLICK_KEY, on ? 'on' : 'off')
  } catch {
    /* ignore — non-persistent session */
  }
}

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext }

/** Short sine tones — `[offset s, Hz, peak gain, length s]` each. */
function tones(spec: [number, number, number, number][]): void {
  try {
    const Ctor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const now = ctx.currentTime
    spec.forEach(([offset, hz, peak, len]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz
      // Ramped, not switched: a square edge on a phone speaker is a click.
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(peak, now + offset + Math.min(0.02, len / 4))
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + len - 0.02)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + len)
    })
    // Release the hardware once the sound is done; a context left open on iOS
    // holds the audio session and can duck the athlete\'s music indefinitely.
    setTimeout(() => { void ctx.close().catch(() => {}) }, 600)
  } catch {
    /* no audio available — the haptic may still land */
  }
}

/** Two short rising tones — audible over a gym without being an alarm. */
function beep(): void {
  tones([[0, 660, 0.25, 0.16], [0.18, 880, 0.25, 0.16]])
}

// The sound palette is the brand's one gesture, in pitch: things CONVERGE. Every
// effect is a short sine figure resolving upward onto a target — instrument
// tones, not game sounds — and none is longer than half a second.

/** A set locked in: one soft, high, very short tick. */
export function playSetClick(): void {
  if (!setClickEnabled()) return
  tones([[0, 1760, 0.08, 0.05]])
}

/** A PR typed: a quick rising fifth, brighter than a set, still small. */
export function playRecord(): void {
  if (!setClickEnabled()) return
  tones([[0, 988, 0.12, 0.09], [0.08, 1480, 0.14, 0.16]])
}

/** Session zeroed: three notes closing onto the octave — the lock. */
export function playZeroed(): void {
  if (!setClickEnabled()) return
  tones([[0, 523, 0.12, 0.14], [0.1, 784, 0.12, 0.14], [0.2, 1047, 0.15, 0.28]])
}

/** Fire the end-of-rest signal. Safe to call from a timer tick. */
export function fireRestAlert(): void {
  if (!restAlertEnabled()) return
  beep()
  hapticAlert()
}
