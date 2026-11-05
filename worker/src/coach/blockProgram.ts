/**
 * A composed block's week as program sessions (G6 follow-up, coach_v1): the
 * week layout the composer produced (composer.ts) in, one routine per
 * training day out, with the exercises, sets, reps and RPE targets the
 * engine picks. Pure and deterministic, like the composer: the same block
 * always gives the same sessions. The coach never states a load: lifts carry
 * no `load` (a written load would beat the TM math, #49), so /api/session-rx
 * computes it from the block's tracks and progression rules (track_id).
 *
 *   lift     the main lift on the priority track when the block builds
 *            strength (the priority goal's lift on its day), the rest at
 *            maintenance on "Other lifts"; at maintenance, ~1/3 of the
 *            build volume on the strength track (U2).
 *   power    jumps sized to the block's contact budget (U14; under-18 cap),
 *            then acceleration starts. First in the session (U8).
 *   aerobic  bike unless the block runs (an endurance priority, with no
 *            red flag on a running region); a quality run is intervals.
 *   alactic  bike sprints as an interval block (HIIT for U9).
 *   prehab   the block's prehab items (already capped per session, rule 4).
 *
 * Red flags (U7, section 8): an exercise that loads a blocked region is never
 * written. It is listed in `held` instead, and a session left with nothing
 * in it is dropped. Under 18, no target RPE above the minors' cap (D6).
 */
import type { ExerciseTemplate } from '../../../src/types/database.ts'
import { canonicalLiftId, parseLiftId } from '../../../src/engine/liftModel.ts'
import { intervalReps } from '../../../src/engine/intervals.ts'
import { classify } from '../methodology/classify.ts'
import type { MinorsRules } from '../methodology/v1.ts'
import type { ComposedBlock, ComposedTrack, SessionUnit, WeekDay } from './composer.ts'
import { PREHAB, type PrehabKey } from './modules.ts'

export const BLOCK_PROGRAM_VERSION = 'block-program-v1'

/** An exercise as the block plans it: the track by name (its id exists only once the block is applied). */
export type BlockExercise = ExerciseTemplate & { track: string | null }

export interface BlockSession {
  name: string
  session_type: 'strength' | 'power' | 'conditioning'
  intent: string
  intended_dow: number
  exercises: BlockExercise[]
}

export interface HeldExercise {
  session: string
  exercise: string
  regions: string[]
}

export interface BlockSessions {
  sessions: BlockSession[]
  /** Left out because they load a red-flagged region (U7). Health data: redact for coaches without the toggle. */
  held: HeldExercise[]
}

export interface BlockSessionOpts {
  /** Red-flagged regions: never loaded. */
  blocked: string[]
  minor: boolean
  minors: MinorsRules
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Where running loads (the composer's run regions): a red flag here moves running to the bike. */
const RUN_REGIONS = ['knee', 'ankle', 'achilles', 'shin', 'foot', 'hip', 'hamstring']
const COD_REGIONS = ['knee', 'ankle', 'groin', 'hip']

const MAIN_LIFT: Record<string, string> = { squat: 'Back Squat', deadlift: 'Deadlift', bench: 'Bench Press', ohp: 'Overhead Press' }

/** Each prehab item as the exercises that dose it. Regions come from the item (classify can't place some names). */
const PREHAB_EXERCISES: Record<PrehabKey, Array<{ name: string; sets: number; reps: string }>> = {
  knee_ankle_tolerance: [{ name: 'Tibialis Raise', sets: 2, reps: '15' }, { name: 'Spanish Squat', sets: 3, reps: '30s' }],
  hip_ir_work: [{ name: '90/90 Hip Lift-Off', sets: 2, reps: '8 each side' }],
  calf_achilles: [{ name: 'Single-Leg Calf Raise', sets: 3, reps: '10 each side' }],
  single_leg_bridge_work: [{ name: 'Single-Leg Glute Bridge', sets: 2, reps: '12 each side' }],
  nordics: [{ name: 'Nordic Hamstring Curl', sets: 2, reps: '4-6' }],
  copenhagen: [{ name: 'Copenhagen Plank', sets: 2, reps: '20s each side' }],
  shoulder_flexion_work: [{ name: 'Wall Slide', sets: 2, reps: '10' }],
  pull_volume: [{ name: 'Face Pull', sets: 2, reps: '15' }],
  overhead_reach_work: [{ name: 'Thoracic Opener', sets: 2, reps: '8' }],
  deep_squat_work: [{ name: 'Goblet Squat Hold', sets: 3, reps: '30s' }],
  balance_work: [{ name: 'Single-Leg Balance', sets: 2, reps: '30s each side' }],
}

const PREHAB_TRACK: Record<PrehabKey, 'tissue_capacity' | 'mobility' | 'other_lifts'> = {
  knee_ankle_tolerance: 'tissue_capacity', hip_ir_work: 'mobility', calf_achilles: 'tissue_capacity',
  single_leg_bridge_work: 'tissue_capacity', nordics: 'tissue_capacity', copenhagen: 'tissue_capacity',
  shoulder_flexion_work: 'mobility', pull_volume: 'other_lifts', overhead_reach_work: 'mobility',
  deep_squat_work: 'mobility', balance_work: 'mobility',
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const range = (v: unknown, fallback: [number, number]): [number, number] =>
  (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? [v[0], v[1]] : fallback)

function focusOf(u: SessionUnit): 'lower' | 'upper' | 'full' {
  if (/^Lower\b/.test(u.label)) return 'lower'
  if (/^Upper\b/.test(u.label)) return 'upper'
  return 'full'
}

/** The lift the priority strength goal tests (squat, deadlift, bench, overhead press), if it names one. */
function priorityLift(block: ComposedBlock): string | null {
  for (const g of block.goals) {
    if (g.role !== 'priority' || g.quality !== 'max_strength') continue
    // "Back Squat 1RM", "Bench 225 lb": the lift, without the test or the number.
    const lift = g.name.replace(/\b(e?\d*\s?rm|max|test|pr)\b/gi, ' ').replace(/\b\d+(\.\d+)?\s*(lbs?|kg)?\b/gi, ' ').replace(/\s+/g, ' ').trim()
    const id = canonicalLiftId(lift) ?? parseLiftId(lift)
    if (id && MAIN_LIFT[id]) return id
  }
  return null
}

export function blockSessions(block: ComposedBlock, opts: BlockSessionOpts): BlockSessions {
  const blocked = [...new Set(opts.blocked)].sort()
  const rpeCap = opts.minor ? opts.minors.max_rpe : 10
  const track = (q: ComposedTrack['quality']) => block.tracks.find((t) => t.quality === q) ?? null
  const strength = track('max_strength')
  const other = track('other_lifts')
  const aerobic = track('aerobic')
  const alactic = track('alactic')
  const power = track('power')
  const cod = track('change_of_direction')
  const rpe = (n: number) => Math.min(n, rpeCap, num(strength?.params.max_rpe, 10))
  const pLift = priorityLift(block)
  const held: HeldExercise[] = []

  const ex = (name: string, sets: number, reps: string, t: ComposedTrack | null, extra: Partial<ExerciseTemplate> = {}): BlockExercise => ({
    name, sets, reps, ...extra, track: t?.name ?? null,
  })

  function lift(u: SessionUnit): BlockExercise[] {
    const focus = focusOf(u)
    const lowerMain = pLift === 'deadlift' ? MAIN_LIFT.deadlift : MAIN_LIFT.squat
    const upperMain = pLift === 'ohp' ? MAIN_LIFT.ohp : MAIN_LIFT.bench
    const names = focus === 'lower'
      ? [lowerMain, lowerMain === MAIN_LIFT.deadlift ? 'Split Squat' : 'Romanian Deadlift', lowerMain === MAIN_LIFT.deadlift ? 'Hip Thrust' : 'Split Squat']
      : focus === 'upper'
        ? [upperMain, 'Barbell Row', 'Pull-Up']
        : [lowerMain, upperMain, 'Barbell Row']
    if (u.role === 'priority') {
      const base = range(strength?.params.base_rpe, [7, 8])
      // The priority goal's lift carries the priority track (tm_wave); with no named lift, the day's first one does.
      const main = pLift ? names.find((n) => n === MAIN_LIFT[pLift]) ?? null : names[0]
      return names.map((n, i) => {
        if (n === main) return ex(n, 4, '5', strength, { target_rpe: rpe(base[1]), rest_s: 180 })
        const heavy = classify({ name: n, sets: 3, reps: '5' }).classes.has('heavy')
        // Accessories are the priority day's extra volume; the third slot of a full-body day is a main pattern.
        if (i === 2 && focus !== 'full') return ex(n, 3, '8-12', other ?? strength, { target_rpe: rpe(7), rest_s: 90 })
        return heavy
          ? ex(n, 3, '5', other ?? strength, { target_rpe: rpe(7), rest_s: 150 })
          : ex(n, 3, '6-8', other ?? strength, { target_rpe: rpe(7), rest_s: 120 })
      })
    }
    // Maintenance: ~1/3 of build volume at the same relative load (U2), no accessories.
    const maint = Math.min(rpe(8), num(strength?.params.max_rpe, 8))
    return names.slice(0, 2).map((n, i) => {
      const heavy = classify({ name: n, sets: 2, reps: '5' }).classes.has('heavy')
      return i === 0 || heavy
        ? ex(n, 2, '5', strength, { target_rpe: maint, rest_s: heavy ? 180 : 120 })
        : ex(n, 2, '8', strength, { target_rpe: rpe(7), rest_s: 120 })
    })
  }

  function jumps(): BlockExercise[] {
    const per = range(power?.params.contacts_per_session, block.contacts.per_session)
    const ceiling = opts.minor ? Math.min(per[1], opts.minors.contacts_per_session_max) : per[1]
    // The low end of the budget (conservative), split over two low-landing jumps (U14: broad, box first).
    const total = Math.max(0, Math.min(per[0], ceiling))
    const sets = 4
    const reps = Math.max(1, Math.floor(total / 2 / sets))
    return [
      ex('Broad Jump', sets, String(reps), power, { contacts: sets * reps, rest_s: 60 }),
      ex('Box Jump', sets, String(reps), power, { contacts: sets * reps, rest_s: 60 }),
      ex('Acceleration Sprint', 6, '10 yd', power, { cue: 'Full rest between starts', rest_s: 90 }),
    ]
  }

  function conditioning(u: SessionUnit): BlockExercise[] {
    if (u.kind === 'aerobic') {
      const runs = aerobic?.params.modality === 'run' && !RUN_REGIONS.some((r) => blocked.includes(r))
      if (u.hiit) {
        return runs
          ? [ex('Run Intervals', 1, intervalReps({ work: 180, rest: 120, rounds: 5 }), aerobic, { cue: u.label })]
          : [ex('Bike Intervals', 1, intervalReps({ work: 180, rest: 120, rounds: 5 }), aerobic, { cue: u.label })]
      }
      return [ex(runs ? 'Easy Run' : 'Bike', 1, `${u.minutes} min`, aerobic, { cue: u.label })]
    }
    const reps = range(alactic?.params.reps, [8, 10])
    const work = range(alactic?.params.work_s, [8, 10])
    const rest = range(alactic?.params.rest_s, [50, 60])
    return [ex('Bike Sprint', 1, intervalReps({ work: work[0], rest: rest[1], rounds: reps[0] }), alactic, { cue: u.label })]
  }

  function prehab(): Array<{ ex: BlockExercise; regions: string[] }> {
    return block.prehab.items.flatMap((item) => PREHAB_EXERCISES[item.key].map((p) => ({
      ex: ex(p.name, p.sets, p.reps, track(PREHAB_TRACK[item.key]), { load: 'bodyweight' }),
      regions: PREHAB[item.key].regions,
    })))
  }

  const sessions: BlockSession[] = []
  for (const day of block.week) {
    if (day.kind !== 'session' || !day.units.length) continue
    const name = sessionName(day)
    const out: BlockExercise[] = []
    const add = (list: Array<{ ex: BlockExercise; regions: string[] }>) => {
      for (const { ex: e, regions } of list) {
        const loads = [...new Set([...classify(e).regions, ...regions])]
        const hit = loads.filter((r) => blocked.includes(r))
        if (hit.length) held.push({ session: name, exercise: e.name, regions: hit.sort() })
        else out.push(e)
      }
    }
    for (const u of day.units) {
      const regions = u.kind === 'change_of_direction' ? COD_REGIONS : u.kind === 'aerobic' || u.kind === 'alactic' ? [] : u.regions
      switch (u.kind) {
        case 'lift': add(lift(u).map((e) => ({ ex: e, regions: [] }))); break
        case 'power': add(jumps().map((e) => ({ ex: e, regions }))); break
        case 'change_of_direction': add([{ ex: ex('5-10-5 Shuttle', num((cod?.params.reps as number[] | undefined)?.[0], 6), '1', cod, { cue: u.label, rest_s: 90 }), regions }]); break
        case 'aerobic':
        case 'alactic': add(conditioning(u).map((e) => ({ ex: e, regions }))); break
        case 'prehab': add(prehab()); break
      }
    }
    if (!out.length) continue
    const lifts = day.units.some((u) => u.kind === 'lift')
    sessions.push({
      name,
      session_type: lifts ? 'strength' : day.units.some((u) => u.kind === 'power' || u.kind === 'change_of_direction') ? 'power' : 'conditioning',
      intent: day.units.filter((u) => u.kind !== 'prehab').map((u) => u.label).join(' → ').slice(0, 500),
      intended_dow: day.dow,
      exercises: out,
    })
  }
  return { sessions, held }
}

function sessionName(day: WeekDay): string {
  const parts = day.units.filter((u) => u.kind !== 'prehab').map((u) => {
    if (u.kind === 'lift') {
      const f = focusOf(u)
      return f === 'lower' ? 'Lower' : f === 'upper' ? 'Upper' : 'Full body'
    }
    return u.name
  })
  return `${DAY[day.dow]}: ${[...new Set(parts)].join(' + ')}`
}

/** The sessions as the athlete and coach read them in a preview. */
export function sessionLines(s: BlockSession): string[] {
  return [
    `### ${s.name}`,
    ...s.exercises.map((e) => {
      const rpe = typeof e.target_rpe === 'number' ? ` @RPE ${e.target_rpe}` : ''
      const contacts = typeof e.contacts === 'number' ? ` (${e.contacts} contacts)` : ''
      return `- ${e.name}: ${e.sets} × ${e.reps}${rpe}${contacts}${e.track ? ` · ${e.track}` : ''}`
    }),
  ]
}
