// One light tick for a confirmed action (a set logged). Where the platform has
// no vibration — iOS Safari and the WKWebView shell both ignore it — this is a
// silent no-op, and the visual snap carries the moment alone.
//
// Kept behind one function so the Capacitor shell can swap in a native impact
// (@capacitor/haptics) later without touching a call site.
export function tick(): void {
  try { navigator.vibrate?.(12) } catch { /* unsupported — the visual is enough */ }
}
