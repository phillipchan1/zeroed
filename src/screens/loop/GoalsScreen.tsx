import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, History } from 'lucide-react'
import { PageHeader, SectionHeader, Skeleton } from '../../components/ui'
import { GoalReticle } from '../../components/convergence/GoalReticle'
import { useCachedLoader } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalsView, useProgramTracks, type GoalView } from '../../lib/tracksData'
import { progressRatio, GOAL_DISPLAY_LABEL } from '../../engine/goals'
import { fetchProgramView } from './ProgramScreen'
import { fetchProfileMeta } from './ProfileScreen'
import { GoalBar, GoalStatus, goalValue, shortDate } from './goalsUi'
import { TrackGlyph } from './tracksUi'
import { BlockRoad, blockWeeks } from './BlockRoad'

/** Reticle labels: the goal's name without its side, short enough for a sector. */
function axisLabel(g: GoalView): string {
  const side = g.name.match(/\s+([LR])$/i)?.[1]?.toUpperCase()
  const name = g.name.replace(/\s+[LR]$/i, '').trim()
  const short = name.length <= 8 ? name
    : name.split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).sort((a, b) => b.length - a.length)[0] ?? name
  return `${short.slice(0, 8)}${side ? ` ${side}` : ''}`.toUpperCase()
}

function perWeek(n: number, unit: string | null): string {
  return `${n > 0 ? '+' : ''}${goalValue(n, unit)} a week`
}

// Off course first (by due date), then needs a test, then on course, then zeroed.
const ORDER = { off_course: 0, needs_test: 1, on_course: 2, zeroed: 3 } as const

/**
 * GOALS — the aim, and the plan beneath it. The reticle is the goals; the one
 * yellow is the goal that needs you; targets sit under the lane that trains
 * them; the road is the block. With tracks_v1 on this is where the plan lives,
 * and Program is its detail.
 */
export function GoalsScreen({ athleteId }: { athleteId: string }) {
  const navigate = useNavigate()
  const { data, loading } = useCachedLoader<GoalView[]>(cacheKeys.goals(athleteId), () => fetchGoalsView(athleteId))
  const { data: view } = useCachedLoader(cacheKeys.program(athleteId), () => fetchProgramView(athleteId))
  const { data: meta } = useCachedLoader(cacheKeys.profile(athleteId), () => fetchProfileMeta(athleteId))
  const program = view?.program ?? null
  const phase = view?.phase ?? null
  const tracks = useProgramTracks(program?.id)
  const goals = useMemo(() => data ?? [], [data])
  const today = new Date().toLocaleDateString('en-CA')

  const axes = useMemo(() => goals
    .slice()
    .sort((a, b) => (a.lane?.sort_order ?? 99) - (b.lane?.sort_order ?? 99) || a.name.localeCompare(b.name))
    .map((g) => ({ id: g.id, label: axisLabel(g), progress: progressRatio(g), display: g.display })), [goals])

  const lanes = useMemo(() => {
    const groups = new Map<string, { name: string; icon: string | null; order: number; goals: GoalView[] }>()
    for (const g of goals) {
      const key = g.lane?.name.toLowerCase() ?? ''
      const group = groups.get(key) ?? { name: g.lane?.name ?? 'Other', icon: g.lane?.icon ?? null, order: g.lane?.sort_order ?? 99, goals: [] }
      group.goals.push(g)
      groups.set(key, group)
    }
    return [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map((l) => ({ ...l, goals: l.goals.sort((a, b) => a.pair.localeCompare(b.pair) || a.name.localeCompare(b.name)) }))
  }, [goals])

  const urgent = useMemo(() => goals
    .filter((g) => g.display === 'off_course' || g.display === 'needs_test')
    .sort((a, b) => ORDER[a.display] - ORDER[b.display] || (a.due_date ?? '9').localeCompare(b.due_date ?? '9'))[0] ?? null, [goals])

  let weekLine: string | null = null
  if (phase?.week_start && phase?.week_end) {
    const { count, current } = blockWeeks(phase, today)
    const week = current >= 1 && current <= count ? `Week ${current} of ${count}` : null
    weekLine = [program?.name, program?.block_phase ?? phase.name, week].filter(Boolean).join(' · ')
  }

  return (
    <div className="screen with-nav">
      <div className="page">
        <div className="page__main">
          <PageHeader eyebrow={weekLine ?? 'The aim'} title="Goals" />
          {meta?.goals && (
            <button type="button" className="northstar" onClick={() => navigate('/app/profile')}>
              <span className="northstar__mark" aria-hidden />
              <span>{meta.goals}</span>
            </button>
          )}

          {loading && !data ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
              <Skeleton height={200} width="100%" /><Skeleton height={16} width={160} />
            </div>
          ) : !goals.length ? (
            <div className="card" style={{ marginTop: 20 }}>
              <p className="text-base text-dim">No measurable goals yet. Ask the coach to set them with you, or they land with the first block.</p>
            </div>
          ) : (
            <>
              <div className="goals-aim fade-rise">
                <GoalReticle goals={axes} size={250} onOpen={(id) => navigate(`/app/goals/${id}`)} />
                <p className="goals-aim__read">
                  {(['zeroed', 'on_course', 'off_course', 'needs_test'] as const)
                    .map((d) => ({ d, n: goals.filter((g) => g.display === d).length }))
                    .filter((x) => x.n > 0)
                    .map((x) => (
                      <span key={x.d} className={`goals-aim__count goals-aim__count--${x.d}`}>
                        <b className="num">{x.n}</b> {GOAL_DISPLAY_LABEL[x.d]}
                      </span>
                    ))}
                </p>
              </div>

              {urgent && (
                <button
                  type="button"
                  className={`goals-act goals-act--${urgent.display} fade-rise`}
                  onClick={() => navigate(`/app/goals/${urgent.id}`)}
                >
                  <span className="goals-act__k">{GOAL_DISPLAY_LABEL[urgent.display]} · {urgent.name}</span>
                  <span className="goals-act__t">
                    {urgent.display === 'off_course'
                      ? `${urgent.name} won’t reach ${goalValue(urgent.target, urgent.unit)}${urgent.due_date ? ` by ${shortDate(urgent.due_date)}` : ''} at this rate.`
                      : `${urgent.name} needs a test.`}
                  </span>
                  <span className="goals-act__s">
                    {urgent.display === 'off_course' && urgent.forecast
                      ? `Forecast ${goalValue(urgent.forecast.value, urgent.unit)}. ${urgent.forecast.neededPerWeek != null ? `Needs ${perWeek(urgent.forecast.neededPerWeek, urgent.unit)}; ${urgent.forecast.perWeek === 0 ? 'the trend is flat' : `trending ${perWeek(urgent.forecast.perWeek, urgent.unit)}`}.` : ''}`
                      : urgent.last_measured
                        ? `Last tested ${shortDate(urgent.last_measured)}${urgent.cadence ? `, ${urgent.cadence}` : ''}.`
                        : 'Nothing real logged yet, so its status is unproven.'}
                  </span>
                  <span className="goals-act__cta">Open the goal ›</span>
                </button>
              )}

              {lanes.map((lane) => (
                <div key={lane.name} className="card fade-rise goals-lane">
                  <div className="goals-lane__h">
                    <TrackGlyph track={{ name: lane.name, icon: lane.icon }} size={13} />
                    <span>{lane.name}</span>
                  </div>
                  {lane.goals.map((g) => (
                    <button key={g.id} type="button" className="goal-card goals-target" onClick={() => navigate(`/app/goals/${g.id}`)}>
                      <div className="goals-target__top">
                        <span className="text-base" style={{ fontWeight: 600 }}>{g.name}</span>
                        <span className="num text-sm">
                          {g.current != null ? goalValue(g.current, g.unit) : '—'}
                          <span className="text-dim"> / {goalValue(g.target, g.unit)}</span>
                        </span>
                      </div>
                      <GoalBar goal={g} display={g.display} />
                      <div className="goals-target__meta">
                        <GoalStatus display={g.display} />
                        <span className="text-xs text-dim">
                          {g.display === 'zeroed' && g.last_measured ? `Hit ${shortDate(g.last_measured)}`
                            : g.display === 'needs_test' ? (g.last_measured ? `Last ${shortDate(g.last_measured)}` : 'Not measured yet')
                              : g.due_date ? `Due ${shortDate(g.due_date)}` : g.last_measured ? `Last ${shortDate(g.last_measured)}` : ''}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          {phase && tracks.length > 0 && (
            <div className="card fade-rise" style={{ marginTop: 8 }}>
              <SectionHeader>The block</SectionHeader>
              <BlockRoad phase={phase} program={program} routines={view?.routines ?? []} tracks={tracks} goals={goals} today={today} />
            </div>
          )}

          <button type="button" className="program-edit-cta" style={{ marginTop: 20 }} onClick={() => navigate('/app/program/edit')}>
            <span className="program-edit-cta__icon"><Sparkles size={18} strokeWidth={1.75} /></span>
            <span style={{ minWidth: 0 }}>
              <span className="program-edit-cta__title">Change the plan</span>
              <span className="program-edit-cta__sub">Ask for more conditioning, a new target, or a lighter week, with the whole block in front of you.</span>
            </span>
            <span className="program-edit-cta__chev">›</span>
          </button>
          <button type="button" className="program-edit-cta program-edit-cta--quiet" onClick={() => navigate('/app/program')}>
            <span className="program-edit-cta__icon"><History size={18} strokeWidth={1.75} /></span>
            <span style={{ minWidth: 0 }}>
              <span className="program-edit-cta__title">Block details</span>
              <span className="program-edit-cta__sub">Phase, sessions, load by week, and your training so far.</span>
            </span>
            <span className="program-edit-cta__chev">›</span>
          </button>
        </div>
      </div>
    </div>
  )
}
