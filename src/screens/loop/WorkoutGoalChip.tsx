import { LockOn, TickingNumber } from '../../components/ui'
import { goalNumber } from '../../engine/goals'
import { deriveGoalMeasurements, type LoggedSet, type SourceUnits } from '../../engine/goalSources'
import type { GoalView } from '../../lib/tracksData'
import { goalValue } from './goalsUi'

/**
 * The goal an exercise feeds, riding in its header. Today's sets are judged by
 * the same function the commit writes with, so the number here is the number
 * the goal will get. A set that beats the goal's current mark ticks it up and
 * the brackets lock on; reaching the target turns it confirmed green. The
 * bigger moment waits for the finish screen. Keyed on the value, the lock
 * replays only when the number actually moves, and never blocks the next tap.
 * It reads, it doesn't navigate: a tap mid-session shouldn't leave the session.
 */
export function WorkoutGoalChip({ goal, exercise, sets, units }: {
  goal: GoalView
  exercise: string
  sets: LoggedSet[]
  units: SourceUnits
}) {
  const today = deriveGoalMeasurements([{ name: exercise, sets }], [goal], units)[0] ?? null
  const current = goalNumber(goal.current)
  const lower = goal.direction === 'lower'
  const moved = today != null && (current == null || (lower ? today.value < current : today.value > current))
  const shown = moved ? today.value : current
  const hit = moved ? today.hit : goal.display === 'zeroed'
  const label = hit ? 'Hit' : moved ? 'New best' : 'Goal'
  const chip = (
    <div
      className={`workout-goal${moved ? ' workout-goal--moved' : ''}${hit ? ' workout-goal--hit' : ''}`}
      role="status"
      aria-label={`${label}, ${goal.name}: ${goalValue(shown, goal.unit)} of ${goalValue(goal.target, goal.unit)}`}
    >
      <span className="workout-goal__k">{label}</span>
      <span className="workout-goal__name">{goal.name}</span>
      <span className="workout-goal__val num">
        {shown == null ? '—' : <TickingNumber value={shown} />}
        <span className="text-dim"> / {goalValue(goal.target, goal.unit)}</span>
      </span>
    </div>
  )
  if (!moved) return chip
  return (
    <LockOn
      key={shown}
      className="workout-goal__lock"
      style={{
        '--lock-gap': '-5px', '--lock-from': '10px', '--lock-size': '9px',
        ...(hit ? { '--lock-color': 'var(--confirmed)' } : {}),
      } as React.CSSProperties}
    >
      {chip}
    </LockOn>
  )
}
