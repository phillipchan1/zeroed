/**
 * Week-only session overrides (G1): a one-off change to ONE dated session —
 * add, swap, drop or adjust an exercise, or move an exercise / the whole
 * session to another day — that never touches the program template.
 *
 * Pure on purpose: the Worker resolves sessions and stores rows, this module
 * only reads ops against a session's exercise list. The same functions build
 * the preview diff and serve /api/session-rx, so what the athlete approved is
 * what the engine prescribes.
 *
 * Stored ops (session_override.ops) are the expanded form. A `move` the coach
 * asks for becomes a `move_out` on the source date and a `move_in` on the
 * target date — two rows sharing one pair_id.
 */
import type { ExerciseTemplate } from '../types/database.ts'

/** Shown on every overridden exercise or session. */
export const WEEK_ONLY_LABEL = 'This week only'

/** Max ops in one override request. Surgical, not a rewrite (U13). */
export const MAX_OVERRIDE_OPS = 12
/** A move lands within a week of where it started. */
export const MAX_MOVE_DAYS = 7
/** Hard ceiling on expires_on: never more than 7 days after the session date. */
export const MAX_EXPIRY_DAYS = 7
/** How far back an override can be dated (the "missed Tuesday" case). */
export const MAX_PAST_DAYS = 7
/** How far ahead an override can be dated. */
export const MAX_FUTURE_DAYS = 13

export interface OverrideExercise {
  name: string
  sets?: number | null
  reps?: string | null
  load?: string | null
  target_rpe?: number | null
  cue?: string | null
}

export type OverrideOp =
  | { op: 'add'; exercise: OverrideExercise; after?: string | null }
  | { op: 'swap'; exercise_name: string; with: OverrideExercise }
  | { op: 'drop'; exercise_name: string }
  | {
      op: 'adjust'
      exercise_name: string
      sets?: number | null
      reps?: string | null
      load?: string | null
      target_rpe?: number | null
    }
  /** exercise_name null = the whole session leaves this date. */
  | { op: 'move_out'; exercise_name: string | null; to_date: string }
  /**
   * exercise null = the whole session arrives on this date, as `session` (the
   * list it had on from_date, edits included); the template when absent.
   */
  | { op: 'move_in'; from_date: string; exercise: ExerciseTemplate | null; session?: ExerciseTemplate[] }

/** What a caller may send. `move` expands into move_out + move_in. */
export type OverrideInputOp =
  | Extract<OverrideOp, { op: 'add' | 'swap' | 'drop' | 'adjust' }>
  | { op: 'move'; exercise_name?: string | null; to_date: string; to_session?: string | null }

export type OverrideMarkKind = 'added' | 'swapped' | 'adjusted' | 'moved_in'

export interface OverrideMark {
  kind: OverrideMarkKind
  /** swapped: the programmed lift it stands in for. moved_in: the source date. */
  from?: string
}

/** What /api/session-rx returns beside a prescription that an override touched. */
export interface SessionOverrideView {
  label: typeof WEEK_ONLY_LABEL
  date: string
  override_ids: string[]
  expires_on: string
  /** The session's exercises for this date, after the override. Indexes match the prescription. */
  exercises: ExerciseTemplate[]
  marks: Record<number, OverrideMark>
  dropped: string[]
  moved_out: Array<{ name: string | null; to_date: string }>
  moved_in_from: string | null
}

export interface StoredOverride {
  id: string
  date: string
  expires_on: string
  ops: OverrideOp[]
  voided_at?: string | null
}

// ---- dates ------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5)
}

/** Monday of the ISO week holding `date`. */
export function isoWeekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, -((dow + 6) % 7))
}

/**
 * Default expiry: the Sunday that ends the date's ISO week (0–6 days after the
 * date). The override only ever applies ON its date; expires_on is the hard
 * stop after which it is ignored even for that date, and the row stays for audit.
 */
export function defaultExpiresOn(date: string): string {
  return addDays(isoWeekStart(date), 6)
}

/** A caller's expires_on, or the default. Null when it is out of bounds. */
export function resolveExpiresOn(date: string, asked: unknown): string | null {
  if (asked == null || asked === '') return defaultExpiresOn(date)
  if (!isIsoDate(asked)) return null
  const gap = daysBetween(date, asked)
  return gap >= 0 && gap <= MAX_EXPIRY_DAYS ? asked : null
}

/** Applies on `onDate` when the athlete's today is `today`. */
export function overrideActive(row: StoredOverride, onDate: string, today: string): boolean {
  return !row.voided_at && row.date === onDate && row.expires_on >= today
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Thu Nov 6" — stable on any runtime (no locale tables). */
export function shortDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAY[d.getUTCDay()]} ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// ---- input ------------------------------------------------------------------

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= max ? t : null
}

function int(v: unknown, lo: number, hi: number): number | null | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  const r = Math.round(n)
  return r >= lo && r <= hi ? r : null
}

function rpe(v: unknown): number | null | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 10) return null
  return Math.round(n * 2) / 2
}

function exerciseIn(v: unknown, where: string, errors: string[]): OverrideExercise | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push(`${where}: an exercise object with a name is required`)
    return null
  }
  const o = v as Record<string, unknown>
  const name = str(o.name, 80)
  if (!name) {
    errors.push(`${where}: exercise name is required (≤80 chars)`)
    return null
  }
  const out: OverrideExercise = { name }
  const sets = int(o.sets, 1, 10)
  if (sets === null) errors.push(`${where}: sets must be 1–10`)
  else if (sets !== undefined) out.sets = sets
  if (o.reps != null) {
    const reps = str(String(o.reps), 40)
    if (!reps) errors.push(`${where}: reps must be a short string`)
    else out.reps = reps
  }
  if (o.load != null) {
    const load = str(String(o.load), 40)
    if (!load) errors.push(`${where}: load must be a short string`)
    else out.load = load
  }
  const r = rpe(o.target_rpe)
  if (r === null) errors.push(`${where}: target_rpe must be 1–10`)
  else if (r !== undefined) out.target_rpe = r
  const cue = o.cue == null ? null : str(String(o.cue), 200)
  if (cue) out.cue = cue
  return out
}

/**
 * Validate a caller's ops. Unknown op kinds, missing names and out-of-range
 * numbers are errors; nothing is silently dropped.
 */
export function normalizeInputOps(raw: unknown): { ops: OverrideInputOp[]; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(raw) || raw.length === 0) return { ops: [], errors: ['ops must be a non-empty array'] }
  if (raw.length > MAX_OVERRIDE_OPS) return { ops: [], errors: [`at most ${MAX_OVERRIDE_OPS} ops per override`] }
  const ops: OverrideInputOp[] = []
  raw.forEach((item, i) => {
    const where = `ops[${i}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where}: must be an object`)
      return
    }
    const o = item as Record<string, unknown>
    const target = str(o.exercise_name, 80)
    switch (o.op) {
      case 'add': {
        const exercise = exerciseIn(o.exercise, where, errors)
        if (exercise) ops.push({ op: 'add', exercise, after: str(o.after, 80) })
        return
      }
      case 'swap': {
        if (!target) { errors.push(`${where}: exercise_name is required`); return }
        const w = exerciseIn(o.with, `${where}.with`, errors)
        if (w) ops.push({ op: 'swap', exercise_name: target, with: w })
        return
      }
      case 'drop':
        if (!target) { errors.push(`${where}: exercise_name is required`); return }
        ops.push({ op: 'drop', exercise_name: target })
        return
      case 'adjust': {
        if (!target) { errors.push(`${where}: exercise_name is required`); return }
        const errorsBefore = errors.length
        const adj: Extract<OverrideOp, { op: 'adjust' }> = { op: 'adjust', exercise_name: target }
        const sets = int(o.sets, 1, 10)
        if (sets === null) errors.push(`${where}: sets must be 1–10`)
        else if (sets !== undefined) adj.sets = sets
        if (o.reps != null) {
          const reps = str(String(o.reps), 40)
          if (!reps) errors.push(`${where}: reps must be a short string`)
          else adj.reps = reps
        }
        if (o.load != null) {
          const load = str(String(o.load), 40)
          if (!load) errors.push(`${where}: load must be a short string`)
          else adj.load = load
        }
        const r = rpe(o.target_rpe)
        if (r === null) errors.push(`${where}: target_rpe must be 1–10`)
        else if (r !== undefined) adj.target_rpe = r
        if (errors.length > errorsBefore) return
        if (adj.sets === undefined && adj.reps === undefined && adj.load === undefined && adj.target_rpe === undefined) {
          errors.push(`${where}: adjust needs at least one of sets, reps, load, target_rpe`)
          return
        }
        ops.push(adj)
        return
      }
      case 'move': {
        if (!isIsoDate(o.to_date)) { errors.push(`${where}: to_date must be YYYY-MM-DD`); return }
        ops.push({ op: 'move', exercise_name: target, to_date: o.to_date, to_session: str(o.to_session, 120) })
        return
      }
      default:
        errors.push(`${where}: op must be add | swap | drop | adjust | move`)
    }
  })
  const moves = ops.filter((o) => o.op === 'move')
  if (moves.some((m) => m.op === 'move' && !m.exercise_name) && ops.length > 1) {
    errors.push('moving a whole session must be the only op in the request')
  }
  return { ops, errors }
}

// ---- matching -----------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Exact name first, then one unambiguous substring match. */
export function findExercise(list: Array<{ name: string }>, wanted: string): { index: number } | { error: string } {
  const w = norm(wanted)
  const exact = list.findIndex((e) => norm(e.name) === w)
  if (exact >= 0) return { index: exact }
  const loose = list
    .map((e, i) => ({ i, n: norm(e.name) }))
    .filter((e) => e.n.includes(w))
  if (loose.length === 1) return { index: loose[0].i }
  if (loose.length > 1) return { error: `"${wanted}" matches more than one exercise (${loose.map((l) => list[l.i].name).join(', ')})` }
  return { error: `no exercise named "${wanted}" in this session` }
}

function toTemplate(ex: OverrideExercise, inherit?: ExerciseTemplate): ExerciseTemplate {
  // A programmed load carries over only when it is a descriptor ("heavy"),
  // never a number written for a different lift.
  const inheritedLoad = inherit?.load && !/\d/.test(inherit.load) ? inherit.load : undefined
  const out: ExerciseTemplate = {
    name: ex.name,
    sets: ex.sets ?? inherit?.sets ?? 3,
    reps: ex.reps ?? inherit?.reps ?? '8',
  }
  const load = ex.load ?? inheritedLoad
  if (load) out.load = load
  const target = ex.target_rpe ?? inherit?.target_rpe
  if (target != null) out.target_rpe = target
  const cue = ex.cue ?? undefined
  if (cue) out.cue = cue
  return out
}

// ---- applying -------------------------------------------------------------------

interface Slot {
  ex: ExerciseTemplate
  mark?: OverrideMark
}

export interface AppliedOverride {
  exercises: ExerciseTemplate[]
  marks: Record<number, OverrideMark>
  dropped: string[]
  movedOut: Array<{ name: string | null; to_date: string }>
  movedInFrom: string | null
  errors: string[]
}

/**
 * Read stored ops (oldest row first) over a session's base exercises.
 * Ops whose exercise is gone (the template changed since) report an error
 * and are skipped; the rest still apply.
 */
export function applyOverrideOps(base: ExerciseTemplate[], opsList: OverrideOp[][]): AppliedOverride {
  let slots: Slot[] = base.map((ex) => ({ ex: { ...ex } }))
  const dropped: string[] = []
  const movedOut: AppliedOverride['movedOut'] = []
  let movedInFrom: string | null = null
  const errors: string[] = []

  const find = (name: string): number | null => {
    const hit = findExercise(slots.map((s) => s.ex), name)
    if ('error' in hit) {
      errors.push(hit.error)
      return null
    }
    return hit.index
  }

  for (const ops of opsList) {
    for (const op of ops) {
      switch (op.op) {
        case 'add': {
          const slot: Slot = { ex: toTemplate(op.exercise), mark: { kind: 'added' } }
          const at = op.after ? find(op.after) : null
          if (op.after && at == null) break
          if (at == null) slots.push(slot)
          else slots.splice(at + 1, 0, slot)
          break
        }
        case 'swap': {
          const i = find(op.exercise_name)
          if (i == null) break
          const was = slots[i]
          const from = was.mark?.kind === 'swapped' ? was.mark.from : was.ex.name
          slots[i] = { ex: toTemplate(op.with, was.ex), mark: { kind: 'swapped', from } }
          break
        }
        case 'drop': {
          const i = find(op.exercise_name)
          if (i == null) break
          dropped.push(slots[i].ex.name)
          slots.splice(i, 1)
          break
        }
        case 'adjust': {
          const i = find(op.exercise_name)
          if (i == null) break
          const ex = { ...slots[i].ex }
          if (op.sets != null) ex.sets = op.sets
          if (op.reps != null) ex.reps = op.reps
          if (op.load != null) ex.load = op.load
          if (op.target_rpe != null) ex.target_rpe = op.target_rpe
          const keep = slots[i].mark
          slots[i] = { ex, mark: keep && keep.kind !== 'adjusted' ? keep : { kind: 'adjusted' } }
          break
        }
        case 'move_out': {
          if (op.exercise_name == null) {
            for (const s of slots) dropped.push(s.ex.name)
            slots = []
            movedOut.push({ name: null, to_date: op.to_date })
            break
          }
          const i = find(op.exercise_name)
          if (i == null) break
          movedOut.push({ name: slots[i].ex.name, to_date: op.to_date })
          dropped.push(slots[i].ex.name)
          slots.splice(i, 1)
          break
        }
        case 'move_in': {
          if (op.exercise == null) {
            movedInFrom = op.from_date
            const arriving = op.session ? op.session.map((ex) => ({ ...ex })) : slots.map((s) => s.ex)
            slots = arriving.map((ex) => ({ ex, mark: { kind: 'moved_in', from: op.from_date } }))
            break
          }
          slots.push({ ex: { ...op.exercise }, mark: { kind: 'moved_in', from: op.from_date } })
          break
        }
      }
    }
  }

  const marks: Record<number, OverrideMark> = {}
  slots.forEach((s, i) => { if (s.mark) marks[i] = s.mark })
  return { exercises: slots.map((s) => s.ex), marks, dropped, movedOut, movedInFrom, errors }
}

/** The view session-rx returns, or null when nothing active touches this date. */
export function overrideView(
  base: ExerciseTemplate[],
  rows: StoredOverride[],
  onDate: string,
  today: string,
): SessionOverrideView | null {
  const active = rows.filter((r) => overrideActive(r, onDate, today))
  if (!active.length) return null
  const applied = applyOverrideOps(base, active.map((r) => r.ops))
  return {
    label: WEEK_ONLY_LABEL,
    date: onDate,
    override_ids: active.map((r) => r.id),
    expires_on: active.map((r) => r.expires_on).sort()[0],
    exercises: applied.exercises,
    marks: applied.marks,
    dropped: applied.dropped,
    moved_out: applied.movedOut,
    moved_in_from: applied.movedInFrom,
  }
}

// ---- diff -------------------------------------------------------------------------

export interface OverrideChange {
  kind: 'added' | 'removed' | 'changed'
  name: string
  before?: string
  after?: string
}

export function doseLine(ex: ExerciseTemplate): string {
  return [
    `${ex.sets}×${ex.reps}`,
    ex.load ? ex.load : null,
    ex.target_rpe != null ? `RPE ${ex.target_rpe}` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * What one dated session gains and loses. Before and after are both the
 * session as it would be served (template + any override already active), so
 * the diff is exactly what this request adds on top.
 */
export function diffOverride(before: AppliedOverride, after: AppliedOverride): OverrideChange[] {
  const changes: OverrideChange[] = []
  const wholeOut = after.movedOut.find((m) => m.name == null)
  if (wholeOut && !before.movedOut.some((m) => m.name == null)) {
    changes.push({ kind: 'removed', name: 'Whole session', before: `${before.exercises.length} exercises`, after: `moved to ${shortDateLabel(wholeOut.to_date)}` })
    return changes
  }
  if (after.movedInFrom && !before.movedInFrom) {
    changes.push({ kind: 'added', name: 'Whole session', after: `moved from ${shortDateLabel(after.movedInFrom)}` })
  }
  const used = new Set<number>()
  after.exercises.forEach((ex, i) => {
    const j = before.exercises.findIndex((b, k) => !used.has(k) && norm(b.name) === norm(ex.name))
    if (j < 0) {
      const mark = after.marks[i]
      const note = mark?.kind === 'swapped' && mark.from ? ` (for ${mark.from})`
        : mark?.kind === 'moved_in' && mark.from && !after.movedInFrom ? ` (from ${shortDateLabel(mark.from)})`
          : ''
      changes.push({ kind: 'added', name: ex.name, after: `${doseLine(ex)}${note}` })
      return
    }
    used.add(j)
    const b = before.exercises[j]
    if (doseLine(b) !== doseLine(ex)) changes.push({ kind: 'changed', name: ex.name, before: doseLine(b), after: doseLine(ex) })
  })
  before.exercises.forEach((b, k) => {
    if (used.has(k)) return
    const moved = after.movedOut.find((m) => m.name != null && norm(m.name) === norm(b.name))
    changes.push({
      kind: 'removed',
      name: b.name,
      before: doseLine(b),
      ...(moved ? { after: `moved to ${shortDateLabel(moved.to_date)}` } : {}),
    })
  })
  return changes
}

// ---- starting today's session (tracks_v1) ---------------------------------------

/**
 * The date the Workout screen sends /api/session-rx when it starts a session:
 * today, so today's week-only override applies. Null — and the request is
 * exactly the pre-override one — with the flag off, on an edit of a logged
 * session, or when logging into a week that isn't this one.
 */
export function workoutRxDate(o: { tracksOn: boolean; isEdit: boolean; week: { start: string; end: string } | null; today: string }): string | null {
  if (!o.tracksOn || o.isEdit) return null
  if (o.week && (o.today < o.week.start || o.today > o.week.end)) return null
  return o.today
}

/**
 * The session to train: the override's list replaces the template's when the
 * prescription carries one (its indexes follow that list). Otherwise the same
 * object back.
 */
export function sessionWithOverride<R extends { exercises: ExerciseTemplate[] }>(routine: R, override: SessionOverrideView | null | undefined): R {
  return override ? { ...routine, exercises: override.exercises } : routine
}
