// =============================================================================
// INTERVALS — a HIIT block as data. Read what the coach wrote, lay it out as a
// timeline, say where on that timeline the clock is, and file what was done.
//
// The coach already writes intervals into the program as a rep spec — "8 × 20s
// on / 40s off" is the program editor's own documented example — so the plan IS
// that string. Nothing new is stored: a finisher the athlete builds by hand is
// written back in exactly that shape, so the coach's blocks and the athlete's
// parse, log and display the same way.
//
// How a block maps onto the set grid it is logged into:
//
//   · reps carries a round count ("8 × 20s on / 40s off"), sets = 1 → one row is
//     the whole block of rounds; sets = 2 is the block twice, with a break
//   · reps carries no count ("20s on / 40s off"), sets = 8 → one row per round
//
// A row is a timed set: `duration` is the work it holds, never the rest.
//
// Pure, no I/O (see intervals.check.ts).
// =============================================================================

import type { ExerciseTemplate, SetLog } from '../types/database.ts'
import { fmtSkillDose, isSkillBlock } from './skillBlock.ts'

export interface IntervalPlan {
  /** Seconds of work in one round. */
  work: number
  /** Seconds between rounds. 0 runs straight through (EMOM). */
  rest: number
  /** Rounds in one set. */
  rounds: number
  /** How many times the whole block runs. */
  sets: number
  /** Seconds between sets. */
  setRest: number
  /** What one row of the set grid holds: a whole set of rounds, or one round. */
  rows: 'set' | 'round'
}

/** The beat before the first round — long enough to get on the bike. */
export const READY_SECONDS = 5

const MIN_WORK = 5
const MAX_WORK = 3600
const MAX_REST = 1800
const MAX_ROUNDS = 60
const MAX_SETS = 6

// A name that says "this is conditioning", which is what lets a bare "30/30"
// read as work / rest. On anything else "10/10" is ten reps a side.
const INTERVAL_NAME =
  /\b(intervals?|hiit|tabata|emom|finisher|conditioning|sprints?|shuttles?|bike|airdyne|assault|echo|erg|rower|rowing|ski|treadmill|run|jump rope|skipping|battle ropes?|burpees?|mountain climbers?|jumping jacks?|high knees|sled|prowler|swim|stair|elliptical)\b/

const REST_WORD = /\b(off|rest|recover|recovery|easy|walk|jog|float|break|between)\b/
const WORK_WORD = /\b(on|hard|work|sprint|fast|max|all ?out|go)\b/

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

interface ParsedReps {
  work: number
  rest: number
  /** The round count the spec states itself, when it does. */
  rounds: number | null
}

interface Token { secs: number; at: number; end: number }

// "20s", "45 sec", "1 min", "1.5 minutes", "4'", "1:30". Meters are not time:
// "400m" is a distance rep and stays out of this, which is why "m" alone is
// never read as minutes.
function durations(s: string): Token[] {
  const out: Token[] = []
  const unit = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|')(?![a-z])/g
  for (let m = unit.exec(s); m; m = unit.exec(s)) {
    const n = Number(m[1])
    const secs = /^(m|')/.test(m[2]) ? n * 60 : n
    out.push({ secs, at: m.index, end: m.index + m[0].length })
  }
  const clock = /(?<![\d.])(\d{1,2}):([0-5]\d)(?![\d:])/g
  for (let m = clock.exec(s); m; m = clock.exec(s)) {
    if (out.some((t) => m!.index < t.end && t.at < m!.index + m![0].length)) continue
    out.push({ secs: Number(m[1]) * 60 + Number(m[2]), at: m.index, end: m.index + m[0].length })
  }
  return out.sort((a, b) => a.at - b.at)
}

// "8 ×", "8 rounds", "x 8", "for 8 rounds", "8 efforts", "finisher 8x 15s".
function roundCount(s: string): number | null {
  const lead = s.match(/^\D{0,12}?(\d+)\s*(?:x|rounds?|sets? of|efforts?|reps? of|intervals?)(?![a-z])/)
  if (lead && !/^\s*(?:s|sec|min)/.test(s.slice((lead.index ?? 0) + lead[0].length))) return Number(lead[1])
  const tail = s.match(/(?:x|×)\s*(\d+)(?!\s*(?:s|sec|secs|seconds?|min|mins|minutes?|'|:|\d))\b/)
  if (tail) return Number(tail[1])
  const words = s.match(/\b(\d+)\s*(?:rounds?|efforts?|intervals?)\b/)
  if (words) return Number(words[1])
  // "N x" straight into a number, anywhere: the count of what follows.
  const mid = s.match(/(?:^|[^\d.])(\d+)\s*x\s*(?=\d)/)
  return mid ? Number(mid[1]) : null
}

// A parenthetical is usually a note — "(Tabata-ish)", "(2s pause)" — and is
// dropped. One that holds a whole work/rest pair is the block itself, the way
// "8x(15s hard / 45s easy)" writes it, and is kept.
function normalize(reps: string): string {
  return reps
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[–—]/g, '-')
    .replace(/\(([^)]*)\)/g, (_, inner: string) => (durations(inner).length >= 2 ? ` ${inner} ` : ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read a rep spec as intervals. `loose` also accepts the bare "30/30" and
 * "40:20" shorthands — only safe when the movement itself says conditioning.
 * Null when the spec isn't intervals at all, which is most of them.
 */
export function parseIntervalReps(reps: string | null | undefined, loose = false): ParsedReps | null {
  if (!reps) return null
  const raw = reps.toLowerCase()
  const s = normalize(reps)
  if (!s) return null
  const count = roundCount(s)

  // Tabata is a protocol, not a description: 8 × 20 / 10 unless it says otherwise.
  if (/\btabata\b/.test(raw)) {
    const d = durations(s)
    return {
      work: clamp(d[0]?.secs ?? 20, MIN_WORK, MAX_WORK),
      rest: clamp(d[1]?.secs ?? 10, 0, MAX_REST),
      rounds: clamp(count ?? 8, 1, MAX_ROUNDS),
    }
  }

  // Every minute on the minute — or every N minutes (E2MOM, "every 2 min").
  const emom = s.match(/\be(\d)mom\b/) ?? (/\bemom\b/.test(s) ? ['emom', '1'] : null)
    ?? s.match(/\bevery (\d+)?\s*min(?:ute)?s?\b/)
  if (emom) {
    const every = Number(emom[1] ?? 1) * 60
    const rest = s.replace(/\be\d?mom\b|\bevery (\d+)?\s*min(?:ute)?s?\b/, ' ')
    const minutes = rest.match(/(\d+)\s*(?:min|mins|minutes?|')(?![a-z])/)
    const bare = rest.match(/(?:^|\s|x)\s*(\d+)\b/)
    const rounds = count
      ?? (minutes ? Math.round((Number(minutes[1]) * 60) / every) : bare ? Number(bare[1]) : null)
    if (!rounds) return null
    return { work: every, rest: 0, rounds: clamp(rounds, 1, MAX_ROUNDS) }
  }

  // The shorthand goes first when nothing in the spec carries a unit: "30:30"
  // on a bike is thirty and thirty, not half an hour. "1:30" stays a clock —
  // a one-second effort isn't a round.
  if (loose && !/\d\s*(?:s|secs?|seconds?|mins?|minutes?|')(?![a-z])/.test(s)) {
    const short = s.match(/(?<![\d.])(\d{1,3})\s*[/:]\s*(\d{1,3})(?![\d.:])/)
    if (short) {
      const work = Number(short[1])
      const rest = Number(short[2])
      if (work >= MIN_WORK && work <= 300 && rest <= 300) {
        const n = roundCount(s.replace(short[0], ' '))
        return { work, rest, rounds: n != null ? clamp(n, 1, MAX_ROUNDS) : null }
      }
    }
  }

  const d = durations(s)
  if (d.length >= 2) {
    const [w, r] = d
    const between = s.slice(w.end, r.at)
    const after = s.slice(r.end, r.end + 14)
    const before = s.slice(w.end, w.end + 14)
    // Two durations alone could be a set and a tempo note; the shape has to say
    // work then rest — a separator between them, or the words on/off/easy.
    const structured = /[/,:+;]|\bthen\b|\bwith\b/.test(between)
      || REST_WORD.test(after) || WORK_WORD.test(before)
    if (structured && w.secs >= MIN_WORK && w.secs <= MAX_WORK && r.secs <= MAX_REST) {
      return {
        work: w.secs,
        rest: r.secs,
        rounds: count != null ? clamp(count, 1, MAX_ROUNDS) : null,
      }
    }
  }
  return null
}

/** Whether the movement's own name says conditioning. */
export function soundsLikeIntervals(name: string): boolean {
  return INTERVAL_NAME.test(name.toLowerCase())
}

/**
 * The block an exercise describes, or null when it isn't one. Pure function of
 * the prescription: the same exercise always gives the same timeline.
 *
 * `skill` (skill_blocks_v1, spec §12): a skill block is never a timer, however
 * its reps read — "6 × 10s / 50s" on a finishing station is advisory time, and
 * the athlete advances it. Off (the default), exactly as before.
 */
export function intervalPlanFor(
  ex: (Pick<ExerciseTemplate, 'name' | 'reps' | 'sets'> & Partial<Pick<ExerciseTemplate, 'kind'>>) | null | undefined,
  skill = false,
): IntervalPlan | null {
  if (!ex) return null
  if (skill && isSkillBlock(ex)) return null
  const p = parseIntervalReps(ex.reps, soundsLikeIntervals(ex.name ?? '')) ?? blockInName(ex.name, ex.reps)
  if (!p) return null
  const sets = clamp(Math.round(Number(ex.sets) || 1), 1, 10)
  const setRest = Math.max(60, p.rest)
  if (p.rounds == null) {
    // "20s on / 40s off" × 8 sets — each set IS a round.
    return { work: p.work, rest: p.rest, rounds: clamp(sets, 1, MAX_ROUNDS), sets: 1, setRest, rows: 'round' }
  }
  // "8 × 20s on / 40s off" with sets 8 is the same eight rounds said twice, not
  // sixty-four of them. More than a handful of repeats of a whole block reads
  // the same way: the spec is the dose, the set count is noise.
  if (sets === p.rounds || sets > MAX_SETS) {
    return { work: p.work, rest: p.rest, rounds: p.rounds, sets: 1, setRest, rows: 'round' }
  }
  return { work: p.work, rest: p.rest, rounds: p.rounds, sets, setRest, rows: 'set' }
}

/**
 * A block written into the NAME — "Bike finisher 8x(15s hard / 45s easy)" with
 * reps "8 rounds" — which is how a coach writing free text tends to put it.
 * A name is held to more than a rep spec is: a protocol named outright
 * (Tabata, EMOM), or a round count AND the words of a work/rest pair. "Plank
 * 30s / Side Plank 30s" is two holds, not a block.
 */
function blockInName(name: string | null | undefined, reps: string | null | undefined): ParsedReps | null {
  if (!name) return null
  const n = normalize(name)
  const p = parseIntervalReps(name)
  if (!p) return null
  if (/\b(tabata|e\d?mom)\b/.test(n)) return p
  const rounds = p.rounds ?? (reps ? roundCount(normalize(reps)) : null)
  if (rounds == null || !(REST_WORD.test(n) || WORK_WORD.test(n))) return null
  return { ...p, rounds: clamp(rounds, 1, MAX_ROUNDS) }
}

/**
 * What to call a block whose name carries its own dose: "Bike finisher
 * 8x(15s hard / 45s easy)" reads as "Bike finisher" above a block that already
 * says 8 × 15s / 45s. A name that doesn't carry one comes back unchanged.
 */
export function intervalTitle(name: string): string {
  if (!parseIntervalReps(name)) return name
  const at = name.search(/\s*[-–—:·,]?\s*\(?\s*\d+\s*(?:x|×|rounds?\b|s\b|secs?\b|seconds?\b|min|')/i)
  const title = at > 0 ? name.slice(0, at).trim() : ''
  return title || name
}

/**
 * The canonical shape for a block on its way into the program: the dose in
 * reps, in the coach's documented form, and the name just the movement. Null
 * when there is nothing to move — straight sets, or a block already written
 * where it belongs. Deterministic code disposes, whatever shape it was proposed in.
 */
export function canonicalBlock(
  ex: Pick<ExerciseTemplate, 'name' | 'reps' | 'sets'>,
): { name: string; reps: string } | null {
  if (parseIntervalReps(ex.reps, soundsLikeIntervals(ex.name))) return null
  const p = blockInName(ex.name, ex.reps)
  if (!p || p.rounds == null) return null
  return { name: intervalTitle(ex.name), reps: intervalReps({ work: p.work, rest: p.rest, rounds: p.rounds }) }
}

/** Whether a rep spec, on this movement, is a block rather than straight sets. */
export function isIntervalBlock(
  ex: (Pick<ExerciseTemplate, 'name' | 'reps' | 'sets'> & Partial<Pick<ExerciseTemplate, 'kind'>>) | null | undefined,
  skill = false,
): boolean {
  return intervalPlanFor(ex, skill) != null
}

// ---- the timeline -----------------------------------------------------------

export type PhaseKind = 'ready' | 'work' | 'rest' | 'break'

export interface Phase {
  kind: PhaseKind
  secs: number
  /** Seconds from the start of the timeline to the start of this phase. */
  start: number
  /** 1-based round within its set (0 on the ready beat). */
  round: number
  /** 1-based set (0 on the ready beat). */
  set: number
}

/**
 * Every phase in order: the ready beat, then work and rest, with a longer
 * break between sets. Nothing trails the last round — the block ends on work.
 */
export function buildTimeline(plan: IntervalPlan, ready = READY_SECONDS): Phase[] {
  const out: Phase[] = []
  let t = 0
  const push = (kind: PhaseKind, secs: number, round: number, set: number) => {
    if (secs <= 0) return
    out.push({ kind, secs, start: t, round, set })
    t += secs
  }
  push('ready', ready, 0, 0)
  for (let s = 1; s <= plan.sets; s++) {
    for (let r = 1; r <= plan.rounds; r++) {
      push('work', plan.work, r, s)
      const lastRound = r === plan.rounds
      if (!lastRound) push('rest', plan.rest, r, s)
      else if (s < plan.sets) push('break', plan.setRest, r, s)
    }
  }
  return out
}

/** Seconds from the first round to the last, ready beat excluded. */
export function blockSeconds(plan: IntervalPlan): number {
  const perSet = plan.rounds * plan.work + (plan.rounds - 1) * plan.rest
  return plan.sets * perSet + (plan.sets - 1) * plan.setRest
}

export function timelineSeconds(timeline: Phase[]): number {
  const last = timeline[timeline.length - 1]
  return last ? last.start + last.secs : 0
}

export interface ClockRead {
  index: number
  phase: Phase
  /** Seconds left in this phase. */
  remaining: number
  done: boolean
}

/** Where the clock is, `elapsed` seconds into the timeline. */
export function readClock(timeline: Phase[], elapsed: number): ClockRead {
  const total = timelineSeconds(timeline)
  if (!timeline.length || elapsed >= total) {
    const index = Math.max(0, timeline.length - 1)
    return { index, phase: timeline[index], remaining: 0, done: true }
  }
  const t = Math.max(0, elapsed)
  let index = 0
  while (index < timeline.length - 1 && timeline[index].start + timeline[index].secs <= t) index++
  const phase = timeline[index]
  return { index, phase, remaining: phase.start + phase.secs - t, done: false }
}

/**
 * Rounds of work finished by `elapsed`, per set. A work phase counts once its
 * clock has run out — or the athlete skipped what was left of it, which moves
 * `elapsed` past its end the same way.
 */
export function roundsDone(plan: IntervalPlan, timeline: Phase[], elapsed: number): number[] {
  const done = Array.from({ length: plan.sets }, () => 0)
  for (const p of timeline) {
    if (p.kind === 'work' && p.start + p.secs <= elapsed + 1e-6) done[p.set - 1]++
  }
  return done
}

// ---- filing it --------------------------------------------------------------

function blankRow(set: number): SetLog {
  return { set, weight: null, reps: null, rpe: null, done: false, duration: null, distance: null }
}

/**
 * The set grid for what's been done so far. Rows the plan has no use for stay
 * empty, and a block that runs longer than the grid grows it — the grid is a
 * record of the work, not a cap on it.
 */
export function intervalSetLogs(
  plan: IntervalPlan,
  done: readonly number[],
  rowCount: number,
  rpe: number | null = null,
): SetLog[] {
  const logged = (set: number, secs: number): SetLog => ({
    ...blankRow(set), duration: Math.round(secs), done: true, rpe,
  })
  if (plan.rows === 'set') {
    const n = Math.max(rowCount, plan.sets)
    return Array.from({ length: n }, (_, i) => {
      const r = done[i] ?? 0
      return r > 0 ? logged(i + 1, r * plan.work) : blankRow(i + 1)
    })
  }
  const total = done.reduce((a, b) => a + b, 0)
  const n = Math.max(rowCount, plan.sets * plan.rounds)
  return Array.from({ length: n }, (_, i) => (i < total ? logged(i + 1, plan.work) : blankRow(i + 1)))
}

/** Read the rounds back off a logged grid — the inverse of intervalSetLogs. */
export function roundsFromLogs(plan: IntervalPlan, logs: readonly SetLog[]): number[] {
  const done = Array.from({ length: plan.sets }, () => 0)
  if (plan.rows === 'set') {
    for (let i = 0; i < plan.sets; i++) {
      const row = logs[i]
      if (!row || (!row.done && row.duration == null)) continue
      const secs = row.duration ?? plan.rounds * plan.work
      done[i] = clamp(Math.round(secs / plan.work), 0, plan.rounds)
    }
    return done
  }
  done[0] = Math.min(plan.rounds * plan.sets, logs.filter((l) => l.done || l.duration != null).length)
  return done
}

// ---- reading it out ---------------------------------------------------------

/** "20s", "1 min", "1:30" — a duration as a coach would write it. */
export function fmtDuration(secs: number): string {
  const s = Math.round(secs)
  if (s < 60) return `${s}s`
  if (s % 60 === 0) return `${s / 60} min`
  return fmtClock(s)
}

/** "8:00" — a span on a clock face. */
export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The rep spec for a plan, in the shape the coach writes and this module reads:
 * "8 × 20s on / 40s off", "EMOM 10 min", "4 × 4 min on / 3 min off".
 */
export function intervalReps(plan: Pick<IntervalPlan, 'work' | 'rest' | 'rounds'>): string {
  if (plan.rest === 0 && plan.work % 60 === 0 && plan.work <= 300) {
    const every = plan.work / 60
    const minutes = plan.rounds * every
    return every === 1 ? `EMOM ${minutes} min` : `E${every}MOM ${minutes} min`
  }
  return `${plan.rounds} × ${fmtDuration(plan.work)} on / ${fmtDuration(plan.rest)} off`
}

/** What the athlete knows a block by, when it has a name. */
export function protocolName(plan: Pick<IntervalPlan, 'work' | 'rest' | 'rounds'>): string | null {
  if (plan.work === 20 && plan.rest === 10 && plan.rounds === 8) return 'Tabata'
  if (plan.rest === 0 && plan.work === 60) return 'EMOM'
  if (plan.work === 240 && plan.rest === 180 && plan.rounds === 4) return '4 × 4'
  return null
}

/** One line for a list: "8 × 20s / 40s", "2 × Tabata", "EMOM × 10". */
export function describePlan(plan: IntervalPlan): string {
  const name = protocolName(plan)
  const total = plan.rounds * plan.sets
  if (name === 'EMOM') return `EMOM × ${total}`
  if (name === 'Tabata') return plan.sets > 1 ? `${plan.sets} × Tabata` : 'Tabata · 8 × 20s / 10s'
  const core = `${plan.rounds} × ${fmtDuration(plan.work)} / ${fmtDuration(plan.rest)}`
  return plan.sets > 1 ? `${plan.sets} sets · ${core}` : core
}

/**
 * A prescription as one short string — the interval read when it is a block,
 * "3×8" otherwise. "1×8 × 20s on / 40s off" was the old rendering of a block.
 */
export function fmtDose(
  ex: Pick<ExerciseTemplate, 'name' | 'reps' | 'sets'> & Partial<Pick<ExerciseTemplate, 'kind' | 'window_s'>>,
  skill = false,
): string {
  if (skill && isSkillBlock(ex)) return fmtSkillDose(ex)
  const plan = intervalPlanFor(ex)
  return plan ? describePlan(plan) : `${ex.sets}×${ex.reps}`
}

/**
 * Seconds in a timed prescription's leading quantity: "30s" → 30, "10 min" →
 * 600, "1:30" → 90. Null when the spec isn't a duration.
 */
export function secondsFromReps(reps: string | null | undefined): number | null {
  if (!reps) return null
  const d = durations(normalize(reps).replace(/^\d+\s*x\s*/, ''))
  return d.length ? Math.round(d[0].secs) : null
}

// ---- building one by hand ----------------------------------------------------

export interface IntervalPreset {
  id: string
  label: string
  work: number
  rest: number
  rounds: number
}

/** The blocks people actually run, one tap each. Ordered short to long. */
export const INTERVAL_PRESETS: readonly IntervalPreset[] = [
  { id: 'tabata',  label: 'Tabata',   work: 20,  rest: 10,  rounds: 8 },
  { id: 'sprint',  label: '15 / 45',  work: 15,  rest: 45,  rounds: 10 },
  { id: '30-30',   label: '30 / 30',  work: 30,  rest: 30,  rounds: 10 },
  { id: '40-20',   label: '40 / 20',  work: 40,  rest: 20,  rounds: 8 },
  { id: 'emom',    label: 'EMOM 10',  work: 60,  rest: 0,   rounds: 10 },
  { id: '4x4',     label: '4 × 4',    work: 240, rest: 180, rounds: 4 },
]

/**
 * One tap of a stepper. Fine where a few seconds matter (a 20s sprint), coarse
 * where they don't (a 4-minute effort) — so no value is ever more than a few
 * taps from its neighbours.
 */
export function stepSeconds(value: number, dir: 1 | -1, min: number): number {
  const at = dir > 0 ? value : value - 1
  const step = at < 60 ? 5 : at < 180 ? 15 : 30
  return clamp(value + dir * step, min, MAX_WORK)
}

export const INTERVAL_LIMITS = { MIN_WORK, MAX_WORK, MAX_REST, MAX_ROUNDS, MAX_SETS } as const

/** A plan built by hand, clamped into what the timer will run. */
export function manualPlan(input: { work: number; rest: number; rounds: number; sets: number }): IntervalPlan {
  const work = clamp(Math.round(input.work), MIN_WORK, MAX_WORK)
  const rest = clamp(Math.round(input.rest), 0, MAX_REST)
  return {
    work,
    rest,
    rounds: clamp(Math.round(input.rounds), 1, MAX_ROUNDS),
    sets: clamp(Math.round(input.sets), 1, MAX_SETS),
    setRest: Math.max(60, rest),
    rows: 'set',
  }
}

/**
 * The exercise a hand-built block is filed as. One row per set; the spec names
 * the rounds, so it reads back through intervalPlanFor as the same plan.
 */
export function intervalExercise(name: string, plan: IntervalPlan): ExerciseTemplate {
  return {
    name,
    sets: plan.sets,
    reps: intervalReps(plan),
    tracking_type: 'time',
    load: 'bodyweight',
  }
}
