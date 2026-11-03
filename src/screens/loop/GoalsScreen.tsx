import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, SectionHeader, Skeleton, Button, Input, Sheet, Chip } from '../../components/ui'
import { useCachedLoader, mutateCache } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalsView, logMeasurement, type GoalView } from '../../lib/tracksData'
import { progressRatio } from '../../engine/goals'

function statusTone(status: string): 'done' | 'pending' | 'todo' {
  if (status === 'hit') return 'done'
  if (status === 'behind') return 'todo'
  return 'pending'
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-xs text-dim">No history yet</span>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 88
  const h = 28
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / span) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="goal-spark">
      <polyline fill="none" strokeWidth="1.75" points={pts} style={{ stroke: 'var(--computing)' }} />
    </svg>
  )
}

function GoalBar({ goal }: { goal: GoalView }) {
  const ratio = progressRatio(goal)
  const pct = ratio == null ? 0 : Math.round(ratio * 100)
  return (
    <div className="goal-bar" aria-label={`${pct}% of target`}>
      <div className="goal-bar__fill" style={{ width: `${pct}%` }} />
      <span className="goal-bar__mark goal-bar__mark--base" title="Baseline" />
      <span className="goal-bar__label">{goal.baseline ?? '—'}</span>
      <span className="goal-bar__label goal-bar__label--end">{goal.target ?? '—'}</span>
    </div>
  )
}

export function GoalsScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const key = cacheKeys.goals(athleteId)
  const { data, loading } = useCachedLoader<GoalView[]>(key, () => fetchGoalsView(athleteId))
  const [sheet, setSheet] = useState<GoalView | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const pairs = useMemo(() => {
    const groups = new Map<string, GoalView[]>()
    for (const g of data ?? []) {
      const list = groups.get(g.pair) ?? []
      list.push(g)
      groups.set(g.pair, list)
    }
    return [...groups.values()]
  }, [data])

  function openLog(g: GoalView) {
    setSheet(g)
    setValue(g.current != null ? String(g.current) : '')
  }

  function save() {
    if (!sheet) return
    const n = Number(value)
    if (!Number.isFinite(n)) return
    const date = new Date().toISOString().slice(0, 10)
    setSaving(true)
    void logMeasurement({
      athleteId, goalId: sheet.id, value: n, date, side: sheet.side,
    }).then(() => {
      mutateCache<GoalView[]>(key, (list) => list)
      return fetchGoalsView(athleteId)
    }).then((next) => {
      mutateCache<GoalView[]>(key, () => next)
      setSheet(null)
      setSaving(false)
    }, () => setSaving(false))
  }

  return (
    <div className="screen with-nav">
      <div className="page">
        <div className="page__main">
          <PageHeader eyebrow="The target" title="Goals" />
          {loading && !data ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Skeleton height={16} width={120} /><Skeleton height={28} width="100%" />
            </div>
          ) : !pairs.length ? (
            <div className="card">
              <p className="text-base text-dim">No structured goals yet. The coach can add them, or they land with the first block.</p>
            </div>
          ) : (
            pairs.map((group) => (
              <div key={group[0].pair} className="card fade-rise" style={{ marginBottom: 16 }}>
                <div className="goal-pair">
                  {group.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="goal-card"
                      onClick={() => openLog(g)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                        <span className="text-base" style={{ fontWeight: 600 }}>{g.name}</span>
                        <Chip tone={statusTone(g.computed)}>{g.computed.replace('_', ' ')}</Chip>
                      </div>
                      <p className="num text-sm" style={{ marginTop: 8 }}>
                        {g.current != null ? `${g.current}${g.unit ?? ''}` : 'pending'}
                        <span className="text-dim"> → {g.target != null ? `${g.target}${g.unit ?? ''}` : '—'}</span>
                      </p>
                      <GoalBar goal={g} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                        <Sparkline values={g.history.filter((h) => !h.client_key?.startsWith('seed:')).map((h) => h.value)} />
                        <span className="num text-xs text-dim">
                          {g.last_measured ? `last ${g.last_measured}` : 'no measurement'}
                          {g.due_date ? ` · due ${g.due_date.slice(5)}` : ''}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
          <button type="button" className="program-edit-cta program-edit-cta--quiet" onClick={() => navigate('/app/program')}>
            <span className="program-edit-cta__title">Back to the week</span>
            <span className="program-edit-cta__chev">›</span>
          </button>
        </div>
      </div>
      {sheet && (
        <Sheet title={`Log ${sheet.name}`} onClose={() => setSheet(null)} actions={
          <Button variant="primary" full disabled={saving} onClick={save}>Save measurement</Button>
        }>
          <SectionHeader>Today</SectionHeader>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="decimal"
            placeholder={sheet.unit ? `Value in ${sheet.unit}` : 'Value'}
          />
          {sheet.test_protocol && (
            <p className="text-sm text-dim" style={{ marginTop: 14, lineHeight: 1.5 }}>{sheet.test_protocol}</p>
          )}
        </Sheet>
      )}
    </div>
  )
}
