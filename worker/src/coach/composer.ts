/**
 * The composer (G6, coach_v1; spec section 4): an athlete's activities and
 * goals in, one proposed block out. Pure and deterministic: no clock, no
 * randomness, no I/O. The same input always gives the same block, and the
 * I/O half (activities.ts) keeps it as a preview until the athlete approves.
 *
 *   1. merge demands   every active activity's qualities, weighted by
 *                      sessions/week and in- or off-season.
 *   2. goals override  a priority goal makes its quality a priority track;
 *                      max 2 per block (U2). Everything else is maintenance
 *                      or the minimum dose.
 *   3. activity load   the activities' own sessions (planned, or logged when
 *                      more) count toward conditioning, contacts (U14) and
 *                      interference (U9) before the engine adds work.
 *   4. prehab/screens  the union across activities, deduped, ordered by
 *                      injury history then pain, capped per session.
 *   5. conflicts       priorities that interfere, more priorities than U2
 *                      allows, or work that doesn't fit the days and minutes
 *                      become trade-offs the athlete picks. A goal is never
 *                      dropped: every goal in is a goal out, with its role.
 *   6. re-compose      the block records what it was composed from, so the
 *                      I/O half can tell when an activity or goal changed or
 *                      the block ended (recomposeReason).
 *
 * Output: tracks (role, engine, params), the week layout, the deload week and
 * the retest week, with rule refs. Red-flagged regions are never loaded (U7).
 */
import type { MethodologyParams, MinorsRules, PainRegion } from '../methodology/v1.ts'
import {
  COMPOSER_V1, MODULE_KEYS, MODULES, MODULES_V1_VERSION, PREHAB, QUALITIES, QUALITY_LABEL, SCREENS,
  type ComposerConfig, type ModuleKey, type PrehabKey, type Quality, type ScreenKey,
} from './modules.ts'

export type Season = 'in' | 'off'
export type TrainingAge = 'lt1' | '1to3' | '3to10' | '10plus'
export const TRAINING_AGES: TrainingAge[] = ['lt1', '1to3', '3to10', '10plus']
export type GoalWeight = 'priority' | 'maintenance'

export interface ComposeActivity {
  id?: string | null
  module: ModuleKey
  name: string
  sessions_per_week: number
  season: Season
  /** 0 = Mon … 6 = Sun. */
  days: number[]
  active?: boolean
}

export interface ComposeGoal {
  id?: string | null
  name: string
  /** The test exercise or event, e.g. "Back Squat 1RM", "Half marathon". */
  test?: string | null
  quality?: Quality | null
  weight: GoalWeight
  due_date?: string | null
}

export interface ComposeSchedule {
  /** Hard max of training days the engine fills (the activities' own days are extra). */
  days_per_week: number
  minutes_per_session: number
  rest_days: number[]
}

export interface ComposeInjury {
  region: PainRegion
  /** A past injury here. */
  history: boolean
  /** Pain now, 0–10, if any. */
  pain: number | null
}

export interface ComposeInput {
  /** Monday the block starts, YYYY-MM-DD. */
  start: string
  activities: ComposeActivity[]
  goals: ComposeGoal[]
  schedule: ComposeSchedule
  training_age: TrainingAge
  minor: boolean
  age?: number | null
  injuries: ComposeInjury[]
  /** Red-flagged regions (U7, section 8): never loaded. */
  blocked_regions: string[]
  /** Sessions a week actually logged per activity id, recent average. More than planned counts. */
  logged_sessions_per_week?: Record<string, number>
  params: MethodologyParams
  minors: MinorsRules
  /** Trade-off id → the option the athlete picked. */
  resolutions?: Record<string, string>
}

export type Role = 'priority' | 'maintenance' | 'minimum'

export interface ComposedTrack {
  name: string
  quality: Quality | 'other_lifts'
  role: Role
  engine_type: 'tm_wave' | 'maintenance' | 'time_interval' | 'contacts' | 'double_progression' | 'measurement'
  params: Record<string, unknown>
  /** Sessions a week the engine adds for it. */
  sessions_per_week: number
  /** Sessions a week the athlete's activities already supply. */
  supplied_by_activities: number
  why: string
  rule_refs: string[]
}

export interface ComposedGoal {
  id: string | null
  name: string
  quality: Quality | null
  requested: GoalWeight
  role: Role | 'held' | 'unassigned'
  track: string | null
  note: string | null
}

export type UnitKind = 'lift' | 'power' | 'aerobic' | 'alactic' | 'change_of_direction' | 'prehab'

export interface SessionUnit {
  kind: UnitKind
  /** Short name: "Priority lift", "Repeat sprint". */
  name: string
  quality: Quality | null
  role: Role
  label: string
  minutes: number
  /** HIIT for U9: counts toward the cap and the day-before rule. */
  hiit: boolean
  /** Lifting: a heavy lower or priority lift (U9 day-before rule). */
  heavy: boolean
  regions: string[]
}

export interface WeekDay {
  dow: number
  kind: 'session' | 'activity' | 'rest' | 'off'
  /** Activities on this day (counted as load). */
  activities: string[]
  units: SessionUnit[]
  minutes: number
}

export interface TradeOffOption { id: string; label: string; effect: string }

export interface TradeOff {
  id: 'interference' | 'priority_cap' | 'time_budget'
  rule_refs: string[]
  message: string
  options: TradeOffOption[]
  default: string
  chosen: string | null
}

export interface ComposedBlock {
  modules_version: string
  start: string
  weeks: number
  build_weeks: number
  deload_week: { start: string; end: string; rule_refs: string[]; note: string }
  retest_week: { start: string; end: string; order: string[]; rule_refs: string[] }
  end: string
  minor: boolean
  demands: Record<string, number>
  priorities: Quality[]
  tracks: ComposedTrack[]
  goals: ComposedGoal[]
  activity_load: {
    sessions_per_week: number
    supplies: Partial<Record<Quality, number>>
    contacts_per_week: number
    hard_leg_days: number[]
  }
  contacts: { per_session: [number, number]; level: string; progression: string[] }
  week: WeekDay[]
  prehab: { items: Array<{ key: PrehabKey; name: string; dose: string; minutes: number; why: string | null }>; minutes: number; deferred: PrehabKey[] }
  screens: Array<{ key: ScreenKey; name: string; unit: string; sided: boolean }>
  held: Array<{ what: string; regions: string[]; note: string }>
  trade_offs: TradeOff[]
  needs_decision: boolean
  warnings: string[]
  rule_refs: string[]
}

export const REFER_OUT_SHORT = 'Red-flagged (U7): not loaded until a clinician clears it.'

// ---- helpers --------------------------------------------------------------------------------

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function capRange(r: [number, number], max: number): [number, number] {
  return [Math.min(r[0], max), Math.min(r[1], max)]
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x))
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

function sortRefs(refs: string[]): string[] {
  return uniq(refs).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}

const RUN_RE = /\b(run|running|jog|marathon|half[- ]?marathon|10 ?k|5 ?k|mile|race|trail|ultra)\b/i
const RIDE_RE = /\b(ride|cycl\w*|bike|gran fondo|century)\b/i

/**
 * The quality a goal trains, from its name or test, when nobody said.
 * Null when nothing matches: the goal is kept and flagged, never guessed.
 */
export function classifyGoal(g: Pick<ComposeGoal, 'name' | 'test'>): Quality | null {
  const t = `${g.name} ${g.test ?? ''}`.toLowerCase()
  if (/repeat[- ]sprint|shuttle|yo-?yo|beep test|\brsa\b/.test(t)) return 'alactic'
  if (RUN_RE.test(t) || RIDE_RE.test(t) || /\b(swim|rowing|rower|erg|vo2|aerobic|endurance|triathlon|zone 2)\b|\b\d+ ?k ?(row|erg)\b|\b(row|erg) ?\d+ ?k\b/.test(t)) return 'aerobic'
  if (/agility|5-10-5|pro[- ]agility|t-test|change of direction|lateral/.test(t)) return 'change_of_direction'
  if (/vertical|broad jump|\bjump|sprint|\b(10|20|40) ?(yd|yard|m)\b|acceleration|\bthrow|power clean|\bpower\b/.test(t)) return 'power'
  if (/calf raise|nordic|tendon|copenhagen|single[- ]leg bridge|achilles/.test(t)) return 'tissue_capacity'
  if (/mobility|overhead reach|knee[- ]to[- ]wall|hip ir|internal rotation|flexion|toe touch|\bsplits?\b|deep squat/.test(t)) return 'mobility'
  if (/squat|bench|deadlift|press|clean|snatch|jerk|\b1 ?rm\b|e1rm|pull-?up|chin-?up|\brow\b|strength|\b(lb|kg)\b/.test(t)) return 'max_strength'
  return null
}

/** An aerobic goal that is a run (or ride): brings the endurance module's rules, screens and prehab. */
function enduranceModality(g: Pick<ComposeGoal, 'name' | 'test'>): 'run' | 'ride' | null {
  const t = `${g.name} ${g.test ?? ''}`
  if (RUN_RE.test(t)) return 'run'
  if (RIDE_RE.test(t)) return 'ride'
  return null
}

function byDueThenOrder(a: { g: ComposeGoal; i: number }, b: { g: ComposeGoal; i: number }): number {
  const ad = a.g.due_date ?? null
  const bd = b.g.due_date ?? null
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1
  if (ad && !bd) return -1
  if (!ad && bd) return 1
  return a.i - b.i
}

// ---- compose ---------------------------------------------------------------------------------

export function compose(input: ComposeInput, cfg: ComposerConfig = COMPOSER_V1): ComposedBlock {
  const p = input.params
  const minor = input.minor
  const resolutions = input.resolutions ?? {}
  const warnings: string[] = []
  const refs: string[] = ['U2']
  const blocked = uniq(input.blocked_regions).sort()
  const rpeCap = minor ? input.minors.max_rpe : 10
  const cap = (r: [number, number]): [number, number] => capRange(r, rpeCap)

  // 1. Merge demands, weighted by sessions/week and season.
  const active = input.activities.filter((a) => a.active !== false && MODULES[a.module])
  const raw: Record<Quality, number> = Object.fromEntries(QUALITIES.map((q) => [q, 0])) as Record<Quality, number>
  for (const a of active) {
    const w = Math.max(0, a.sessions_per_week) * (a.season === 'in' ? 1 : cfg.off_season_weight)
    for (const [q, d] of Object.entries(MODULES[a.module].demands) as Array<[Quality, number]>) raw[q] += d * w
  }
  const top = Math.max(0, ...Object.values(raw))
  const demand: Record<Quality, number> = Object.fromEntries(QUALITIES.map((q) => [q, top > 0 ? round2(raw[q] / top) : 0])) as Record<Quality, number>

  // 3 (first, the rest reads it). What the activities already supply.
  const sessionsOf = (a: ComposeActivity) => Math.max(a.sessions_per_week, (a.id && input.logged_sessions_per_week?.[a.id]) || 0)
  const supplied: Partial<Record<Quality, number>> = {}
  let activityContacts = 0
  let activitySessions = 0
  const hardLegDays = new Set<number>()
  const activityDays = new Map<number, string[]>()
  let sportWeekContacts = false
  for (const a of active) {
    const m = MODULES[a.module]
    const n = sessionsOf(a)
    activitySessions += n
    for (const q of m.load.supplies) supplied[q] = (supplied[q] ?? 0) + n
    activityContacts += n * m.load.contacts
    if (m.load.contacts > 0 && a.season === 'in' && n > 0) sportWeekContacts = true
    for (const d of a.days) {
      if (d < 0 || d > 6) continue
      activityDays.set(d, [...(activityDays.get(d) ?? []), a.name])
      if (m.load.hard_legs) hardLegDays.add(d)
    }
  }
  if (active.length) refs.push('U9', 'U14')

  // 2. Goals override. Classify, then order priority goals by date, then as given.
  const goals = input.goals.map((g, i) => ({ g, i, quality: g.quality ?? classifyGoal(g) }))
  for (const x of goals) {
    if (!x.quality) warnings.push(`"${x.g.name}" doesn't name a quality the engine can train; it is kept as a goal with no track. Set its quality.`)
  }
  const priorityGoals = goals.filter((x) => x.g.weight === 'priority' && x.quality).sort(byDueThenOrder)
  let requested = uniq(priorityGoals.map((x) => x.quality!))
  const tradeOffs: TradeOff[] = []
  const downgradedBy = new Map<Quality, string>()

  // An endurance priority and a strength priority interfere (U9; Wilson 2012):
  // the athlete picks. Default: the goal due first leads.
  const runGoal = priorityGoals.find((x) => x.quality === 'aerobic' && enduranceModality(x.g))
  const strengthGoal = priorityGoals.find((x) => x.quality === 'max_strength')
  if (runGoal && strengthGoal) {
    const endurFirst = byDueThenOrder(runGoal, strengthGoal) < 0
    const t: TradeOff = {
      id: 'interference',
      rule_refs: ['U2', 'U9'],
      message: `"${runGoal.g.name}" and "${strengthGoal.g.name}" both want to be the priority, and endurance volume and strength work interfere (U9). Pick which one leads this block; the other is held at maintenance, not dropped.`,
      options: [
        { id: 'endurance_first', label: `${runGoal.g.name} leads`, effect: `Running is a priority track; lifting drops to maintenance (~1/3 volume, same relative load). "${strengthGoal.g.name}" is held, not built, this block.` },
        { id: 'strength_first', label: `${strengthGoal.g.name} leads`, effect: `Lifting stays the priority; running holds at maintenance volume, so race readiness may lag "${runGoal.g.name}".` },
        { id: 'both', label: 'Both as priorities', effect: 'Both build, each more slowly, and the week needs more days or longer sessions.' },
      ],
      default: endurFirst ? 'endurance_first' : 'strength_first',
      chosen: null,
    }
    const pick = resolutions[t.id]
    t.chosen = t.options.some((o) => o.id === pick) ? pick : null
    tradeOffs.push(t)
    refs.push('U9')
    const eff = t.chosen ?? t.default
    if (eff === 'endurance_first') {
      requested = requested.filter((q) => q !== 'max_strength')
      downgradedBy.set('max_strength', 'interference')
    } else if (eff === 'strength_first') {
      requested = requested.filter((q) => q !== 'aerobic')
      downgradedBy.set('aerobic', 'interference')
    }
  }

  // U2: max 2 priority qualities a block. More → the athlete picks the two.
  const maxPriority = p.U2.max_priority_tracks
  if (requested.length > maxPriority) {
    const pool = requested.slice(0, 4)
    const pairs: Quality[][] = []
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) pairs.push([pool[i], pool[j]])
    const options = (maxPriority === 2 ? pairs : [pool.slice(0, maxPriority)]).map((pair) => ({
      id: `keep:${pair.join('+')}`,
      label: pair.map((q) => QUALITY_LABEL[q]).join(' + '),
      effect: `${pair.map((q) => QUALITY_LABEL[q]).join(' and ')} build; ${requested.filter((q) => !pair.includes(q)).map((q) => QUALITY_LABEL[q]).join(', ')} hold at maintenance.`,
    }))
    const t: TradeOff = {
      id: 'priority_cap',
      rule_refs: ['U2'],
      message: `${requested.length} goals want priority, and a block builds at most ${maxPriority} (U2). Pick which ${maxPriority} lead; the rest are held at maintenance, not dropped.`,
      options,
      default: options[0].id,
      chosen: null,
    }
    const pick = resolutions[t.id]
    t.chosen = options.some((o) => o.id === pick) ? pick : null
    tradeOffs.push(t)
    const keep = (t.chosen ?? t.default).slice('keep:'.length).split('+') as Quality[]
    for (const q of requested) if (!keep.includes(q)) downgradedBy.set(q, 'priority_cap')
    requested = requested.filter((q) => keep.includes(q))
  }
  const priorities = requested

  // Which qualities this athlete needs at all.
  const goalQualities = new Set(goals.map((x) => x.quality).filter((q): q is Quality => q != null))
  const present = QUALITIES.filter((q) => demand[q] >= cfg.min_demand || goalQualities.has(q))
  const enduranceGoal = goals.find((x) => x.quality === 'aerobic' && enduranceModality(x.g) && priorities.includes('aerobic'))
  const modality = enduranceGoal ? enduranceModality(enduranceGoal.g)! : null
  const strengthPriority = priorities.includes('max_strength')

  // Contacts (U14): conservative when games share the week; minors lower.
  const levelByAge: Record<TrainingAge, keyof MethodologyParams['U14']['contacts_per_session']> = {
    lt1: 'beginner', '1to3': 'beginner', '3to10': 'intermediate', '10plus': 'advanced',
  }
  let level: keyof MethodologyParams['U14']['contacts_per_session'] = sportWeekContacts ? 'return_or_sport_week' : levelByAge[input.training_age]
  if (minor) level = 'return_or_sport_week'
  let perSession = [...p.U14.contacts_per_session[level]] as [number, number]
  if (minor) perSession = capRange(perSession, input.minors.contacts_per_session_max)

  // ---- units the engine adds -------------------------------------------------------------
  const units: SessionUnit[] = []
  const held: ComposedBlock['held'] = []
  const tracks: ComposedTrack[] = []
  const roleOf = new Map<Quality, Role>()

  const liftRegionsLower = ['knee', 'hip', 'low_back', 'ankle']
  const runRegions = ['knee', 'ankle', 'achilles', 'shin', 'foot', 'hip', 'hamstring']
  const jumpRegions = ['knee', 'ankle', 'achilles', 'foot', 'shin', 'hamstring', 'hip']
  const codRegions = ['knee', 'ankle', 'groin', 'hip']

  for (const q of present) {
    const isPriority = priorities.includes(q)
    const sup = supplied[q] ?? 0
    const ref = (xs: string[]) => sortRefs(xs)
    switch (q) {
      case 'max_strength': {
        const exposures = sup
        const want = isPriority ? cfg.lift_sessions.priority : cfg.lift_sessions.maintenance
        const add = isPriority ? Math.max(1, want - exposures) : Math.max(0, want - exposures)
        const role: Role = isPriority ? 'priority' : add > 0 ? 'maintenance' : 'minimum'
        roleOf.set(q, role)
        const base = cap(p.U5.base_rpe)
        const topSingle = cap(p.U5.top_single_rpe)
        const highEnd = (input.age ?? 0) >= p.U2.higher_end_from_age
        const maintFraction = highEnd ? p.U2.maintenance_volume_fraction[1] : p.U2.maintenance_volume_fraction[0]
        for (let i = 0; i < add; i++) {
          const lower = add === 1 ? false : i % 2 === 0
          units.push({
            kind: 'lift',
            name: isPriority ? 'Priority lift' : 'Maintenance lift',
            quality: q,
            role,
            label: isPriority
              ? `${lower ? 'Lower' : add === 1 ? 'Full body' : 'Upper'} lift (priority): base RPE ${base[0]}–${base[1]}, top single RPE ${topSingle[0]}–${topSingle[1]}; other lifts at maintenance`
              : `${lower ? 'Lower' : add === 1 ? 'Full body' : 'Upper'} lift at maintenance: ~${Math.round(maintFraction * 100)}% of build volume, same relative load`,
            minutes: isPriority ? cfg.lift_minutes.priority : cfg.lift_minutes.maintenance,
            hiit: false,
            heavy: isPriority || lower,
            regions: lower ? liftRegionsLower : [],
          })
        }
        tracks.push({
          name: QUALITY_LABEL[q],
          quality: q,
          role,
          engine_type: isPriority ? 'tm_wave' : 'maintenance',
          params: isPriority
            ? { tm_fraction: p.U4.tm_fraction, base_rpe: base, top_single_rpe: topSingle, build_weeks: cfg.build_weeks, max_rpe: rpeCap }
            : { volume_fraction: maintFraction, same_relative_load: true, max_rpe: Math.min(rpeCap, p.U12.maintenance_held_at_rpe) },
          sessions_per_week: add,
          supplied_by_activities: exposures,
          why: isPriority
            ? 'A priority goal makes max strength a priority track (U2); training max at 90% of e1RM (U4), RPE 7–8 base work (U5), ≥1 heavy exposure a week (U1).'
            : downgradedBy.has(q)
              ? 'Held at maintenance this block by the trade-off below (U2): ~1/3 of build volume at the same relative load.'
              : 'Not a priority this block: maintenance, ~1/3 of build volume at the same relative load (U2).',
          rule_refs: ref(isPriority ? ['U1', 'U2', 'U4', 'U5'] : ['U2', 'U12']),
        })
        if (isPriority) {
          tracks.push({
            name: 'Other lifts',
            quality: 'other_lifts',
            role: 'maintenance',
            engine_type: 'maintenance',
            params: { volume_fraction: maintFraction, same_relative_load: true, max_rpe: Math.min(rpeCap, p.U12.maintenance_held_at_rpe) },
            sessions_per_week: 0,
            supplied_by_activities: 0,
            why: 'Lifts outside the priority run at maintenance inside the same sessions (U2).',
            rule_refs: ['U2'],
          })
        }
        refs.push('U1', 'U4', 'U5')
        break
      }
      case 'aerobic':
      case 'alactic':
      case 'change_of_direction': {
        const dose = cfg.dose[q]
        const want = isPriority ? dose.priority_sessions : dose.maintenance_sessions
        let add = Math.max(0, want - sup)
        const role: Role = isPriority ? 'priority' : add > 0 ? 'maintenance' : 'minimum'
        roleOf.set(q, role)
        const isRun = q === 'aerobic' && modality === 'run'
        const mode = q === 'change_of_direction' ? null
          : isRun ? 'run'
            : strengthPriority && !isPriority ? 'bike or rower'
              : modality === 'ride' ? 'bike' : 'any'
        let regions = q === 'change_of_direction' ? codRegions : mode === 'run' ? runRegions : []
        let note: string | null = null
        if (intersects(regions, blocked) && q !== 'change_of_direction') {
          // Swap impact for a bike or rower rather than loading a blocked region.
          regions = []
          note = `Moved to bike or rower: ${blocked.filter((r) => runRegions.includes(r)).join(', ')} is red-flagged (U7).`
          warnings.push(note)
        }
        if (q === 'alactic' || q === 'change_of_direction') refs.push('U9')
        // U9: the engine adds at most hiit_max_per_week HIIT sessions (sport is extra).
        if (q === 'alactic') {
          const room = Math.max(0, p.U9.hiit_max_per_week - units.filter((u) => u.hiit).length)
          if (add > room) {
            warnings.push(`Repeat-sprint work capped at ${room} added session${room === 1 ? '' : 's'} a week: HIIT stays ≤${p.U9.hiit_max_per_week}×/wk plus sport (U9).`)
            add = room
          }
        }
        if (q === 'change_of_direction' && intersects(regions, blocked)) {
          held.push({ what: dose.session, regions: regions.filter((r) => blocked.includes(r)), note: REFER_OUT_SHORT })
          add = 0
        }
        // Endurance priority: polarized ~80/20, volume up ≤10%/wk (standard-practice defaults).
        const endurance = MODULES.endurance.rules
        const hardRuns = isRun && isPriority ? Math.max(1, Math.round(add * (1 - (endurance.polarized_easy_fraction ?? 0.8)))) : 0
        for (let i = 0; i < add; i++) {
          const hard = q === 'alactic' || (isRun && i < hardRuns)
          units.push({
            kind: q,
            name: q === 'aerobic' ? (hard ? 'Quality run' : 'Aerobic') : q === 'alactic' ? 'Repeat sprint' : 'Change of direction',
            quality: q,
            role,
            label: q === 'aerobic'
              ? hard
                ? `Quality run 20–30 min (tempo or intervals), ${isPriority ? 'priority' : 'maintenance'}`
                : `${dose.session}${mode && mode !== 'any' ? `, ${mode}` : ''}${isRun && isPriority && i === add - 1 ? ' (long run: build ≤10%/wk)' : ''}`
              : q === 'alactic'
                ? `${dose.session}${mode && mode !== 'any' ? `, ${mode}` : ''}`
                : dose.session,
            minutes: hard && q === 'aerobic' ? 30 : dose.minutes,
            hiit: hard,
            heavy: false,
            regions,
          })
        }
        tracks.push({
          name: QUALITY_LABEL[q],
          quality: q,
          role,
          engine_type: q === 'change_of_direction' ? 'contacts' : 'time_interval',
          params: q === 'aerobic'
            ? {
                minutes: [30, 40], hr: [120, 150], modality: mode,
                ...(isRun && isPriority ? { polarized_easy_fraction: endurance.polarized_easy_fraction, weekly_volume_increase_max: endurance.weekly_volume_increase_max, strides_per_week: endurance.strides_per_week } : {}),
              }
            : q === 'alactic'
              ? { reps: [8, 10], work_s: [8, 10], rest_s: [50, 60], modality: mode }
              : { reps: [6, 8], rest: 'full' },
          sessions_per_week: add,
          supplied_by_activities: sup,
          why: role === 'minimum'
            ? `Covered by your activities (${sup}×/wk count as ${QUALITY_LABEL[q].toLowerCase()} work), so the engine adds nothing (section 4).`
            : isPriority
              ? `A priority goal makes ${QUALITY_LABEL[q].toLowerCase()} a priority track (U2).${note ? ` ${note}` : ''}`
              : `${want}×/wk at maintenance; your activities supply ${sup}, so the engine adds ${add} (section 4).${mode === 'bike or rower' ? ' Bike or rower, not running, while strength is the priority (U9).' : ''}${note ? ` ${note}` : ''}`,
          rule_refs: ref(q === 'aerobic' ? ['U2', 'U9'] : ['U2', 'U9', 'U14']),
        })
        break
      }
      case 'power': {
        const dose = cfg.dose.power
        const n = isPriority ? dose.priority_sessions : dose.maintenance_sessions
        const role: Role = isPriority ? 'priority' : 'maintenance'
        roleOf.set(q, role)
        const label = `${sportWeekContacts ? cfg.power_in_sport_week : dose.session}; jumps ${perSession[0]}–${perSession[1]} contacts, low-landing first (broad, box) (U14)`
        if (intersects(jumpRegions, blocked)) {
          held.push({ what: 'Jumps and acceleration starts', regions: jumpRegions.filter((r) => blocked.includes(r)), note: REFER_OUT_SHORT })
        } else {
          for (let i = 0; i < n; i++) units.push({ kind: 'power', name: 'Power', quality: q, role, label, minutes: dose.minutes, hiit: false, heavy: false, regions: jumpRegions })
        }
        tracks.push({
          name: QUALITY_LABEL[q],
          quality: q,
          role,
          engine_type: 'contacts',
          params: { contacts_per_session: perSession, level, progression: ['broad', 'box', 'bounds', 'hops', 'reactive'], starts: '6–10 × 5–10 yd, full rest' },
          sessions_per_week: intersects(jumpRegions, blocked) ? 0 : n,
          supplied_by_activities: supplied.power ?? 0,
          why: `Power is speed work before the heavy lift (U8): ${perSession[0]}–${perSession[1]} contacts a session${sportWeekContacts ? ', conservative because games share the week' : ''}${minor ? ', lower for under-18' : ''} (U14).`,
          rule_refs: ['U8', 'U14'],
        })
        refs.push('U8', 'U14')
        break
      }
      case 'tissue_capacity':
      case 'mobility': {
        const role: Role = isPriority ? 'priority' : 'maintenance'
        roleOf.set(q, role)
        tracks.push({
          name: QUALITY_LABEL[q],
          quality: q,
          role,
          engine_type: q === 'tissue_capacity' ? 'double_progression' : 'measurement',
          params: q === 'tissue_capacity' ? { via: 'prehab', reps_top_of_range_adds_load: true } : { via: 'screens', retest: 'monthly' },
          sessions_per_week: 0,
          supplied_by_activities: 0,
          why: q === 'tissue_capacity'
            ? 'Trained in the prehab block of each session (section 4 rule 4); progresses by double progression (U3).'
            : 'Tracked by the screens, retested monthly (section 5); trained in the prehab block.',
          rule_refs: q === 'tissue_capacity' ? ['U3'] : ['U12'],
        })
        break
      }
    }
  }

  // ---- 4. prehab and screens ----------------------------------------------------------------
  const weightOf = (a: ComposeActivity) => sessionsOf(a) * (a.season === 'in' ? 1 : cfg.off_season_weight)
  const moduleOrder: ModuleKey[] = []
  for (const a of [...active].sort((x, y) => weightOf(y) - weightOf(x) || MODULE_KEYS.indexOf(x.module) - MODULE_KEYS.indexOf(y.module))) {
    if (!moduleOrder.includes(a.module)) moduleOrder.push(a.module)
  }
  if (modality === 'run' && !moduleOrder.includes('endurance')) moduleOrder.push('endurance')
  const historyRegions = new Set(input.injuries.filter((i) => i.history).map((i) => i.region))
  const painOf = (regions: string[]) => Math.max(0, ...input.injuries.filter((i) => regions.includes(i.region)).map((i) => i.pain ?? 0))
  const order = <K extends string>(keys: K[], regionsOf: (k: K) => string[]) => keys
    .map((k, i) => ({ k, i, hist: regionsOf(k).some((r) => historyRegions.has(r as PainRegion)) ? 1 : 0, pain: painOf(regionsOf(k)) }))
    .sort((a, b) => b.hist - a.hist || b.pain - a.pain || a.i - b.i)
    .map((x) => x.k)
  const prehabKeys = order(uniq(moduleOrder.flatMap((m) => MODULES[m].prehab)), (k) => PREHAB[k].regions)
  const prehabItems: ComposedBlock['prehab']['items'] = []
  const deferred: PrehabKey[] = []
  let prehabMinutes = 0
  for (const k of prehabKeys) {
    const item = PREHAB[k]
    if (intersects(item.regions, blocked)) {
      held.push({ what: item.name, regions: item.regions.filter((r) => blocked.includes(r)), note: REFER_OUT_SHORT })
      continue
    }
    if (prehabMinutes + item.minutes > cfg.prehab_minutes[1]) {
      deferred.push(k)
      continue
    }
    prehabMinutes += item.minutes
    const hist = item.regions.filter((r) => historyRegions.has(r as PainRegion))
    prehabItems.push({
      key: k, name: item.name, dose: item.dose, minutes: item.minutes,
      why: hist.length ? `First: injury history (${hist.join(', ')}).` : painOf(item.regions) > 0 ? 'Early: current pain nearby.' : null,
    })
  }
  if (deferred.length) warnings.push(`Prehab capped at ${cfg.prehab_minutes[1]} min a session; ${deferred.map((k) => PREHAB[k].name).join(', ')} rotate${deferred.length === 1 ? 's' : ''} in next block.`)
  const screenKeys = order(uniq(moduleOrder.flatMap((m) => MODULES[m].screens)), (k) => SCREENS[k].regions)
  const screens = screenKeys.map((k) => ({ key: k, name: SCREENS[k].name, unit: SCREENS[k].unit, sided: SCREENS[k].sided }))

  // ---- 5. week layout (U8 order, U9 day-before rule) -----------------------------------------
  const resolveLayout = (daysPerWeek: number, minutes: number, dropMaintenance: boolean) =>
    layout(units.filter((u) => !(dropMaintenance && u.role === 'maintenance' && u.kind !== 'lift')), {
      daysPerWeek, minutes, rest: input.schedule.rest_days, activityDays, hardLegDays, prehabMinutes,
    })
  const days = Math.max(1, Math.min(7, Math.round(input.schedule.days_per_week)))
  const mins = Math.max(20, Math.round(input.schedule.minutes_per_session))
  let laid = resolveLayout(days, mins, false)
  if (laid.unplaced.length) {
    const free = 7 - input.schedule.rest_days.length - activityDays.size
    const options: TradeOffOption[] = []
    if (days < free) options.push({ id: 'add_day', label: `Train ${days + 1} days`, effect: `One more training day (${days + 1} a week).` })
    options.push({ id: 'longer_sessions', label: `${mins + 15}-minute sessions`, effect: `Sessions run to ${mins + 15} min.` })
    if (days < free) options.push({ id: 'add_day_and_longer', label: `${days + 1} days of ${mins + 15} min`, effect: `One more day and ${mins + 15}-minute sessions.` })
    if (laid.unplaced.some((u) => u.role === 'maintenance' && u.kind !== 'lift')) {
      options.push({ id: 'minimum_dose', label: 'Keep the week as is', effect: 'Maintenance conditioning that does not fit drops to the minimum dose your activities already give. Your goals stay; only that extra work goes.' })
    }
    const t: TradeOff = {
      id: 'time_budget',
      rule_refs: ['U8', 'U9'],
      message: `${uniq(laid.unplaced.map((u) => u.name)).join(', ')} ${laid.unplaced.length === 1 ? 'does' : 'do'} not fit ${days} days of ${mins} min without breaking session order or the day-before rule (U8, U9). Pick how to make room.`,
      options,
      default: options[0].id,
      chosen: null,
    }
    const pick = resolutions[t.id]
    t.chosen = options.some((o) => o.id === pick) ? pick : null
    tradeOffs.push(t)
    const eff = t.chosen ?? t.default
    const next = eff === 'add_day' ? resolveLayout(days + 1, mins, false)
      : eff === 'longer_sessions' ? resolveLayout(days, mins + 15, false)
        : eff === 'add_day_and_longer' ? resolveLayout(days + 1, mins + 15, false)
          : resolveLayout(days, mins, true)
    laid = next
    if (next.unplaced.length) {
      warnings.push(`Still not placed: ${uniq(next.unplaced.map((u) => u.name)).join(', ')}. Pick another option or change the schedule.`)
      if (t.chosen) t.chosen = null
    }
  }
  refs.push('U8')

  // ---- goals out: every goal in, with its role ------------------------------------------------
  const trackFor = (q: Quality | null) => (q ? tracks.find((t) => t.quality === q)?.name ?? null : null)
  const goalsOut: ComposedGoal[] = goals.map((x) => {
    const q = x.quality
    if (!q) return { id: x.g.id ?? null, name: x.g.name, quality: null, requested: x.g.weight, role: 'unassigned', track: null, note: 'Set this goal\'s quality so a track can train it.' }
    const heldBy = held.find((h) => (q === 'power' && h.what.startsWith('Jumps')) || (q === 'change_of_direction' && h.what === cfg.dose.change_of_direction.session))
    const role = roleOf.get(q) ?? 'maintenance'
    const why = x.g.weight === 'priority' && role !== 'priority'
      ? `Asked for priority; held at maintenance this block by the ${downgradedBy.get(q) === 'interference' ? 'interference' : 'priority-cap'} trade-off (U2). Not dropped: it keeps its track and its test.`
      : null
    return {
      id: x.g.id ?? null,
      name: x.g.name,
      quality: q,
      requested: x.g.weight,
      role: heldBy ? 'held' : role,
      track: trackFor(q),
      note: heldBy ? `${heldBy.note} Refer out before loading ${heldBy.regions.join(', ')}.` : why,
    }
  })

  // ---- deload, retest ---------------------------------------------------------------------------
  const deloadStart = addDaysIso(input.start, cfg.build_weeks * 7)
  const retestStart = addDaysIso(deloadStart, 7)
  const retestEnd = addDaysIso(retestStart, 6)
  const priorityTests = goalsOut.filter((g) => g.role === 'priority').map((g) => {
    if (g.quality === 'max_strength') {
      return minor
        ? `${g.name}: rep PR at RPE ≤${input.minors.max_rpe} (no max test under 18)`
        : `${g.name}: test day (RPE 10 on test days only, U5)`
    }
    return `${g.name}: test`
  })
  const maintenanceTests = goalsOut.filter((g) => g.role === 'maintenance' && g.quality === 'max_strength')
    .map((g) => `${g.name}: held if a rep PR or the planned load moves at RPE ≤${Math.min(rpeCap, p.U12.maintenance_held_at_rpe)}; no maxing (U12)`)
  const retestOrder = [
    ...(screens.length ? ['Screens and jumps first'] : []),
    ...priorityTests,
    ...(priorityTests.length > 1 ? ['Secondary priority on another day'] : []),
    ...maintenanceTests,
  ]
  refs.push('U11', 'U12')
  if (minor) refs.push('U5', 'U14')

  // ---- final checks ---------------------------------------------------------------------------
  if (!priorities.length) warnings.push('No priority goal: every quality runs at maintenance. Mark a goal priority to build it (U2).')
  if (minor) warnings.push(`Under 18: no RPE above ${input.minors.max_rpe}, contacts ≤${input.minors.contacts_per_session_max} a session, no max tests.`)
  for (const r of blocked) {
    if (liftRegionsLower.includes(r)) warnings.push(`${r.replace(/_/g, ' ')} is red-flagged: lower-body lifts for it are not loaded until a clinician clears it (U7).`)
  }

  return {
    modules_version: MODULES_V1_VERSION,
    start: input.start,
    weeks: cfg.build_weeks + 2,
    build_weeks: cfg.build_weeks,
    deload_week: {
      start: deloadStart,
      end: addDaysIso(deloadStart, 6),
      rule_refs: ['U11'],
      note: `Volume −${p.U11.volume_cut_pct[0]}–${p.U11.volume_cut_pct[1]}%, intensity ~${p.U11.intensity_pct[0]}–${p.U11.intensity_pct[1]}%, one easy conditioning session.`,
    },
    retest_week: { start: retestStart, end: retestEnd, order: retestOrder, rule_refs: ['U12'] },
    end: retestEnd,
    minor,
    demands: Object.fromEntries(QUALITIES.filter((q) => demand[q] > 0).map((q) => [q, demand[q]])),
    priorities,
    tracks,
    goals: goalsOut,
    activity_load: {
      sessions_per_week: activitySessions,
      supplies: supplied,
      contacts_per_week: activityContacts,
      hard_leg_days: [...hardLegDays].sort(),
    },
    contacts: { per_session: perSession, level, progression: ['broad', 'box', 'bounds', 'hops', 'reactive'] },
    week: laid.week,
    prehab: { items: prehabItems, minutes: prehabMinutes, deferred },
    screens,
    held,
    trade_offs: tradeOffs,
    needs_decision: tradeOffs.some((t) => t.chosen == null),
    warnings: uniq(warnings),
    rule_refs: sortRefs(refs),
  }
}

// ---- layout ------------------------------------------------------------------------------------

interface LayoutOpts {
  daysPerWeek: number
  minutes: number
  rest: number[]
  activityDays: Map<number, string[]>
  hardLegDays: Set<number>
  prehabMinutes: number
}

function combos(xs: number[], k: number): number[][] {
  if (k === 0) return [[]]
  if (xs.length < k) return []
  const out: number[][] = []
  const walk = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push(acc); return }
    for (let i = start; i < xs.length; i++) walk(i + 1, [...acc, xs[i]])
  }
  walk(0, [])
  return out
}

const prev = (d: number) => (d + 6) % 7
const next = (d: number) => (d + 1) % 7

/**
 * Units onto days. Lifts first, spread out and never the day after hard legs
 * (a game) when heavy or priority (U9); power before the lift (U8);
 * conditioning after the lift if it fits, else its own day, and HIIT never
 * the day before a heavy or priority lift (U9). What doesn't fit is returned,
 * never silently left out.
 */
function layout(units: SessionUnit[], o: LayoutOpts): { week: WeekDay[]; unplaced: SessionUnit[] } {
  const week: WeekDay[] = DAY.map((_, dow) => ({
    dow,
    kind: o.rest.includes(dow) ? 'rest' : o.activityDays.has(dow) ? 'activity' : 'off',
    activities: o.activityDays.get(dow) ?? [],
    units: [],
    minutes: 0,
  }))
  const free = week.filter((d) => d.kind === 'off').map((d) => d.dow)
  const unplaced: SessionUnit[] = []
  const lifts = units.filter((u) => u.kind === 'lift')
  const nLift = Math.min(lifts.length, o.daysPerWeek, free.length)
  const heavyWant = lifts.slice(0, nLift).map((u) => u.heavy)

  // Best set of lift days: no heavy lift the day after hard legs, then no back-to-back.
  let liftDays: number[] = []
  let best = Infinity
  for (const c of combos(free, nLift)) {
    let pen = 0
    c.forEach((d, i) => {
      if (heavyWant[i] && o.hardLegDays.has(prev(d))) pen += 100
      if (c.includes(next(d))) pen += 10
    })
    if (pen < best) { best = pen; liftDays = c }
  }
  lifts.slice(0, nLift).forEach((u, i) => {
    const d = week[liftDays[i]]
    d.kind = 'session'
    d.units.push(u)
  })
  unplaced.push(...lifts.slice(nLift))
  const sessionDays = () => week.filter((d) => d.kind === 'session')
  const heavyOn = (dow: number) => week[dow].units.some((u) => u.kind === 'lift' && u.heavy)
  const total = (d: WeekDay) => d.units.reduce((n, u) => n + u.minutes, 0) + (d.units.some((u) => u.kind === 'lift') ? o.prehabMinutes : 0)

  const placeOwnDay = (u: SessionUnit, ok: (dow: number) => boolean): boolean => {
    if (sessionDays().length >= o.daysPerWeek) return false
    const d = week.find((x) => x.kind === 'off' && ok(x.dow) && u.minutes <= o.minutes)
    if (!d) return false
    d.kind = 'session'
    d.units.push(u)
    return true
  }

  // Power and change of direction: first in a lift session (U8), fresh legs.
  for (const u of units.filter((x) => x.kind === 'power' || x.kind === 'change_of_direction')) {
    const host = sessionDays().find((d) =>
      d.units.some((x) => x.kind === 'lift') && !d.units.some((x) => x.kind === 'power' || x.kind === 'change_of_direction')
      && !o.hardLegDays.has(prev(d.dow)) && total(d) + u.minutes <= o.minutes)
    if (host) { host.units.unshift(u); continue }
    if (!placeOwnDay(u, (dow) => !o.hardLegDays.has(prev(dow)))) unplaced.push(u)
  }

  // Conditioning: HIIT first (it has the most rules), then easy aerobic.
  const conditioning = units.filter((x) => x.kind === 'aerobic' || x.kind === 'alactic').sort((a, b) => Number(b.hiit) - Number(a.hiit))
  for (const u of conditioning) {
    const hiitOk = (dow: number) => !u.hiit || (!heavyOn(next(dow)) && !week[dow].units.some((x) => x.hiit))
    const host = sessionDays()
      .filter((d) => d.units.some((x) => x.kind === 'lift'))
      .sort((a, b) => Number(a.units.some((x) => x.heavy)) - Number(b.units.some((x) => x.heavy)) || a.dow - b.dow)
      .find((d) => hiitOk(d.dow) && total(d) + u.minutes <= o.minutes && !d.units.some((x) => x.kind === u.kind))
    if (host) { host.units.push(u); continue }
    if (placeOwnDay(u, hiitOk)) continue
    // A conditioning-only day already in the week, if it has room.
    const shared = sessionDays().find((d) => !d.units.some((x) => x.kind === 'lift') && hiitOk(d.dow) && total(d) + u.minutes <= o.minutes && !d.units.some((x) => x.kind === u.kind))
    if (shared) { shared.units.push(u); continue }
    unplaced.push(u)
  }

  for (const d of week) {
    if (d.units.some((u) => u.kind === 'lift') && o.prehabMinutes > 0) {
      // U8: warm-up/speed → heavy lift → accessories (prehab) → conditioning.
      const idx = d.units.findIndex((u) => u.kind === 'aerobic' || u.kind === 'alactic')
      const pre: SessionUnit = { kind: 'prehab', name: 'Prehab', quality: null, role: 'maintenance', label: 'Prehab block', minutes: o.prehabMinutes, hiit: false, heavy: false, regions: [] }
      if (idx < 0) d.units.push(pre)
      else d.units.splice(idx, 0, pre)
    }
    d.minutes = d.units.reduce((n, u) => n + u.minutes, 0)
  }
  return { week, unplaced }
}

// ---- re-compose ----------------------------------------------------------------------------------

/** What a block was composed from, for "did anything change since". Order-free. */
export function composeKey(input: Pick<ComposeInput, 'activities' | 'goals'>): string {
  const acts = input.activities.filter((a) => a.active !== false)
    .map((a) => `${a.id ?? a.name}:${a.module}:${a.sessions_per_week}:${a.season}`).sort()
  const goals = input.goals.map((g) => `${g.id ?? g.name}:${g.weight}:${g.quality ?? ''}`).sort()
  return JSON.stringify({ acts, goals })
}

/**
 * Section 4 rule 6: re-compose at every block boundary, or when an activity
 * or goal is added or removed. Null when the current block still stands.
 */
export function recomposeReason(
  last: { key: string; end: string } | null,
  now: { key: string; today: string },
): 'no_block' | 'block_boundary' | 'inputs_changed' | null {
  if (!last) return 'no_block'
  if (now.today > last.end) return 'block_boundary'
  if (now.key !== last.key) return 'inputs_changed'
  return null
}

/** The block as one line per day, for previews and the chat. */
export function weekLines(block: Pick<ComposedBlock, 'week'>): string[] {
  return block.week.map((d) => {
    const parts = [
      ...d.activities.map((a) => `${a} (counts as load)`),
      ...d.units.map((u) => (u.kind === 'prehab' ? `${u.label} ${u.minutes} min` : u.label)),
    ]
    return `${DAY[d.dow]}: ${parts.length ? parts.join(' → ') : d.kind === 'rest' ? 'rest' : 'off'}${d.minutes ? ` (${d.minutes} min)` : ''}`
  })
}
