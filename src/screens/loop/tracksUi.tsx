import type { ReactNode } from 'react'
import {
  Activity, Bike, Circle, Dumbbell, Footprints, HeartPulse, Layers, Mountain, Move, Target, Timer,
  Volleyball, Waves, Zap, type LucideIcon,
} from 'lucide-react'
import { formatSuperset, sessionTrackLayout, suggestTrackName, type TrackRef, type TrackableExercise } from '../../engine/tracks'

// Color is status, shape is lane. Track colors were drawn from the same five
// tokens as status (Lifting was --computing, Conditioning --pending, Basketball
// --confirmed), so every lane chip read as a verdict. A lane is told apart by
// its glyph and its name; the stored color is left for the coach and MCP.
const ICONS: Record<string, LucideIcon> = {
  dumbbell: Dumbbell, zap: Zap, circle: Circle, layers: Layers, move: Move,
  activity: Activity, bike: Bike, footprints: Footprints, 'heart-pulse': HeartPulse,
  mountain: Mountain, target: Target, timer: Timer, volleyball: Volleyball, waves: Waves,
}

// An icon name we don't draw falls back to the lane the track's name suggests.
const BY_LANE: Record<string, LucideIcon> = {
  Lifting: Dumbbell, Conditioning: Zap, Basketball: Volleyball, Hypertrophy: Layers, Mobility: Move,
}

/** What a glyph needs: a stored icon may be missing on older rows. */
type LaneLike = { name: string; icon?: string | null }

export function trackIcon(track: LaneLike): LucideIcon {
  return ICONS[String(track.icon ?? '').toLowerCase()] ?? BY_LANE[suggestTrackName(track.name)] ?? Circle
}

export function TrackGlyph({ track, size = 13 }: { track: LaneLike; size?: number }) {
  const Icon = trackIcon(track)
  return <Icon aria-hidden size={size} strokeWidth={1.75} style={{ flexShrink: 0 }} />
}

export function TrackLabel({ track }: { track: LaneLike }) {
  return (
    <span className="track-chip">
      <TrackGlyph track={track} />
      {track.name}
    </span>
  )
}

export function TrackedExerciseList<T extends TrackableExercise>({
  exercises,
  tracks,
  render,
}: {
  exercises: T[]
  tracks: TrackRef[]
  render: (ex: T, index: number) => ReactNode
}) {
  const layout = sessionTrackLayout(exercises, tracks)
  if (layout.kind === 'flat') {
    return (
      <>
        {layout.items.map(({ exercise, index, track }) => {
          const tag = formatSuperset(exercise.superset_group)
          return (
            <div key={`${index}-${exercise.name}`} className="track-group__row">
              {track && <TrackLabel track={track} />}
              {tag && <span className="superset-tag">{tag}</span>}
              {render(exercise, index)}
            </div>
          )
        })}
      </>
    )
  }
  if (!layout.groups.length) {
    return <>{exercises.map((ex, i) => render(ex, i))}</>
  }
  return (
    <>
      {layout.groups.map((g) => (
        <div key={g.track?.id ?? 'none'} className="track-group">
          {g.track && (
            <div className="track-group__head">
              <span className="track-group__bar" />
              <TrackLabel track={g.track} />
            </div>
          )}
          {g.exercises.map(({ exercise, index }) => {
            const tag = formatSuperset(exercise.superset_group)
            return (
              <div key={`${index}-${exercise.name}`} className="track-group__row">
                {tag && <span className="superset-tag">{tag}</span>}
                {render(exercise, index)}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function CoverageGrid({
  tracks,
  days,
}: {
  tracks: TrackRef[]
  days: Record<string, number[]>
}) {
  const shown = tracks.filter((t) => t.name !== 'General' || tracks.length === 1)
  return (
    <div className="coverage">
      <div className="coverage__head">
        <span />
        {DAYS.map((d, i) => <span key={i} className="coverage__dow">{d}</span>)}
      </div>
      {shown.map((t) => {
        const hit = new Set(days[t.id] ?? [])
        return (
          <div key={t.id} className="coverage__row">
            <span className="coverage__name">
              <TrackGlyph track={t} size={12} />
              <span>{t.name}</span>
            </span>
            {DAYS.map((_, i) => (
              <span
                key={i}
                className={`coverage__cell${hit.has(i) ? ' coverage__cell--on' : ''}`}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
