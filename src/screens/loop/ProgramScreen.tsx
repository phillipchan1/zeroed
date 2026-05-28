// TODO Prompt 2 — Program tab
// Will show: phase timeline, weekly structure, routine cards with exercise lists,
// advancement criteria progress, and phase transition triggers.

import { SectionHeader } from '../../components/ui'

export function ProgramScreen() {
  return (
    <div className="screen with-nav">
      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto' }}>
        <p className="text-xs text-dim" style={{
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontFamily: 'var(--font-mono)',
          marginBottom: 4,
        }}>
          Program
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>03 // PROGRAM</h2>

        <div className="card" style={{ opacity: 0.5 }}>
          <SectionHeader>Coming in Prompt 2</SectionHeader>
          <p className="text-sm text-dim" style={{ marginTop: 8, lineHeight: 1.6 }}>
            Phase timeline, weekly structure, routine cards, advancement criteria progress,
            and phase transition triggers will be built here.
          </p>
        </div>
      </div>
    </div>
  )
}
