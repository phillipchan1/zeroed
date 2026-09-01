// The rest timer's end-of-rest signal.
//
// The clock was silent, which makes it useless for the one thing it is for:
// knowing when to lift again WITHOUT looking at your phone. So it beeps.
//
// Two mechanisms, because neither is reliable alone:
//   · a short WebAudio tone — works everywhere, and the athlete has just tapped
//     a set complete, so the autoplay gesture requirement is satisfied
//   · navigator.vibrate — silent, better in a loud gym, and NOT supported on
//     iOS at all, which is exactly why it can't be the only one
//
// Both are best-effort: a browser that refuses either must never break the
// timer, so every call is wrapped.

const KEY = 'zeroed.rest_alert'

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

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext }

/** Two short rising tones — audible over a gym without being an alarm. */
function beep(): void {
  try {
    const Ctor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const now = ctx.currentTime
    ;[0, 0.18].forEach((offset, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = i === 0 ? 660 : 880
      // Ramped, not switched: a square edge on a phone speaker is a click.
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.16)
    })
    // Release the hardware once the sound is done; a context left open on iOS
    // holds the audio session and can duck the athlete\'s music indefinitely.
    setTimeout(() => { void ctx.close().catch(() => {}) }, 600)
  } catch {
    /* no audio available — the vibrate below may still land */
  }
}

/** Fire the end-of-rest signal. Safe to call from a timer tick. */
export function fireRestAlert(): void {
  if (!restAlertEnabled()) return
  beep()
  try {
    navigator.vibrate?.([120, 60, 120])
  } catch {
    /* unsupported (every iOS browser) — the beep carries it */
  }
}
