import { resolveTrack, type TrackRef } from '../../engine/tracks'
import type { PhaseRow, ProgramRow, RoutineRow } from '../../types/database'
import type { GoalView } from '../../lib/tracksData'
import { TrackGlyph } from './tracksUi'

const DAY = 86_400_000
const MAX_WEEKS = 8
// The lane-name column is fixed so the current-week bracket can be placed over the grid.
const NAME_COL = 100

function mondayOf(day: string): number {
  const t = Date.parse(`${day.slice(0, 10)}T12:00:00Z`)
  const dow = (new Date(t).getUTCDay() + 6) % 7
  return t - dow * DAY
}

/**
 * The block's weeks, Monday to Monday, and which one today is in (1-based; 0
 * before the block, count + 1 after it). The Goals header and the road both
 * read this, so they never disagree about "week 3 of 6".
 */
export function blockWeeks(phase: Pick<PhaseRow, 'week_start' | 'week_end'>, today: string): { count: number; current: number } {
  const first = mondayOf(phase.week_start)
  const count = Math.max(1, Math.round((mondayOf(phase.week_end) - first) / (7 * DAY)) + 1)
  const t = Date.parse(`${today}T12:00:00Z`)
  const current = Math.floor((t - first) / (7 * DAY)) + 1
  return { count, current: Math.max(0, Math.min(count + 1, current)) }
}

function weekIndexOf(day: string | null | undefined, starts: number[]): number {
  if (!day) return -1
  const t = Date.parse(`${day.slice(0, 10)}T12:00:00Z`)
  if (!Number.isFinite(t)) return -1
  return starts.findIndex((s) => t >= s && t < s + 7 * DAY)
}

/**
 * The block, lane by lane: weeks across, lanes down. Each cell carries a tick
 * per session that trains the lane (shorter in the deload week), past weeks
 * are filled, the current week is bracketed, and each goal due inside the
 * block plants a flag on its lane in its week, shaped and colored by status.
 * This replaces reading the plan off the Program screen.
 */
export function BlockRoad({ phase, program, routines, tracks, goals, today }: {
  phase: Pick<PhaseRow, 'week_start' | 'week_end'>
  program: Pick<ProgramRow, 'deload_week_start' | 'retest_start'> | null
  routines: Array<Pick<RoutineRow, 'exercises'>>
  tracks: TrackRef[]
  goals: GoalView[]
  today: string
}) {
  const first = mondayOf(phase.week_start)
  const last = mondayOf(phase.week_end)
  const count = Math.min(MAX_WEEKS, Math.max(1, Math.round((last - first) / (7 * DAY)) + 1))
  const starts = Array.from({ length: count }, (_, i) => first + i * 7 * DAY)
  const now = weekIndexOf(today, starts)
  const deload = weekIndexOf(program?.deload_week_start, starts)
  const retest = weekIndexOf(program?.retest_start, starts)

  const exposures = new Map<string, number>()
  for (const r of routines) {
    const hit = new Set<string>()
    for (const ex of r.exercises ?? []) {
      const t = resolveTrack(ex, tracks)
      if (t) hit.add(t.id)
    }
    for (const id of hit) exposures.set(id, (exposures.get(id) ?? 0) + 1)
  }
  const goalsOn = (t: TrackRef) => goals.filter((g) => g.lane?.name.toLowerCase() === t.name.toLowerCase())
  const lanes = tracks
    .filter((t) => (exposures.get(t.id) ?? 0) > 0 || goalsOn(t).length > 0)
    .filter((t, _, all) => t.name !== 'General' || all.length === 1)
  if (!lanes.length) return null

  // Day of month under the week number: a full date doesn't fit six columns on
  // a phone, and deload and retest read off the ticks and flags.
  const label = (i: number) => String(new Date(starts[i]).getUTCDate())

  return (
    <div className="road" role="table" aria-label="This block by lane and week">
      <div className="road__grid" style={{ gridTemplateColumns: `${NAME_COL}px repeat(${count}, minmax(0, 1fr))` }}>
        <span role="columnheader" />
        {starts.map((_, i) => (
          <span key={i} role="columnheader" className={`road__h${i === now ? ' road__h--now' : ''}`}>
            <b>W{i + 1}</b>{label(i)}
          </span>
        ))}
        {lanes.map((t) => {
          const n = Math.min(3, exposures.get(t.id) ?? 0)
          const flags = goalsOn(t)
          return (
            <div key={t.id} role="row" className="road__row" style={{ display: 'contents' }}>
              <span role="rowheader" className="road__name"><TrackGlyph track={t} size={12} /><span>{t.name}</span></span>
              {starts.map((_, i) => {
                const due = flags.filter((g) => weekIndexOf(g.due_date, starts) === i)
                const state = now === -1 ? (starts[i] < Date.parse(`${today}T12:00:00Z`) ? 'past' : 'next') : i < now ? 'past' : i === now ? 'now' : 'next'
                return (
                  <span
                    key={i}
                    role="cell"
                    className={`road__cell road__cell--${state}${i === deload ? ' road__cell--deload' : ''}`}
                    aria-label={`${t.name}, week ${i + 1}: ${n} session${n === 1 ? '' : 's'}${due.length ? `, ${due.map((g) => g.name).join(', ')} due` : ''}`}
                  >
                    {Array.from({ length: n }, (_, k) => <i key={k} className="road__tick" />)}
                    {due.slice(0, 2).map((g) => <span key={g.id} className={`road__flag road__flag--${g.display}`} title={g.name} />)}
                  </span>
                )
              })}
            </div>
          )
        })}
        {now >= 0 && (
          <span
            className="road__now"
            aria-hidden
            style={{
              left: `calc(${NAME_COL}px + (100% - ${NAME_COL}px) / ${count} * ${now})`,
              width: `calc((100% - ${NAME_COL}px) / ${count})`,
            }}
          />
        )}
      </div>
      <div className="road__legend">
        <span><i className="road__tick" /> session</span>
        <span><span className="road__flag road__flag--on_course" /> goal due</span>
        {deload >= 0 && <span>W{deload + 1} short ticks: deload</span>}
        {retest >= 0 && <span>W{retest + 1}: retest</span>}
      </div>
    </div>
  )
}
