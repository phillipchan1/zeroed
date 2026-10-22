import type { CapacitorConfig } from '@capacitor/cli'

// Bundle ID matches Nuvo's iOS naming (`day.nuvo.app` → `{surface}.{brand}.app`).
// Zeroed has no separate App Store product name, so the surface is `app`.
const config: CapacitorConfig = {
  appId: 'app.zeroed.app',
  appName: 'Zeroed',
  webDir: 'dist',
  backgroundColor: '#0A0A0A',
  ios: {
    // The SPA already pads with env(safe-area-inset-*); don't let WKWebView
    // add a second inset on top.
    contentInset: 'never',
    backgroundColor: '#0A0A0A',
    preferredContentMode: 'mobile',
  },
}

export default config
