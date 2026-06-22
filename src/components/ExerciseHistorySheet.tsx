import { useEffect, useState } from 'react'
import { X, Clock } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { resolveTrackingType } from '../engine/exerciseLibrary'
import { getWeightUnit, getDistanceUnit } from '../lib/units'
import type { ExerciseTemplate, SetLog, TrackingType } from '../types/database'

interface ExerciseSession {
  workoutId: string
  routineName: string
  date: string
  sets: SetLog[]
  trackingType: TrackingType
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return `${diff}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatSet(t: TrackingType, log: SetLog, unit: string, distUnit: string): string {
  if (!log.done && log.reps == null && log.duration == null && log.distance == null) return ''
  let str = ''
  if (t === 'time') {
    str = `${log.duration ?? '?'}s`
  } else if (t === 'distance') {
    str = `${log.distance ?? '?'}${distUnit}`
  } else if (t === 'bodyweight_reps') {
    str = `${log.reps ?? '?'} reps${log.weight ? ` +${log.weight}${unit}` : ''}`
  } else {
    str = `${log.weight != null ? `${log.weight}${unit}` : 'BW'}×${log.reps ?? '?'}`
  }
  if (log.rpe != null) str += ` · RPE ${log.rpe}`
  return str
}

interface ExerciseHistorySheetProps {
  exerciseName: string
  athleteId: string
  onClose: () => void
}

export function ExerciseHistorySheet({ exerciseName, athleteId, onClose }: ExerciseHistorySheetProps) {
  const unit = getWeightUnit()
  const distUnit = getDistanceUnit(unit)
  const [sessions, setSessions] = useState<ExerciseSession[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const { data: programs } = await supabase
          .from('program')
          .select('id')
          .eq('athlete_id', athleteId)

        const programIds = programs?.map((p) => p.id) ?? []
        if (!programIds.length) {
          if (!cancelled) setLoading(false)
          return
        }

        const { data: routines } = await supabase
          .from('routine')
          .select('id, name, exercises')
          .in('program_id', programIds)

        if (!routines?.length) {
          if (!cancelled) setLoading(false)
          return
        }

        const nameLower = exerciseName.toLowerCase()
        type MatchedRoutine = { id: string; name: string; exIdx: number; exTemplate: ExerciseTemplate }
        const matchingRoutines: MatchedRoutine[] = []

        for (const r of routines) {
          const exercises = r.exercises as ExerciseTemplate[]
          const idx = exercises.findIndex((e) => e.name.toLowerCase() === nameLower)
          if (idx >= 0) {
            matchingRoutines.push({ id: r.id, name: r.name, exIdx: idx, exTemplate: exercises[idx] })
          }
        }

        if (!matchingRoutines.length) {
          if (!cancelled) setLoading(false)
          return
        }

        const routineIds = matchingRoutines.map((r) => r.id)
        const { data: workouts } = await supabase
          .from('workout')
          .select('id, routine_id, performed_at, actual_weights')
          .in('routine_id', routineIds)
          .order('performed_at', { ascending: false })
          .limit(30)

        if (!cancelled) {
          const built: ExerciseSession[] = []
          for (const w of workouts ?? []) {
            const match = matchingRoutines.find((r) => r.id === w.routine_id)
            if (!match) continue
            const weights = w.actual_weights as Record<string, SetLog[]> | null
            const sets = weights?.[String(match.exIdx)] ?? []
            const loggedSets = sets.filter(
              (s) => s.done || s.reps != null || s.duration != null || s.distance != null,
            )
            if (!loggedSets.length) continue
            const trackingType =
              match.exTemplate.tracking_type ??
              resolveTrackingType(match.exTemplate.name, match.exTemplate.reps, match.exTemplate.load)
            built.push({
              workoutId: w.id,
              routineName: match.name,
              date: w.performed_at,
              sets: loggedSets,
              trackingType,
            })
          }
          setSessions(built)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [exerciseName, athleteId])

  return (
    <div className="obs-sheet" onClick={onClose}>
      <div
        className="obs-sheet__inner"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '80dvh', overflowY: 'auto' }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Clock size={12} strokeWidth={1.5} color="var(--text-dim)" />
              <span
                className="text-xs text-dim"
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
              >
                History
              </span>
            </div>
            <p style={{ fontWeight: 600, fontSize: 15 }}>{exerciseName}</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: 0, height: 28, minWidth: 28, color: 'var(--text-dim)', flexShrink: 0 }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-dim">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-dim" style={{ lineHeight: 1.5 }}>
            No logged sets for {exerciseName} yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sessions.map((session) => (
              <div key={session.workoutId} className="card--data" style={{ padding: '10px 12px' }}>
                <div
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    marginBottom: 8,
                  }}
                >
                  <span
                    className="num text-xs"
                    style={{ color: 'var(--signal)', letterSpacing: '0.04em' }}
                  >
                    {formatDate(session.date)}
                  </span>
                  <span className="text-xs text-dim">{session.routineName}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {session.sets.map((set, i) => {
                    const str = formatSet(session.trackingType, set, unit, distUnit)
                    if (!str) return null
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span
                          className="num text-xs text-dim"
                          style={{ minWidth: 18, flexShrink: 0 }}
                        >
                          {set.set}
                        </span>
                        <span className="num text-sm">{str}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
