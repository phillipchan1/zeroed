import type { ReactNode } from 'react'
import { Logo, PresenceDot } from '../ui'

/**
 * Desktop wrapper for the onboarding *form* steps: a fixed brand panel on the
 * left beside the focused step on the right. On mobile the panel is hidden and
 * the step renders full-bleed exactly as before. Cinematic beats (splash, probe,
 * calibrate) are intentionally left unframed — they own the whole screen.
 */
export function FunnelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="funnel-frame">
      <aside className="funnel-frame__brand">
        <Logo />
        <p className="funnel-brand__tag">
          The instrument for the read.<br />
          Cold data, warm coach — on call.
        </p>
        <span className="funnel-brand__sys"><PresenceDot /> MONITOR</span>
      </aside>
      <div className="funnel-frame__content">{children}</div>
    </div>
  )
}
