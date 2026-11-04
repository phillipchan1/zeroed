/**
 * Intake (G7, coach_v1; spec section 5), the pure half: the athlete's answers
 * in, either a refusal (what to fix), a stop (a red flag: section 8 refer-out,
 * nothing composed), or a parsed intake the I/O half turns into one composed
 * block preview.
 *
 *   1 goals 1–3        test, current, target, date, priority | maintenance
 *   2 activities       module, sessions/week, in- or off-season, days
 *   3 schedule         days/week (hard max), minutes, rest days, equipment
 *   4 training age     <1 / 1–3 / 3–10 / 10+
 *   5 injuries, pain   region, 0–10, aggravators, red flags → a red flag (or
 *                      pain above the U7 stop line) stops intake
 *   6 screens          baselines, logged with log_goal_measurement
 *   7 recovery         sleep, stress, soreness (manual)
 *
 * Under 18 (section 8, D6): a parental-consent step, and the composer runs
 * with the tightened caps (no RPE above 8, lower contacts, no max tests).
 */
import type { MethodologyParams, MinorsRules, PainRegion } from '../methodology/v1.ts'
import { PAIN_REGIONS } from '../methodology/v1.ts'
import { isRedFlag, RED_FLAG_LABEL, RED_FLAGS, type RedFlag } from '../readiness/rules.ts'
import { isModuleKey, isQuality, MODULES, SCREENS, type ModuleKey, type Quality, type ScreenKey } from './modules.ts'
import { TRAINING_AGES, type GoalWeight, type Season, type TrainingAge } from './composer.ts'

export interface IntakeGoal {
  name: string
  test: string | null
  current: number | null
  target: number | null
  unit: string | null
  direction: 'higher' | 'lower'
  due_date: string | null
  weight: GoalWeight
  quality: Quality | null
}

export interface IntakeActivity {
  module: ModuleKey
  name: string
  sessions_per_week: number
  season: Season
  days: number[]
}

export interface IntakePain {
  region: PainRegion
  score: number
  aggravators: string | null
  red_flags: RedFlag[]
}

export interface IntakeScreen {
  key: ScreenKey
  value: number
  side: 'L' | 'R' | null
}

export interface ParsedIntake {
  birth_date: string | null
  age: number | null
  minor: boolean
  parental_consent: { guardian_name: string } | null
  goals: IntakeGoal[]
  activities: IntakeActivity[]
  schedule: { days_per_week: number; minutes_per_session: number; rest_days: number[]; equipment: string[] }
  training_age: TrainingAge
  injury_history: Array<{ region: PainRegion; note: string | null }>
  pain: IntakePain[]
  screens: IntakeScreen[]
  recovery: { sleep_hours: number | null; stress: number | null; soreness: number | null }
}

export type IntakeOutcome =
  | { ok: false; errors: string[]; needs_consent?: true }
  | { ok: true; stop: { regions: Array<{ region: PainRegion; why: string }> }; intake: ParsedIntake }
  | { ok: true; stop: null; intake: ParsedIntake }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const text = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function validDate(v: string): boolean {
  return DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
}

/** Whole years from YYYY-MM-DD to `today`. */
export function ageOn(birthDate: string, today: string): number {
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0)
}

function days(v: unknown): number[] | null {
  const out: number[] = []
  for (const d of arr(v)) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null
    if (!out.includes(d)) out.push(d)
  }
  return out.sort((a, b) => a - b)
}

/**
 * The answers, checked. `birthDateOnFile` wins over an answered birth date:
 * intake records it once and never changes it, so an under-18 athlete can't
 * loosen their own rules by re-entering it.
 */
export function parseIntake(
  raw: unknown,
  ctx: { today: string; birthDateOnFile: string | null; params: MethodologyParams; minors: MinorsRules },
): IntakeOutcome {
  const a = obj(raw)
  const errors: string[] = []

  // Age and consent first: they change what the rest may contain.
  let birth: string | null = ctx.birthDateOnFile
  if (!birth) {
    const answered = text(a.birth_date, 10)
    if (answered) {
      if (!validDate(answered) || answered > ctx.today) errors.push('birth_date must be a past date, YYYY-MM-DD.')
      else birth = answered
    }
  }
  const age = birth ? ageOn(birth, ctx.today) : null
  if (age != null && (age < 5 || age > 110)) errors.push('birth_date looks wrong.')
  const minor = age != null && age < ctx.minors.age_under
  let consent: ParsedIntake['parental_consent'] = null
  if (minor) {
    const c = obj(a.parental_consent)
    const guardian = text(c.guardian_name, 80)
    if (c.confirmed !== true || !guardian) {
      return { ok: false, needs_consent: true, errors: [`Under ${ctx.minors.age_under}: a parent or guardian has to agree before we build a plan. Add their name and confirm.`] }
    }
    consent = { guardian_name: guardian }
  }

  // 1. Goals.
  const goals: IntakeGoal[] = []
  for (const g of arr(a.goals)) {
    const x = obj(g)
    const name = text(x.name, 80)
    if (!name) { errors.push('Every goal needs a name.'); continue }
    if (goals.some((y) => y.name.toLowerCase() === name.toLowerCase())) { errors.push(`"${name}" is listed twice.`); continue }
    const weight = x.weight === 'priority' ? 'priority' : x.weight === 'maintenance' || x.weight == null ? 'maintenance' : null
    if (!weight) { errors.push(`"${name}": weight is priority or maintenance.`); continue }
    const due = text(x.due_date, 10)
    if (due && (!validDate(due) || due < ctx.today)) { errors.push(`"${name}": the date must be today or later, YYYY-MM-DD.`); continue }
    if (x.quality != null && !isQuality(x.quality)) { errors.push(`"${name}": unknown quality.`); continue }
    let test = text(x.test, 80)
    // Section 8: no max testing under 18. The goal stays; its test becomes submax.
    if (minor && test && /\b(1 ?rm|max|maximal|true max)\b/i.test(test)) {
      test = `${test.replace(/\b(1 ?rm|max|maximal|true max)\b/gi, '').trim() || name}: rep PR at RPE ≤${ctx.minors.max_rpe} (no max test under ${ctx.minors.age_under})`
    }
    goals.push({
      name,
      test,
      current: num(x.current),
      target: num(x.target),
      unit: text(x.unit, 16),
      direction: x.direction === 'lower' ? 'lower' : 'higher',
      due_date: due,
      weight,
      quality: isQuality(x.quality) ? x.quality : null,
    })
  }
  if (goals.length < 1 || goals.length > 3) errors.push('Give 1–3 goals.')

  // 2. Activities (any number).
  const activities: IntakeActivity[] = []
  for (const v of arr(a.activities)) {
    const x = obj(v)
    const name = text(x.name, 60)
    if (!isModuleKey(x.module)) { errors.push(`${name ?? 'An activity'}: pick a type (${Object.keys(MODULES).join(', ')}).`); continue }
    const spw = num(x.sessions_per_week)
    if (spw == null || !Number.isInteger(spw) || spw < 0 || spw > 14) { errors.push(`${name ?? x.module}: sessions a week is a whole number 0–14.`); continue }
    const d = days(x.days)
    if (!d) { errors.push(`${name ?? x.module}: days are 0 (Mon) to 6 (Sun).`); continue }
    activities.push({ module: x.module, name: name ?? MODULES[x.module].label, sessions_per_week: spw, season: x.season === 'off' ? 'off' : 'in', days: d })
  }

  // 3. Schedule.
  const s = obj(a.schedule)
  const dpw = num(s.days_per_week)
  const mins = num(s.minutes_per_session)
  const rest = days(s.rest_days)
  if (dpw == null || !Number.isInteger(dpw) || dpw < 1 || dpw > 7) errors.push('Training days a week is 1–7.')
  if (mins == null || mins < 20 || mins > 180) errors.push('Minutes a session is 20–180.')
  if (!rest) errors.push('Rest days are 0 (Mon) to 6 (Sun).')
  const equipment = arr(s.equipment).map((e) => text(e, 40)).filter((e): e is string => !!e).slice(0, 20)

  // 4. Training age.
  const trainingAge = TRAINING_AGES.includes(a.training_age as TrainingAge) ? a.training_age as TrainingAge : null
  if (!trainingAge) errors.push('Training age is one of <1 yr, 1–3, 3–10, 10+.')

  // 5. Injury history and current pain.
  const inj = obj(a.injuries)
  const history: ParsedIntake['injury_history'] = []
  for (const v of arr(inj.history)) {
    const x = obj(v)
    if (!(PAIN_REGIONS as readonly string[]).includes(String(x.region))) { errors.push(`Unknown region. Regions: ${PAIN_REGIONS.join(', ')}.`); continue }
    if (!history.some((h) => h.region === x.region)) history.push({ region: x.region as PainRegion, note: text(x.note, 200) })
  }
  const pain: IntakePain[] = []
  for (const v of arr(inj.pain)) {
    const x = obj(v)
    if (!(PAIN_REGIONS as readonly string[]).includes(String(x.region))) { errors.push(`Unknown region. Regions: ${PAIN_REGIONS.join(', ')}.`); continue }
    const score = num(x.score)
    if (score == null || !Number.isInteger(score) || score < 0 || score > 10) { errors.push('Pain scores are whole numbers 0–10.'); continue }
    const flags = arr(x.red_flags)
    if (!flags.every(isRedFlag)) { errors.push(`Unknown red flag. Red flags: ${RED_FLAGS.join(', ')}.`); continue }
    if (pain.some((p) => p.region === x.region)) { errors.push(`${String(x.region)} is listed twice.`); continue }
    pain.push({ region: x.region as PainRegion, score, aggravators: text(x.aggravators, 200), red_flags: [...new Set(flags as RedFlag[])] })
  }

  // 6. Screens (optional baselines).
  const screens: IntakeScreen[] = []
  for (const v of arr(a.screens)) {
    const x = obj(v)
    const key = String(x.key) as ScreenKey
    if (!SCREENS[key]) { errors.push('Unknown screen.'); continue }
    const value = num(x.value)
    if (value == null || value < 0 || value > 1000) { errors.push(`${SCREENS[key].name}: give a number.`); continue }
    const side = x.side === 'L' || x.side === 'R' ? x.side : null
    if (SCREENS[key].sided && !side) { errors.push(`${SCREENS[key].name}: say which side (L or R).`); continue }
    screens.push({ key, value, side })
  }

  // 7. Recovery baseline.
  const r = obj(a.recovery)
  const sleep = num(r.sleep_hours)
  const stress = num(r.stress)
  const soreness = num(r.soreness)
  if (sleep != null && (sleep < 0 || sleep > 24)) errors.push('Sleep is 0–24 hours.')
  if (stress != null && (!Number.isInteger(stress) || stress < 1 || stress > 5)) errors.push('Stress is a whole number 1–5.')
  if (soreness != null && (!Number.isInteger(soreness) || soreness < 1 || soreness > 5)) errors.push('Soreness is a whole number 1–5.')

  if (errors.length) return { ok: false, errors }

  const intake: ParsedIntake = {
    birth_date: birth,
    age,
    minor,
    parental_consent: consent,
    goals,
    activities,
    schedule: { days_per_week: dpw!, minutes_per_session: mins!, rest_days: rest!, equipment },
    training_age: trainingAge!,
    injury_history: history,
    pain,
    screens,
    recovery: { sleep_hours: sleep, stress, soreness },
  }

  // Section 8: any red flag, or pain above the U7 stop line, stops intake.
  const stop = pain
    .filter((p) => p.red_flags.length > 0 || p.score > ctx.params.U7.stop_above)
    .map((p) => ({
      region: p.region,
      why: p.red_flags.length
        ? `${p.region.replace(/_/g, ' ')}: ${p.red_flags.map((f) => RED_FLAG_LABEL[f]).join(', ')}`
        : `${p.region.replace(/_/g, ' ')}: pain ${p.score}/10 (above ${ctx.params.U7.stop_above})`,
    }))
  if (stop.length) return { ok: true, stop: { regions: stop }, intake }
  return { ok: true, stop: null, intake }
}
