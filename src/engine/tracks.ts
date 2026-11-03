/**
 * Track assignment and grouping. Pure — the coach confirms writes.
 *
 * Every exercise belongs to exactly one track. Missing track_id resolves
 * to the program's General track at read time. Name heuristics are the
 * spec's auto-suggest list (section 7); they never overwrite load.
 */

export const ENGINE_TYPES = [
  'tm_wave',
  'rpe_autoreg',
  'double_progression',
  'maintenance',
  'time_interval',
  'contacts',
  'measurement',
  'manual',
] as const

export type EngineType = (typeof ENGINE_TYPES)[number]

export const PHIL_TRACKS = [
  { name: 'Lifting', color: '#5A8FB8', icon: 'dumbbell', order: 1, purpose: 'Main lifts — Wendler TM, RTS, Westside speed, minimum dose', methodology_text: 'Wendler 5/3/1 TM, RTS autoregulation, Westside dynamic effort, Bickel 2011 minimum dose' },
  { name: 'Conditioning', color: '#D4A848', icon: 'zap', order: 2, purpose: 'Engine, sprints, plyos', methodology_text: 'Jamieson (8 Weeks Out), ALTIS acceleration, HWPO/Mayhem finishers, NSCA plyo contacts' },
  { name: 'Basketball', color: '#5FB87A', icon: 'circle', order: 3, purpose: 'Sport as conditioning; post-game ratings', methodology_text: 'Vermeil hierarchy; game as conditioning' },
  { name: 'Hypertrophy', color: '#C4A882', icon: 'layers', order: 4, purpose: 'Accessories — double progression, shoulder work', methodology_text: 'Double progression; Cressey shoulder work' },
  { name: 'Mobility', color: '#8A9AA8', icon: 'move', order: 5, purpose: 'Knees, screens, prehab', methodology_text: 'Knees Over Toes; Cressey screens; measurement-based' },
] as const

export interface TrackRef {
  id: string
  name: string
  color: string
  icon: string
  order: number
  purpose?: string | null
}

export interface TrackableExercise {
  name: string
  track_id?: string | null
  superset_group?: string | null
}

const LIFTING = /\b(bench press|speed bench|paused bench|strict ohp|overhead press|\bohp\b|back squat|front squat|deadlift|sumo deadlift)\b/i
const NOT_LIFTING = /\b(split squat|db bench|dumbbell bench|goblet)\b/i
const CONDITIONING = /\b(assault bike|echo bike|bike|sprint|broad jump|vertical jump|box jump|depth jump|pogo|lateral bound|bound|tabata)\b/i
const HYPERTROPHY = /\b(db bench|dumbbell bench|dumbbell|db row|barbell row|cable row|landmine|face pull|serratus|scap|rear delt|lat pulldown)\b/i
const MOBILITY = /\b(90\/90|hip ir|knee.to.wall|knee to wall|wall test|tib|nordic|reverse nordic|split squat|cossack|patrick|band walk|prehab|atg)\b/i

export function normalizeTrackName(name: string): string {
  return String(name ?? '').trim().toLowerCase()
}

/** Spec §7 name/type suggest. Session named basketball wins. */
export function suggestTrackName(
  exerciseName: string,
  sessionName?: string | null,
  sessionType?: string | null,
): string {
  const session = `${sessionName ?? ''} ${sessionType ?? ''}`
  if (/\bbasketball\b/i.test(session)) return 'Basketball'
  const name = exerciseName ?? ''
  if (LIFTING.test(name) && !NOT_LIFTING.test(name)) return 'Lifting'
  if (CONDITIONING.test(name)) return 'Conditioning'
  if (HYPERTROPHY.test(name)) return 'Hypertrophy'
  if (MOBILITY.test(name)) return 'Mobility'
  return 'General'
}

export function findTrack(tracks: TrackRef[], idOrName: string | null | undefined): TrackRef | null {
  if (!idOrName) return null
  const want = normalizeTrackName(idOrName)
  return tracks.find((t) => t.id === idOrName)
    ?? tracks.find((t) => normalizeTrackName(t.name) === want)
    ?? tracks.find((t) => {
      const other = normalizeTrackName(t.name)
      return other.includes(want) || want.includes(other)
    })
    ?? null
}

export function generalTrack(tracks: TrackRef[]): TrackRef | null {
  return findTrack(tracks, 'General') ?? tracks.slice().sort((a, b) => a.order - b.order)[0] ?? null
}

export function resolveTrack(
  exercise: TrackableExercise,
  tracks: TrackRef[],
): TrackRef | null {
  if (exercise.track_id) {
    const hit = tracks.find((t) => t.id === exercise.track_id)
    if (hit) return hit
  }
  const suggested = suggestTrackName(exercise.name)
  return findTrack(tracks, suggested) ?? generalTrack(tracks)
}

export interface TrackGroup<T extends TrackableExercise> {
  track: TrackRef | null
  exercises: Array<{ exercise: T; index: number }>
}

/** Group in track order, preserving in-session order inside each track. */
export function groupByTrack<T extends TrackableExercise>(
  exercises: T[],
  tracks: TrackRef[],
): TrackGroup<T>[] {
  const buckets = new Map<string, TrackGroup<T>>()
  const leftovers: TrackGroup<T> = { track: null, exercises: [] }
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i]
    const track = resolveTrack(ex, tracks)
    const key = track?.id ?? ''
    if (!track) {
      leftovers.exercises.push({ exercise: ex, index: i })
      continue
    }
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { track, exercises: [] }
      buckets.set(key, bucket)
    }
    bucket.exercises.push({ exercise: ex, index: i })
  }
  const ordered = tracks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((t) => buckets.get(t.id))
    .filter((g): g is TrackGroup<T> => Boolean(g))
  if (leftovers.exercises.length) ordered.push(leftovers)
  return ordered
}

export function formatSuperset(group: string | null | undefined): string | null {
  const g = String(group ?? '').trim().toUpperCase()
  return /^[A-Z]\d+$/.test(g) ? g : null
}

export function daysHitByTrack(
  sessions: Array<{ intendedDow: number | null; exercises: TrackableExercise[] }>,
  tracks: TrackRef[],
): Record<string, number[]> {
  const out: Record<string, Set<number>> = {}
  for (const t of tracks) out[t.id] = new Set()
  for (const s of sessions) {
    const dow = s.intendedDow
    if (dow == null || dow < 0 || dow > 6) continue
    for (const ex of s.exercises) {
      const track = resolveTrack(ex, tracks)
      if (track) out[track.id]?.add(dow)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([id, set]) => [id, [...set].sort((a, b) => a - b)]))
}

export function isEngineType(v: unknown): v is EngineType {
  return typeof v === 'string' && (ENGINE_TYPES as readonly string[]).includes(v)
}
