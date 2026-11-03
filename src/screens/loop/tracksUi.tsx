import type { ReactNode } from 'react'
import { formatSuperset, groupByTrack, type TrackRef, type TrackableExercise } from '../../engine/tracks'

export function TrackDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: 999,
        background: color, flexShrink: 0,
      }}
    />
  )
}

export function TrackLabel({ track }: { track: TrackRef }) {
  return (
    <span className="track-chip" style={{ ['--track-color' as string]: track.color }}>
      <TrackDot color={track.color} />
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
  const groups = groupByTrack(exercises, tracks)
  if (!groups.length) {
    return <>{exercises.map((ex, i) => render(ex, i))}</>
  }
  return (
    <>
      {groups.map((g) => (
        <div key={g.track?.id ?? 'none'} className="track-group">
          {g.track && (
            <div className="track-group__head">
              <span className="track-group__bar" style={{ background: g.track.color }} />
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
              <TrackDot color={t.color} />
              {t.name}
            </span>
            {DAYS.map((_, i) => (
              <span
                key={i}
                className={`coverage__cell${hit.has(i) ? ' coverage__cell--on' : ''}`}
                style={hit.has(i) ? { background: t.color } : undefined}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
