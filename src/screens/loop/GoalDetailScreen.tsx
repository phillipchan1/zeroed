import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader, SectionHeader, Skeleton, Button, Input, Sheet, Row, Markdown } from '../../components/ui'
import { useCachedLoader, mutateCache } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalExtras, fetchGoalsView, logMeasurement, type GoalExtras, type GoalView } from '../../lib/tracksData'
import { isSeedMeasurement } from '../../engine/goals'
import { ForecastChart, GoalBar, GoalStatus, goalValue, shortDate } from './goalsUi'
import { TrackGlyph } from './tracksUi'
import { PendingProposals } from './ProposalCard'

const SOURCE_LABEL: Record<string, string> = {
  workout_log: 'from a session',
  manual: 'logged here',
  agent: 'from the coach',
}

/** Today on the phone's own calendar, not UTC: an evening test is still today. */
function deviceToday(): string {
  return new Date().toLocaleDateString('en-CA')
}

function signed(n: number, unit: string | null): string {
  return `${n > 0 ? '+' : ''}${goalValue(n, unit)}`
}

function sideLabel(side: string | null | undefined): string {
  return side === 'L' || side === 'R' ? ` · ${side}` : ''
}

/**
 * One goal: where it stands, what it has done, and what the coach changed for
 * it. Tapping a goal used to open a number field; logging is a button here,
 * and the primary one only when the goal needs a test.
 */
export function GoalDetailScreen({ athleteId }: { athleteId: string }) {
  const { goalId } = useParams<{ goalId: string }>()
  const navigate = useNavigate()
  const key = cacheKeys.goals(athleteId)
  const { data, loading } = useCachedLoader<GoalView[]>(key, () => fetchGoalsView(athleteId))
  const goal = (data ?? []).find((g) => g.id === goalId) ?? null
  const { data: extras } = useCachedLoader<GoalExtras>(
    goal ? cacheKeys.goalExtras(goal.id) : null,
    () => (goal ? fetchGoalExtras(goal) : Promise.resolve({ track: null, moves: [] })),
  )
  const [logging, setLogging] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  function openLog() {
    if (!goal) return
    setValue(goal.current != null ? String(goal.current) : '')
    setLogging(true)
  }

  function save() {
    if (!goal) return
    const n = Number(value)
    if (!value.trim() || !Number.isFinite(n)) return
    setSaving(true)
    void logMeasurement({
      athleteId, goalId: goal.id, value: n, date: deviceToday(), side: goal.side, direction: goal.direction,
    }).then(() => fetchGoalsView(athleteId)).then((next) => {
      mutateCache<GoalView[]>(key, () => next)
      setLogging(false)
      setSaving(false)
    }, () => setSaving(false))
  }

  const real = (goal?.history ?? []).filter((h) => !isSeedMeasurement(h))
  const track = extras?.track ?? null

  return (
    <div className="screen with-nav">
      <div className="page">
        <div className="page__main">
          <PageHeader onBack={() => navigate('/app/goals')} eyebrow={track?.name ?? 'Goal'} title={goal?.name ?? 'Goal'} />
          {loading && !data ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Skeleton height={40} width={140} /><Skeleton height={16} width="100%" />
            </div>
          ) : !goal ? (
            <div className="card"><p className="text-base text-dim">That goal isn’t on your list anymore.</p></div>
          ) : (
            <>
              <div className="card fade-rise" style={{ marginBottom: 20 }}>
                <div className="goal-read">
                  <p className="goal-read__value">
                    {goal.current != null ? goal.current : '—'}
                    {goal.unit && <span className="goal-read__unit">{goal.unit}</span>}
                  </p>
                  <div className="goal-read__side">
                    <GoalStatus display={goal.display} />
                    <span className="text-xs text-dim">
                      target {goalValue(goal.target, goal.unit)}{goal.due_date ? ` · due ${shortDate(goal.due_date)}` : ''}
                    </span>
                  </div>
                </div>
                <GoalBar goal={goal} display={goal.display} />
                <ForecastChart
                  history={real.map((h) => ({ date: h.date, value: h.value }))}
                  target={goal.target != null ? Number(goal.target) : null}
                  due={goal.due_date}
                  forecast={goal.forecast}
                  display={goal.display}
                  unit={goal.unit}
                  direction={goal.direction}
                />
                {goal.forecast && goal.display !== 'zeroed' && (
                  <p className="text-sm" style={{ marginTop: 10, lineHeight: 1.5, color: '#CFCFCF' }}>
                    Forecast <b className="num">{goalValue(goal.forecast.value, goal.unit)}</b>
                    {goal.due_date ? ` on ${shortDate(goal.due_date)}` : ''}, target {goalValue(goal.target, goal.unit)}.
                    {goal.forecast.neededPerWeek != null && (
                      <>
                        {' '}Needs <b className="num">{signed(goal.forecast.neededPerWeek, goal.unit)}</b> a week;
                        {goal.forecast.perWeek === 0
                          ? ` the last ${goal.forecast.points} measurements are flat.`
                          : ` the last ${goal.forecast.points} measurements trend ${signed(goal.forecast.perWeek, goal.unit)} a week.`}
                      </>
                    )}
                  </p>
                )}
                <p className="text-xs text-dim" style={{ marginTop: 8 }}>
                  {goal.last_measured ? `Last measured ${shortDate(goal.last_measured)}` : 'Not measured yet'}
                  {goal.cadence ? ` · ${goal.cadence}` : ''}
                </p>
              </div>

              <PendingProposals athleteId={athleteId} goalId={goal.id} heading={false} />

              {track && (
                <div className="card" style={{ marginBottom: 20, padding: '4px 20px' }}>
                  <Row
                    leading={<span className="text-dim" style={{ display: 'flex' }}><TrackGlyph track={track} size={16} /></span>}
                    title={track.name}
                    sub="The lane that trains this goal"
                    onClick={() => navigate(`/app/program/track/${track.id}`)}
                  />
                </div>
              )}

              {goal.test_protocol && (
                <div className="card" style={{ marginBottom: 20 }}>
                  <SectionHeader>How to test</SectionHeader>
                  <p className="text-sm" style={{ marginTop: 10, lineHeight: 1.55 }}>{goal.test_protocol}</p>
                </div>
              )}

              <div className="card" style={{ marginBottom: 20 }}>
                <SectionHeader>Measurements</SectionHeader>
                {real.length ? (
                  <div style={{ marginTop: 6 }}>
                    {real.slice().reverse().slice(0, 12).map((m, i) => (
                      <div key={`${m.date}-${m.side ?? ''}-${i}`} className="goal-log-row">
                        <span className="text-sm">
                          {shortDate(m.date)}
                          <span className="text-dim">{sideLabel(m.side)} · {SOURCE_LABEL[m.source] ?? m.source}</span>
                        </span>
                        <span className="num text-sm">{goalValue(m.value, goal.unit)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-dim" style={{ marginTop: 10 }}>Nothing logged yet. A test sets the baseline the bar measures from.</p>
                )}
              </div>

              <div className="card" style={{ marginBottom: 24 }}>
                <SectionHeader>Coach moves</SectionHeader>
                {extras?.moves.length ? (
                  <div style={{ marginTop: 6 }}>
                    {extras.moves.map((m) => (
                      <div key={m.id} className="goal-log-row goal-log-row--move">
                        <Markdown className="text-sm" text={m.body} style={{ lineHeight: 1.5 }} />
                        <span className="text-xs text-dim">{shortDate(new Date(m.created_at).toLocaleDateString('en-CA'))}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-dim" style={{ marginTop: 10 }}>No changes yet. When the coach changes this goal or its lane, the change and the reason land here.</p>
                )}
              </div>

              <Button variant={goal.display === 'needs_test' ? 'primary' : 'outline'} full onClick={openLog}>
                Log a measurement
              </Button>
            </>
          )}
        </div>
      </div>
      {logging && goal && (
        <Sheet title={`Log ${goal.name}`} onClose={() => setLogging(false)} actions={
          <Button variant="primary" full disabled={saving} onClick={save}>Save measurement</Button>
        }>
          <SectionHeader>Today</SectionHeader>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="decimal"
            placeholder={goal.unit ? `Value in ${goal.unit}` : 'Value'}
          />
          {goal.test_protocol && (
            <p className="text-sm text-dim" style={{ marginTop: 14, lineHeight: 1.5 }}>{goal.test_protocol}</p>
          )}
        </Sheet>
      )}
    </div>
  )
}
