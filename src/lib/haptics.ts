import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

// Three weights of physical feedback, one per kind of moment, so the phone in
// your hand says what happened without you looking at it:
//
//   tick()    — a set logged. Light; it happens a dozen times a session.
//   record()  — a PR typed. Heavy; it should feel different from a set.
//   success() — a session finished. The system "success" pattern.
//   alert()   — rest's up. The system "warning" pattern: you're needed.
//
// @capacitor/haptics drives the Taptic Engine in the iOS shell and falls back to
// navigator.vibrate on the web (Android); iOS Safari has neither, so there it's a
// silent no-op and the on-screen motion carries the moment alone. Fire and
// forget: feedback must never throw into, or wait on, the logging path.
function fire(call: () => Promise<unknown>): void {
  try {
    call().catch(() => { /* unsupported here — the visual is enough */ })
  } catch { /* same */ }
}

export function tick(): void {
  fire(() => Haptics.impact({ style: ImpactStyle.Light }))
}

export function record(): void {
  fire(() => Haptics.impact({ style: ImpactStyle.Heavy }))
}

export function success(): void {
  fire(() => Haptics.notification({ type: NotificationType.Success }))
}

export function alert(): void {
  fire(() => Haptics.notification({ type: NotificationType.Warning }))
}
