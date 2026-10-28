/**
 * Coach intake — the flag-on onboarding questions, and the starter pack they
 * imply. The athlete says what they train and what matters; the pack is
 * inferred, never picked from a list (they can still change it on the plan).
 *
 * Deterministic on purpose: every tap answers instantly and offline, and the
 * AI spends its time where it pays — designing session one after sign-in.
 * Pure so `intake.check.ts` runs under node.
 */

import {
  STARTER_PACKS,
  resolveStarterPack,
  type PackSettings,
  type ResolvedPack,
  type Season,
  type StarterPackCard,
  type StarterPackId,
} from './starterPacks.ts'

export type Modality =
  | 'lifting'
  | 'running'
  | 'intervals'
  | 'sport'
  | 'hyrox'
  | 'cycling'
  | 'swimming'
  | 'classes'
  | 'mobility'

export const MODALITIES: ReadonlyArray<{ id: Modality; label: string }> = [
  { id: 'lifting', label: 'Lifting' },
  { id: 'running', label: 'Running' },
  { id: 'sport', label: 'A sport' },
  { id: 'intervals', label: 'HIIT / intervals' },
  { id: 'hyrox', label: 'Hyrox' },
  { id: 'cycling', label: 'Cycling' },
  { id: 'swimming', label: 'Swimming' },
  { id: 'classes', label: 'Classes' },
  { id: 'mobility', label: 'Mobility / yoga' },
]

const ENDURANCE: readonly Modality[] = ['running', 'hyrox', 'cycling', 'swimming']

export type Focus = 'sport' | 'endurance' | 'strength' | 'total' | 'time' | 'comeback'

export type Experience = 'under1' | '1to3' | '3plus'

export const EXPERIENCE: ReadonlyArray<{ id: Experience; label: string; years: number }> = [
  { id: 'under1', label: 'Not yet, or under a year', years: 0 },
  { id: '1to3', label: '1–3 years', years: 2 },
  { id: '3plus', label: '3+ years', years: 4 },
]

export const SPORTS = ['Basketball', 'Soccer', 'Tennis', 'Combat', 'Golf', 'Climbing'] as const

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export interface IntakeAnswers {
  /** Empty with `nothingYet` = a deliberate "nothing yet", not unanswered. */
  modalities: Modality[]
  nothingYet: boolean
  focus: Focus | null
  experience: Experience | null
  sport: string
  season: Season
  gameDays: string[]
  liftDays: 2 | 3 | 4
  enduranceDays: number
  squat: string
  bench: string
  deadlift: string
  /** Set from the plan's "Change" list; wins over the inferred pack. */
  packOverride: StarterPackId | null
  name: string
}

export const EMPTY_ANSWERS: IntakeAnswers = {
  modalities: [],
  nothingYet: false,
  focus: null,
  experience: null,
  sport: '',
  season: 'off',
  gameDays: [],
  liftDays: 3,
  enduranceDays: 2,
  squat: '',
  bench: '',
  deadlift: '',
  packOverride: null,
  name: '',
}

// ---- Own words → modalities --------------------------------------------------

const WORDS: ReadonlyArray<{ re: RegExp; modality: Modality; sport?: string }> = [
  { re: /\b(lift|lifting|weights?|gym|strength|powerlift\w*|squat|bench|deadlift|bodybuild\w*)\b/i, modality: 'lifting' },
  { re: /\b(crossfit|wod)\b/i, modality: 'intervals' },
  { re: /\b(run|running|jog\w*|marathon|5k|10k)\b/i, modality: 'running' },
  { re: /\b(hiit|intervals?|tabata|emom|amrap|circuits?|f45|orangetheory)\b/i, modality: 'intervals' },
  { re: /\bhyrox\b/i, modality: 'hyrox' },
  { re: /\b(cycl\w*|bike|biking|riding|peloton|spin)\b/i, modality: 'cycling' },
  { re: /\b(swim\w*|triathlon)\b/i, modality: 'swimming' },
  { re: /\b(yoga|pilates|mobility|stretch\w*)\b/i, modality: 'mobility' },
  { re: /\b(class|classes|bootcamp|barre)\b/i, modality: 'classes' },
  { re: /\b(basketball|hoops|bball)\b/i, modality: 'sport', sport: 'Basketball' },
  { re: /\b(soccer|five-a-side|futsal)\b/i, modality: 'sport', sport: 'Soccer' },
  { re: /\b(tennis|padel|pickleball|squash|badminton)\b/i, modality: 'sport', sport: 'Tennis' },
  { re: /\b(bjj|jiu.?jitsu|judo|wrestl\w*|boxing|mma|muay thai|kickbox\w*|karate)\b/i, modality: 'sport', sport: 'Combat' },
  { re: /\b(golf)\b/i, modality: 'sport', sport: 'Golf' },
  { re: /\b(climb\w*|boulder\w*)\b/i, modality: 'sport', sport: 'Climbing' },
  { re: /\b(football|rugby|volleyball|hockey|baseball|softball|lacrosse|cricket|ski\w*|snowboard\w*|surf\w*)\b/i, modality: 'sport' },
]

/**
 * Keyword read of "or tell me in your own words". Returns the modalities it
 * found and the first named sport (the matched word itself when it isn't one of
 * the chips, so "rugby" stays "Rugby").
 */
export function readOwnWords(text: string): { modalities: Modality[]; sport: string | null } {
  const found = new Set<Modality>()
  let sport: string | null = null
  for (const w of WORDS) {
    const m = text.match(w.re)
    if (!m) continue
    found.add(w.modality)
    if (w.modality === 'sport' && !sport) {
      sport = w.sport ?? m[0].charAt(0).toUpperCase() + m[0].slice(1).toLowerCase()
    }
  }
  return { modalities: MODALITIES.map((m) => m.id).filter((id) => found.has(id)), sport }
}

// ---- Questions that depend on earlier answers ---------------------------------

export function endurancePicked(modalities: readonly Modality[]): Modality[] {
  return modalities.filter((m) => ENDURANCE.includes(m))
}

function enduranceNoun(modalities: readonly Modality[]): string {
  const first = endurancePicked(modalities)[0]
  if (first === 'hyrox') return 'Hyrox'
  if (first === 'cycling') return 'my riding'
  if (first === 'swimming') return 'my swimming'
  return 'my running'
}

/** The "what matters most" options, led by what they said they train. */
export function focusOptions(a: Pick<IntakeAnswers, 'modalities' | 'sport'>): Array<{ id: Focus; label: string; sub: string }> {
  const out: Array<{ id: Focus; label: string; sub: string }> = []
  if (a.modalities.includes('sport')) {
    out.push({ id: 'sport', label: `Play ${a.sport.trim() ? a.sport.trim().toLowerCase() : 'my sport'} better`, sub: 'Faster, stronger, harder to break' })
  }
  if (endurancePicked(a.modalities).length) {
    out.push({ id: 'endurance', label: `Train for ${enduranceNoun(a.modalities)}`, sub: 'Strength that carries over, not against it' })
  }
  out.push({ id: 'strength', label: 'Get stronger', sub: 'Build a base that lasts' })
  if (a.modalities.includes('lifting')) {
    out.push({ id: 'total', label: 'Hit a number', sub: 'A meet, a total, a PR' })
  }
  out.push({ id: 'time', label: 'Stay fit on little time', sub: 'Thirty minutes, three days' })
  out.push({ id: 'comeback', label: 'Come back from a break', sub: 'Injury, illness, or 6+ weeks off' })
  return out
}

const PACK_BY_FOCUS: Record<Focus, StarterPackId> = {
  sport: 'sport_sc',
  endurance: 'hybrid',
  strength: 'get_strong',
  total: 'chase_total',
  time: 'thirty_three',
  comeback: 'layoff',
}

/** The pack the answers imply. An explicit pick from the plan wins. */
export function inferPack(a: Pick<IntakeAnswers, 'focus' | 'modalities' | 'packOverride'>): StarterPackId {
  if (a.packOverride) return a.packOverride
  if (a.focus) return PACK_BY_FOCUS[a.focus]
  if (a.modalities.includes('sport')) return 'sport_sc'
  if (endurancePicked(a.modalities).length) return 'hybrid'
  return 'get_strong'
}

export function trainingYears(a: Pick<IntakeAnswers, 'experience' | 'nothingYet'>): number {
  if (a.nothingYet) return 0
  return EXPERIENCE.find((e) => e.id === a.experience)?.years ?? 0
}

export type IntakeStep = 'train' | 'focus' | 'experience' | 'sport' | 'endurance' | 'lifts' | 'plan'

/**
 * The questions this athlete gets, in order. Nothing is asked whose answer the
 * pack would ignore: days are only asked where the pack takes them, experience
 * is skipped for "nothing yet", and the plan is always last.
 */
export function intakeSteps(a: IntakeAnswers): IntakeStep[] {
  const steps: IntakeStep[] = ['train', 'focus']
  if (!a.nothingYet) steps.push('experience')
  const pack = inferPack(a)
  if (pack === 'sport_sc') steps.push('sport')
  if (pack === 'hybrid') steps.push('endurance')
  if (pack === 'chase_total') steps.push('lifts')
  steps.push('plan')
  return steps
}

// ---- Answers → the existing pack resolver ---------------------------------------

function lowerList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

function modalityLabel(m: Modality, sport: string): string {
  if (m === 'sport') return sport.trim() || 'a sport'
  return (MODALITIES.find((x) => x.id === m)?.label ?? m).toLowerCase()
}

export function resolveIntake(a: IntakeAnswers): ResolvedPack {
  const id = inferPack(a)
  const settings: PackSettings = {
    sport: a.sport.trim(),
    season: a.season,
    game_days: a.gameDays,
    squat: a.squat.trim(),
    bench: a.bench.trim(),
    deadlift: a.deadlift.trim(),
    run_days: a.enduranceDays,
  }
  const resolved = resolveStarterPack({
    id,
    trainingAge: trainingYears(a),
    sessionsPick: id === 'sport_sc' ? a.liftDays : undefined,
    settings,
  })
  // Everything else they train rides into the coach's brief, so session one is
  // designed around it rather than in a vacuum.
  const also = a.modalities.filter((m) => m !== 'lifting' && !(m === 'sport' && id === 'sport_sc'))
  const alsoBit = also.length ? ` Also trains: ${lowerList(also.map((m) => modalityLabel(m, a.sport)))}.` : ''
  return { ...resolved, obstacle: `${resolved.obstacle}${alsoBit}` }
}

export function packCard(id: StarterPackId): StarterPackCard {
  return STARTER_PACKS.find((p) => p.id === id)!
}

// ---- The plan, as the athlete sees it ---------------------------------------------

export interface PlanLane {
  key: string
  label: string
  detail: string
  /** True: Zeroed programs it. False: the coach knows about it. */
  planned: boolean
  /** Filled dots for planned lanes, hollow for the rest. */
  dots: number
}

export function planLanes(a: IntakeAnswers, resolved: ResolvedPack): PlanLane[] {
  const card = packCard(resolved.id)
  const lanes: PlanLane[] = [{
    key: 'strength',
    label: 'Strength',
    detail: `${resolved.sessions} days a week · ${card.length}`,
    planned: true,
    dots: resolved.sessions,
  }]

  if (a.modalities.includes('sport')) {
    const sport = a.sport.trim() || 'Your sport'
    const games = a.gameDays.length ? ` · games ${a.gameDays.join(', ')}` : ''
    lanes.push({
      key: 'sport',
      label: sport,
      detail: `${a.season === 'in' ? 'In-season' : 'Off-season'}${games}`,
      planned: false,
      dots: a.gameDays.length,
    })
  }

  const endurance = endurancePicked(a.modalities)
  if (endurance.length) {
    const days = resolved.id === 'hybrid' ? resolved.settings.run_days ?? 0 : 0
    lanes.push({
      key: 'endurance',
      label: endurance.map((m) => MODALITIES.find((x) => x.id === m)!.label).join(' · '),
      detail: days ? `${days} ${days === 1 ? 'day' : 'days'} a week` : 'Yours',
      planned: false,
      dots: days,
    })
  }

  for (const m of ['intervals', 'classes', 'mobility'] as const) {
    if (!a.modalities.includes(m)) continue
    lanes.push({ key: m, label: MODALITIES.find((x) => x.id === m)!.label, detail: 'Yours', planned: false, dots: 0 })
  }
  return lanes
}

/** One line in the coach's voice. Every number in it comes from the resolver. */
export function coachRead(a: IntakeAnswers, resolved: ResolvedPack): string {
  const n = resolved.sessions
  const days = `${n} strength ${n === 1 ? 'day' : 'days'}`
  const others = a.modalities.filter((m) => m !== 'lifting')
  switch (resolved.id) {
    case 'sport_sc': {
      const sport = a.sport.trim() || 'Your sport'
      return `${sport} leads. ${days} make you faster and harder to break, built around your ${a.season === 'in' ? 'season' : 'off-season'}.`
    }
    case 'hybrid':
      return `${endurancePicked(a.modalities).length ? cap(enduranceNoun(a.modalities).replace(/^my /, '')) : 'Your engine'} leads, lifting supports it. ${cap(days)} keep you strong without stealing from it.`
    case 'chase_total':
      return `The total leads. ${cap(days)}: build the base for four weeks, then heavy squat, bench and deadlift.`
    case 'layoff':
      return `We start conservative and earn it back. ${cap(days)}, every load clamped while you find your feet.`
    case 'thirty_three':
      return 'Thirty minutes, three days. Every session fits the box.'
    default: {
      const tail = others.length ? ` Your ${lowerList(others.map((m) => modalityLabel(m, a.sport)))} stays in the picture.` : ''
      return `Strength leads. ${cap(days)} to build a base you can keep adding to.${tail}`
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
