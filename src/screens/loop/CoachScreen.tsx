// TODO Prompt 3 — Coach tab (AI agent interface)
// Will show: real-time coach messages driven by the 8 AI agents,
// the insight promotion feed (draft → insight pipeline), weekly review reveals,
// and natural language Q&A with the athlete's performance data as context.

import { SectionHeader } from '../../components/ui'

export function CoachScreen() {
  return (
    <div className="screen with-nav">
      <div style={{ padding: '24px 20px', maxWidth: 480, margin: '0 auto' }}>
        <p className="text-xs text-dim" style={{
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontFamily: 'var(--font-mono)',
          marginBottom: 4,
        }}>
          Coach
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>04 // COACH</h2>

        <div className="card" style={{ opacity: 0.5 }}>
          <SectionHeader>Coming in Prompt 3</SectionHeader>
          <p className="text-sm text-dim" style={{ marginTop: 8, lineHeight: 1.6 }}>
            AI coaching interface — 8 agents, insight promotion pipeline,
            weekly review reveals, and performance Q&A built here.
          </p>
        </div>
      </div>
    </div>
  )
}
