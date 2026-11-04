import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Skeleton } from '../../components/ui'
import { useCachedLoader } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalsView, type GoalView } from '../../lib/tracksData'
import { isSeedMeasurement } from '../../engine/goals'
import { GoalBar, GoalStatus, goalValue, shortDate, Sparkline } from './goalsUi'

export function GoalsScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { data, loading } = useCachedLoader<GoalView[]>(cacheKeys.goals(athleteId), () => fetchGoalsView(athleteId))

  const pairs = useMemo(() => {
    const groups = new Map<string, GoalView[]>()
    for (const g of data ?? []) {
      const list = groups.get(g.pair) ?? []
      list.push(g)
      groups.set(g.pair, list)
    }
    return [...groups.values()]
  }, [data])

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
                      onClick={() => navigate(`/app/goals/${g.id}`)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                        <span className="text-base" style={{ fontWeight: 600 }}>{g.name}</span>
                        <GoalStatus display={g.display} />
                      </div>
                      <p className="num text-sm" style={{ marginTop: 8 }}>
                        {g.current != null ? goalValue(g.current, g.unit) : 'pending'}
                        <span className="text-dim"> → {goalValue(g.target, g.unit)}</span>
                      </p>
                      <GoalBar goal={g} display={g.display} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 10 }}>
                        <Sparkline values={g.history.filter((h) => !isSeedMeasurement(h)).map((h) => h.value)} />
                        <span className="text-xs text-dim" style={{ textAlign: 'right' }}>
                          {g.last_measured ? `Last ${shortDate(g.last_measured)}` : 'Not measured yet'}
                          {g.due_date ? ` · due ${shortDate(g.due_date)}` : ''}
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
    </div>
  )
}
