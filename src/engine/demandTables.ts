// =============================================================================
// Demand decompression tables — the CODE-OWNED expert priors behind the Arena +
// adaptive Limiter questions. This is the `exerciseLibrary` of *intent*.
//
//   Doctrine: the agent NEVER invents `arena → demands`. It reads this table.
//   "Get these right and three taps read the whole athlete. Get them sloppy and
//    it's a horoscope. The product's credibility lives here." (Convergence §4)
//
// Pure data + typed lookups, fully deterministic, no I/O. Adding a sport / lift /
// arena is a single row. Every limiter resolves into the existing insight
// category vocabulary (CATEGORY_NAMES, mirrored from schemas.ts / agentClient)
// so the read synthesis can emit valid insights; the richer `axis` + `label`
// carry the nuance the 6-bucket vocab can't.
// =============================================================================

import type { InsightCategory } from './agentClient'
import type { ArenaType } from '../types/database'

// Re-export so screens/logic can import the persisted Arena enum from the same
// module as the demand tables it keys into.
export type { ArenaType }

// Insight-vocab buckets a limiter can map into. Kept identical to the agent's
// CATEGORIES (schemas.ts) and the client's InsightCategory; the guard below
// fails type-check if they ever drift.
export const CATEGORY_NAMES = [
  'Lower Chain',
  'Upper Chain',
  'Posterior Chain',
  'Core',
  'Recovery',
  'Strength',
] as const
export type CategoryName = (typeof CATEGORY_NAMES)[number]

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
// Compile-time tripwire: demand-table vocab MUST stay identical to the insight
// vocab. If schemas.ts/agentClient change, this stops being `true`.
const _vocabInSync: AssertEqual<CategoryName, InsightCategory> = true
void _vocabInSync

// ---- Arena (Move 1) --------------------------------------------------------
// ArenaType is defined in types/database.ts (the persisted column enum) and
// imported above; this module owns the priors keyed on it.

export const ARENA_TYPES: readonly ArenaType[] = [
  'sport', 'number', 'body', 'durability', 'event', 'all_around',
] as const

export interface ArenaMeta {
  type: ArenaType
  label: string          // tappable card title
  example: string        // ghost / placeholder example
  unpacks: string        // what one tap decompresses into (for the reveal copy)
}

// Single source for the Move-1 cards (consumed by the Arena screen, Phase B).
export const ARENA_META: Record<ArenaType, ArenaMeta> = {
  sport:      { type: 'sport',      label: 'A sport',        example: 'Excel at basketball',     unpacks: 'energy system, key qualities, injury priors' },
  number:     { type: 'number',     label: 'A number',       example: '285 bench · first pull-up', unpacks: 'max-strength bias, the lift’s limiters' },
  body:       { type: 'body',       label: 'My body',        example: 'Get jacked · lean down',  unpacks: 'hypertrophy / composition bias, volume tolerance' },
  durability: { type: 'durability', label: 'Durability',     example: 'Stop getting hurt',       unpacks: 'corrective bias, tissue capacity' },
  event:      { type: 'event',      label: 'An event',       example: 'Spartan in October',      unpacks: 'energy-system specificity + time-to-date' },
  all_around: { type: 'all_around', label: 'All-around',     example: 'Be a complete athlete',   unpacks: 'balanced GPP — the default wide cloud' },
}

// ---- The limiter a forced choice resolves to -------------------------------

export interface LimiterCandidate {
  axis: string             // rich axis id: 'durability' | 'power' | 'hypertrophy' | ...
  label: string            // human limiter, e.g. 'Eccentric / landing control'
  category: CategoryName   // best-fit insight-vocab bucket (for the insight row)
  tilt: string             // the program bias this read implies (read by program_design)
}

// ---- §4a  Arena (sport) → demand profile -----------------------------------

export type SportLimiterAxis = 'durability' | 'conditioning' | 'power'

export interface DemandProfile {
  discipline: string                 // canonical display name
  energySystem: string
  keyQualities: string[]
  injuryPriors: string[]
  // The Move-2 forced choice ("what gives first?") resolved FOR THIS discipline.
  limiters: Record<SportLimiterAxis, LimiterCandidate>
  // P1 candidate before Move 2 is answered (the spec's "P1 limiter candidates").
  defaultP1: SportLimiterAxis
}

export type SportKey =
  | 'basketball' | 'soccer' | 'powerlifting' | 'endurance_run'
  | 'crossfit' | 'combat' | 'racquet' | 'generic'

export const DEMAND_PROFILES: Record<SportKey, DemandProfile> = {
  basketball: {
    discipline: 'Basketball',
    energySystem: 'Alactic power + aerobic recovery',
    keyQualities: ['Reactive / landing mechanics', 'Single-leg strength', 'Deceleration', 'Vertical / elastic power'],
    injuryPriors: ['Patellar tendon', 'ACL', 'Ankle'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Eccentric / landing control',   category: 'Lower Chain', tilt: 'Eccentric & isometric single-leg loading; landing mechanics; tendon prep' },
      conditioning: { axis: 'conditioning', label: 'Repeat-effort capacity',         category: 'Recovery',    tilt: 'Alactic-aerobic repeat-effort conditioning' },
      power:        { axis: 'power',         label: 'Reactive / elastic power',       category: 'Lower Chain', tilt: 'Plyometric progression & rate of force (post-screen)' },
    },
    defaultP1: 'durability',
  },
  soccer: {
    discipline: 'Soccer',
    energySystem: 'Aerobic + repeat-sprint',
    keyQualities: ['Hamstring eccentric strength', 'Change of direction', 'Repeat sprint'],
    injuryPriors: ['Hamstring', 'Groin', 'Ankle'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Posterior-chain / hamstring eccentric', category: 'Posterior Chain', tilt: 'Eccentric hamstring (Nordic progression); adductor strength' },
      conditioning: { axis: 'conditioning', label: 'Repeat-sprint capacity',                category: 'Recovery',        tilt: 'Aerobic base + repeat-sprint intervals' },
      power:        { axis: 'power',         label: 'Hip-driven sprint power',               category: 'Posterior Chain', tilt: 'Hip-extension power; acceleration mechanics' },
    },
    defaultP1: 'durability',
  },
  powerlifting: {
    discipline: 'Powerlifting',
    energySystem: 'Max strength (alactic)',
    keyQualities: ['The 3 lifts’ leverages', 'Bracing', 'Joint integrity'],
    injuryPriors: ['Low back', 'Shoulder'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Bracing / low-back tolerance', category: 'Core',     tilt: 'Bracing, trunk stiffness, position tolerance' },
      conditioning: { axis: 'conditioning', label: 'Work capacity for volume',     category: 'Recovery', tilt: 'GPP / volume-tolerance accessory work' },
      power:        { axis: 'power',         label: 'Sticking-point strength',      category: 'Strength', tilt: 'Sticking-point work on the limiter lift' },
    },
    defaultP1: 'power',
  },
  endurance_run: {
    discipline: 'Endurance running',
    energySystem: 'Aerobic',
    keyQualities: ['Tissue capacity under volume', 'Hip / ankle stiffness', 'Running economy'],
    injuryPriors: ['Achilles', 'Patellofemoral', 'Shin'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Tendon / tissue capacity',  category: 'Lower Chain',     tilt: 'Isometric & heavy-slow calf/tendon loading; tissue capacity' },
      conditioning: { axis: 'conditioning', label: 'Aerobic capacity',          category: 'Recovery',        tilt: 'Aerobic volume / threshold structure' },
      power:        { axis: 'power',         label: 'Hip (glute med) stability', category: 'Posterior Chain', tilt: 'Hip stability; single-leg control; stiffness' },
    },
    defaultP1: 'durability',
  },
  crossfit: {
    discipline: 'CrossFit / hybrid',
    energySystem: 'Mixed',
    keyQualities: ['Overhead stability', 'Midline', 'Broad capacity'],
    injuryPriors: ['Shoulder', 'Low back'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Overhead / shoulder stability', category: 'Upper Chain', tilt: 'Cuff & scapular stability; overhead position' },
      conditioning: { axis: 'conditioning', label: 'Mixed-modal capacity',          category: 'Recovery',    tilt: 'Aerobic base under mixed-modal load' },
      power:        { axis: 'power',         label: 'Midline / trunk stability',     category: 'Core',        tilt: 'Anti-flexion / anti-extension trunk strength' },
    },
    defaultP1: 'durability',
  },
  combat: {
    discipline: 'Combat / MMA',
    energySystem: 'Alactic + aerobic',
    keyQualities: ['Rotational power', 'Grip', 'Neck', 'Conditioning'],
    injuryPriors: ['Hip', 'Neck', 'Shoulder'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Hip mobility / strength',  category: 'Lower Chain', tilt: 'Hip mobility + strength; neck resilience' },
      conditioning: { axis: 'conditioning', label: 'Alactic-aerobic capacity', category: 'Recovery',    tilt: 'Alactic power + aerobic recovery intervals' },
      power:        { axis: 'power',         label: 'Rotational core power',    category: 'Core',        tilt: 'Rotational power; anti-rotation base first' },
    },
    defaultP1: 'power',
  },
  racquet: {
    discipline: 'Racquet sport',
    energySystem: 'Repeat-power, rotational',
    keyQualities: ['Shoulder integrity', 'Single-leg', 'Rotation'],
    injuryPriors: ['Shoulder', 'Elbow', 'Hip'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Shoulder stability',              category: 'Upper Chain', tilt: 'Cuff / scapular stability; elbow tolerance' },
      conditioning: { axis: 'conditioning', label: 'Repeat-power capacity',           category: 'Recovery',    tilt: 'Repeat-power intervals; aerobic base' },
      power:        { axis: 'power',         label: 'Rotational / single-leg power',   category: 'Core',        tilt: 'Rotational power; single-leg drive' },
    },
    defaultP1: 'durability',
  },
  generic: {
    discipline: 'Your sport',
    energySystem: 'Mixed',
    keyQualities: ['General strength', 'Work capacity', 'Movement quality'],
    injuryPriors: ['—'],
    limiters: {
      durability:   { axis: 'durability',   label: 'Movement quality / joint integrity', category: 'Core',     tilt: 'Movement quality; joint prep' },
      conditioning: { axis: 'conditioning', label: 'Work capacity',                      category: 'Recovery', tilt: 'Aerobic base / work capacity' },
      power:        { axis: 'power',         label: 'Strength-speed',                     category: 'Strength', tilt: 'Strength base before power' },
    },
    defaultP1: 'durability',
  },
}

// ---- §4b  Arena (number) → limiter map -------------------------------------

export type NumberLimiterAxis = 'off_bottom' | 'lockout' | 'structural'

export type LiftKey = 'bench' | 'squat' | 'deadlift' | 'overhead' | 'pullup' | 'generic'

export const NUMBER_LIMITER_MAP: Record<LiftKey, Record<NumberLimiterAxis, LimiterCandidate>> = {
  bench: {
    off_bottom: { axis: 'off_bottom', label: 'Starting strength off the chest', category: 'Strength',    tilt: 'Paused / Spoto work; volume off the chest' },
    lockout:    { axis: 'lockout',    label: 'Top-end / triceps',              category: 'Upper Chain', tilt: 'Boards, close-grip, triceps volume' },
    structural: { axis: 'structural', label: 'Shoulder structural weak link',  category: 'Upper Chain', tilt: 'Hold load; scapular / cuff stability first ("never load over instability")' },
  },
  squat: {
    off_bottom: { axis: 'off_bottom', label: 'Out of the hole / quad & position', category: 'Strength',        tilt: 'Pause squats, tempo, quad volume' },
    lockout:    { axis: 'lockout',    label: 'Top-end / posterior drive',         category: 'Posterior Chain', tilt: 'Bands/chains or partials; hip drive, back strength' },
    structural: { axis: 'structural', label: 'Low-back / bracing weak link',      category: 'Core',            tilt: 'Hold load; bracing & trunk stiffness first' },
  },
  deadlift: {
    off_bottom: { axis: 'off_bottom', label: 'Off the floor / starting strength', category: 'Strength',        tilt: 'Deficit / pause pulls; leg drive' },
    lockout:    { axis: 'lockout',    label: 'Lockout / posterior chain',         category: 'Posterior Chain', tilt: 'Block pulls, hip thrust, glute / back strength' },
    structural: { axis: 'structural', label: 'Low-back tolerance weak link',      category: 'Core',            tilt: 'Hold load; position & bracing first' },
  },
  overhead: {
    off_bottom: { axis: 'off_bottom', label: 'Off the shoulders / starting strength',  category: 'Strength',    tilt: 'Pause / pin press; volume from the bottom' },
    lockout:    { axis: 'lockout',    label: 'Lockout / triceps & overhead stability', category: 'Upper Chain', tilt: 'Triceps, partials, overhead stability' },
    structural: { axis: 'structural', label: 'Shoulder structural weak link',          category: 'Upper Chain', tilt: 'Hold load; cuff / scapular stability first' },
  },
  pullup: {
    off_bottom: { axis: 'off_bottom', label: 'Dead-hang start strength', category: 'Upper Chain', tilt: 'Scapular pulls, bottom-range holds, eccentrics' },
    lockout:    { axis: 'lockout',    label: 'Top / chin-over strength', category: 'Upper Chain', tilt: 'Top-range holds, band-assisted top, heavy rows' },
    structural: { axis: 'structural', label: 'Scapular control weak link', category: 'Upper Chain', tilt: 'Scapular stability & control first' },
  },
  generic: {
    off_bottom: { axis: 'off_bottom', label: 'Starting strength',     category: 'Strength', tilt: 'Volume from the bottom range; pauses' },
    lockout:    { axis: 'lockout',    label: 'Top-end strength',       category: 'Strength', tilt: 'Partials; accessory for the top range' },
    structural: { axis: 'structural', label: 'Structural weak link',   category: 'Strength', tilt: 'Hold load; stabilize the weak link first' },
  },
}

// ---- §3  Move 2 — the adaptive Limiter question (per arena) -----------------
// For 'sport' and 'number' the option only names the axis; resolveLimiter()
// merges it with the chosen discipline/lift (the §4a/§4b tables). For the other
// arenas the option carries its full resolution inline.

export interface LimiterOption {
  axis: string
  label: string                    // button copy, e.g. 'Body breaks down'
  resolves?: LimiterCandidate      // present when resolution is arena-only (not sport/lift-conditioned)
}

export interface LimiterQuestion {
  question: string
  options: LimiterOption[]
}

export const LIMITER_QUESTIONS: Record<ArenaType, LimiterQuestion> = {
  sport: {
    question: 'When you fall short, what gives first?',
    options: [
      { axis: 'durability',   label: 'Body breaks down' },
      { axis: 'conditioning', label: 'Run out of gas' },
      { axis: 'power',        label: 'Not explosive enough' },
    ],
  },
  number: {
    question: 'Where does the lift die?',
    options: [
      { axis: 'off_bottom', label: 'Off the bottom' },
      { axis: 'lockout',    label: 'At lockout' },
      { axis: 'structural', label: 'Something gives out' },
    ],
  },
  body: {
    question: 'Right now — build or reveal?',
    options: [
      { axis: 'hypertrophy', label: 'Build muscle',          resolves: { axis: 'hypertrophy', label: 'Hypertrophy stimulus & volume tolerance', category: 'Strength', tilt: 'Hypertrophy volume; progressive overload' } },
      { axis: 'composition', label: 'Lean out',              resolves: { axis: 'composition', label: 'Energy balance / conditioning',           category: 'Recovery', tilt: 'Conditioning + work capacity (nutrition out of scope)' } },
      { axis: 'capacity',    label: 'Can’t recover to push', resolves: { axis: 'capacity',    label: 'Recovery capacity',                       category: 'Recovery', tilt: 'Manage volume; recovery & work capacity' } },
    ],
  },
  durability: {
    question: 'One spot, or everything?',
    options: [
      { axis: 'localize',  label: 'One spot keeps flaring',   resolves: { axis: 'localize',  label: 'Localized tissue / joint',  category: 'Core',     tilt: 'Progressive localized loading of the flaring site' } },
      { axis: 'global',    label: 'Stiff & fragile all over', resolves: { axis: 'global',    label: 'Global movement quality',   category: 'Core',     tilt: 'Full-body mobility & movement quality; tissue capacity' } },
      { axis: 'load_mgmt', label: 'I do too much',            resolves: { axis: 'load_mgmt', label: 'Load management',           category: 'Recovery', tilt: 'Autoregulation; cap load; recovery' } },
    ],
  },
  event: {
    question: 'What’s the gap to the start line?',
    options: [
      { axis: 'aerobic',          label: 'Won’t last the distance',  resolves: { axis: 'aerobic',          label: 'Aerobic capacity',            category: 'Recovery',    tilt: 'Aerobic base / volume to the event demand' } },
      { axis: 'specificity',      label: 'Strong but not race-ready', resolves: { axis: 'specificity',      label: 'Event-specific strength/skill', category: 'Strength',    tilt: 'Event-specific strength & skill transfer' } },
      { axis: 'capacity_ceiling', label: 'Keep breaking',            resolves: { axis: 'capacity_ceiling', label: 'Tissue capacity ceiling',     category: 'Lower Chain', tilt: 'Tissue capacity; durability under volume' } },
    ],
  },
  all_around: {
    question: 'What’s the weakest link you already feel?',
    options: [
      { axis: 'strength',     label: 'Strength',          resolves: { axis: 'strength',     label: 'Strength base',                category: 'Strength', tilt: 'General strength base' } },
      { axis: 'conditioning', label: 'Conditioning',      resolves: { axis: 'conditioning', label: 'Conditioning base',            category: 'Recovery', tilt: 'Aerobic / work-capacity base' } },
      { axis: 'mobility',     label: 'Mobility / movement', resolves: { axis: 'mobility',   label: 'Mobility / movement quality',  category: 'Core',     tilt: 'Movement quality & mobility base' } },
    ],
  },
}

// ---- §4c  Obstacle keyword → limiter prior ---------------------------------
// The SINGLE source for obstacle keyword hints. engine/index.ts derives its
// OBSTACLE_CATEGORY_HINTS from this (extend, don't duplicate — Convergence §4c).
// Order matters: first match wins. The first six rows preserve the legacy
// category mapping exactly; each now also names the limiter it nudges toward.

export interface ObstacleHint {
  test: RegExp
  category: CategoryName
  label: string
}

export const OBSTACLE_LIMITER_HINTS: ObstacleHint[] = [
  { test: /knee|ankle|squat|lunge|calf|shin|quad|hip(?!\s*flex)/i, category: 'Lower Chain',     label: 'Lower-chain limiter' },
  { test: /shoulder|elbow|wrist|press|overhead|rotator|pec|bench/i, category: 'Upper Chain',     label: 'Upper-chain limiter' },
  { test: /hamstring|glute|deadlift|hinge|rdl|posterior|sprint|run/i, category: 'Posterior Chain', label: 'Posterior-chain limiter' },
  { test: /back|spine|core|ab|lumbar|brace|rotation/i, category: 'Core',            label: 'Trunk / core limiter' },
  { test: /tired|sleep|energy|recover|stress|burn|fatigue/i, category: 'Recovery',        label: 'Recovery limiter' },
  { test: /weak|strong|stall|plateau|stuck|1rm|max/i, category: 'Strength',        label: 'Strength limiter' },
]

/** Obstacle free text → a limiter prior, or null if nothing matches. */
export function obstacleLimiterPrior(obstacle: string | null | undefined): LimiterCandidate | null {
  if (!obstacle) return null
  const hit = OBSTACLE_LIMITER_HINTS.find((h) => h.test.test(obstacle))
  if (!hit) return null
  return { axis: 'obstacle', label: hit.label, category: hit.category, tilt: `Address the ${hit.label.toLowerCase()} the athlete named` }
}

// Back-compat shape for engine/index.ts deterministicProbe (category-only).
export const OBSTACLE_CATEGORY_HINTS: Array<{ test: RegExp; category: CategoryName }> =
  OBSTACLE_LIMITER_HINTS.map((h) => ({ test: h.test, category: h.category }))

// ---- Classifiers (free-text escape hatch → enum; deterministic, v1) --------

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface ArenaClassification {
  type: ArenaType
  confidence: 'high' | 'low'   // 'low' ⇒ free text fell through to the default cloud
}

// First match wins; order resolves overlaps (event before sport so "run a
// marathon" is an event, not generic running; number before sport so "bench"
// reads as a lift). Falls back to the wide all-around cloud (Convergence §2).
const ARENA_PATTERNS: Array<{ type: ArenaType; test: RegExp }> = [
  { type: 'event',      test: /\b(marathon|spartan|hyrox|triathlon|ironman|race|5k|10k|half|ultra|tough mudder|gran fondo|century|on\s+\w+\s+\d{1,2}|in\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i },
  { type: 'number',     test: /\b(\d{2,4}\s?(lb|lbs|kg|pound|pounds)|bench|squat|deadlift|dead lift|press|ohp|overhead|pull[- ]?up|pullup|chin[- ]?up|1\s?rm|1rm|pr\b|first (pull|chin)|hit \d)/i },
  { type: 'durability', test: /\b(pain|hurt|injur|injury|tweak|nagging|prehab|rehab|impinge|impingement|tendon|flare|pain[- ]?free|stop getting hurt|stay healthy|bad (back|knee|shoulder|hip))\b/i },
  { type: 'body',       test: /\b(jacked|lean|aesthetic|abs|muscle|hypertroph|tone|toned|shred|physique|lose (weight|fat)|gain (muscle|mass|size)|bigger|build muscle|cut\b|bulk)\b/i },
  { type: 'sport',      test: /\b(basketball|hoops|soccer|football|baseball|tennis|squash|badminton|pickleball|volleyball|hockey|rugby|lacrosse|mma|boxing|bjj|jiu|jitsu|muay|wrestl|crossfit|my sport|play\b|game\b|on the (court|field|pitch|mat))\b/i },
  { type: 'all_around', test: /\b(complete athlete|all[- ]?around|all[- ]?round|well[- ]?rounded|general|overall|everything|balanced|fit\b|fitness|healthy)\b/i },
]

export function classifyArena(text: string | null | undefined): ArenaClassification {
  if (!text || !text.trim()) return { type: 'all_around', confidence: 'low' }
  const t = ` ${norm(text)} `
  for (const { type, test } of ARENA_PATTERNS) {
    if (test.test(t)) return { type, confidence: 'high' }
  }
  return { type: 'all_around', confidence: 'low' }
}

const SPORT_ALIASES: Array<{ key: SportKey; test: RegExp }> = [
  { key: 'basketball',    test: /basketball|hoops|\bball\b/i },
  { key: 'soccer',        test: /soccer|futbol|football|pitch/i },
  { key: 'powerlifting',  test: /powerlift|power lift|\btotal\b|\bmeet\b|wraps/i },
  { key: 'endurance_run', test: /run|running|marathon|5k|10k|half|ultra|jog/i },
  { key: 'crossfit',      test: /crossfit|cross fit|\bwod\b|hyrox|functional fitness|metcon/i },
  { key: 'combat',        test: /mma|boxing|bjj|jiu|jitsu|muay|wrestl|combat|fight|grappl|judo|kickbox/i },
  { key: 'racquet',       test: /tennis|squash|badminton|pickleball|racquet|racket|padel/i },
]

/** Best-effort sport resolution for the demand-profile lookup. */
export function matchSport(text: string | null | undefined): SportKey {
  if (!text) return 'generic'
  const t = norm(text)
  for (const { key, test } of SPORT_ALIASES) {
    if (test.test(t)) return key
  }
  return 'generic'
}

const LIFT_ALIASES: Array<{ key: LiftKey; test: RegExp }> = [
  { key: 'bench',    test: /bench/i },
  { key: 'deadlift', test: /deadlift|dead lift/i },
  { key: 'squat',    test: /squat/i },
  { key: 'overhead', test: /overhead|ohp|military|strict press|shoulder press/i },
  { key: 'pullup',   test: /pull[- ]?up|pullup|chin[- ]?up|chinup/i },
]

/** Best-effort lift resolution for the number→limiter lookup. */
export function matchLift(text: string | null | undefined): LiftKey {
  if (!text) return 'generic'
  const t = norm(text)
  for (const { key, test } of LIFT_ALIASES) {
    if (test.test(t)) return key
  }
  return 'generic'
}

// ---- Typed lookups ---------------------------------------------------------

export function getDemandProfile(sport: SportKey): DemandProfile {
  return DEMAND_PROFILES[sport]
}

export function getLimiterQuestion(arena: ArenaType): LimiterQuestion {
  return LIMITER_QUESTIONS[arena]
}

/**
 * The keystone resolution: a Move-2 answer → the limiter it sets, fully
 * conditioned on the arena + the named sport/lift, with optional refinement
 * from the obstacle feeder. Always returns a usable limiter (never throws):
 * an unknown option falls to the arena's safest default.
 */
export function resolveLimiter(input: {
  arenaType: ArenaType
  optionKey?: string | null
  sportKey?: SportKey | null
  liftKey?: LiftKey | null
  obstacle?: string | null
}): LimiterCandidate {
  const { arenaType, optionKey, sportKey, liftKey, obstacle } = input

  if (arenaType === 'sport') {
    const profile = DEMAND_PROFILES[sportKey ?? 'generic']
    const axis = (optionKey ?? profile.defaultP1) as SportLimiterAxis
    return profile.limiters[axis] ?? profile.limiters[profile.defaultP1]
  }

  if (arenaType === 'number') {
    const map = NUMBER_LIMITER_MAP[liftKey ?? 'generic']
    const axis = (optionKey ?? 'off_bottom') as NumberLimiterAxis
    return map[axis] ?? map.off_bottom
  }

  // body / durability / event / all_around — option carries its own resolution.
  const q = LIMITER_QUESTIONS[arenaType]
  const opt = q.options.find((o) => o.axis === optionKey) ?? q.options[0]
  let resolved = opt.resolves ?? q.options[0].resolves!

  // Durability "one spot keeps flaring" — let the obstacle name the region.
  if (arenaType === 'durability' && resolved.axis === 'localize') {
    const prior = obstacleLimiterPrior(obstacle)
    if (prior) resolved = { ...resolved, category: prior.category, label: `${prior.label} (localized)` }
  }
  return resolved
}

/**
 * The P1 limiter implied by the Arena alone, before Move 2 is answered. Lets the
 * convergence visual collapse a region after the first tap.
 */
export function defaultLimiter(input: {
  arenaType: ArenaType
  sportKey?: SportKey | null
  liftKey?: LiftKey | null
}): LimiterCandidate {
  return resolveLimiter({ ...input, optionKey: null })
}

// =============================================================================
// READ SYNTHESIS — the multi-axis skeleton (Phase D)
//
// CODE owns this: which axes exist, their categories, P1/P2 selection, and the
// confidence FLOORS. The agent only drafts claim LANGUAGE on top (engine layer).
// buildReadSkeleton is pure + deterministic + unit-testable — and IS the fallback
// floor: with no model at all it still produces a coherent, S&C-valid read.
//
// Axes (Convergence §1): heading (Arena) · limiter P1 + P2 (the wedge) ·
// durability (Arena+Limiter jointly) · capacity (training age).
// =============================================================================

export type ReadAxisId = 'heading' | 'limiter_p1' | 'limiter_p2' | 'durability' | 'capacity'

export interface ReadAxis {
  id: ReadAxisId
  label: string            // display name, e.g. 'Primary limiter'
  category: CategoryName   // insight-vocab bucket (code-owned)
  claim: string            // the read sentence (table-derived; agent may override)
  confidence: number       // [0,1], floored + clamped — a hypothesis, never certainty
  tilt: string | null      // program bias this axis implies (for downstream design)
}

export interface ReadSkeleton {
  arenaType: ArenaType
  heading: { discipline: string; energySystem: string; keyQualities: string[] }
  axes: ReadAxis[]
  aggregateConfidence: number
}

// Confidence FLOORS — deliberately low. The read is a hypothesis from 2 taps +
// optional text; nothing here ever reads as certainty (aggregate is clamped well
// under 1). Mirrors the ±0.15 bounded-delta discipline: code owns every number.
export const READ_FLOORS = {
  headingHigh: 0.6,        // they told us the arena directly (tapped / clear text)
  headingLow: 0.4,         // free text fell through to the default cloud
  limiterP1: 0.35,         // the forced choice points here — one tap of evidence
  limiterP1Cap: 0.5,       // the most the agent may push P1 to at the read stage
  limiterP2: 0.22,         // the secondary suspect — lower by construction
  durability: 0.3,         // population-level injury priors, not personal yet
  capacityKnown: 0.5,      // training age is a fact they gave us
  capacityUnknown: 0.18,   // not asked yet (pre-orientation) — honest placeholder
  aggregateCap: 0.55,      // the whole read never presents as more than a strong lead
} as const

function clamp01(c: number): number {
  return Math.max(0, Math.min(1, c))
}

function regionToChain(s: string): CategoryName {
  if (/knee|ankle|patell|acl|shin|calf|quad|\bhip\b/i.test(s)) return 'Lower Chain'
  if (/shoulder|elbow|wrist|rotator|cuff|\bpec\b|neck/i.test(s)) return 'Upper Chain'
  if (/hamstring|groin|glute|achilles|posterior/i.test(s)) return 'Posterior Chain'
  if (/back|spine|lumbar|core|midline/i.test(s)) return 'Core'
  return 'Core'
}

const LIFT_HEADING: Record<LiftKey, string> = {
  bench: 'Bench press', squat: 'Back squat', deadlift: 'Deadlift',
  overhead: 'Overhead press', pullup: 'Pull-up', generic: 'Your lift',
}

/** The goal direction (heading axis) — code-owned per arena. */
export function getHeading(
  arenaType: ArenaType,
  arenaRaw: string | null,
): { discipline: string; energySystem: string; keyQualities: string[] } {
  switch (arenaType) {
    case 'sport': {
      const p = DEMAND_PROFILES[matchSport(arenaRaw)]
      return { discipline: p.discipline, energySystem: p.energySystem, keyQualities: p.keyQualities }
    }
    case 'number': {
      const lift = matchLift(arenaRaw)
      return {
        discipline: lift === 'generic' ? (arenaRaw?.trim() || 'Your lift') : LIFT_HEADING[lift],
        energySystem: 'Max strength (alactic)',
        keyQualities: ['Sticking-point strength', 'Bracing', 'Joint integrity'],
      }
    }
    case 'body':
      return { discipline: 'Physique', energySystem: 'Hypertrophy + composition', keyQualities: ['Volume tolerance', 'Progressive overload', 'Recovery'] }
    case 'durability':
      return { discipline: 'Durability', energySystem: 'Movement quality + tissue capacity', keyQualities: ['Mobility', 'Joint integrity', 'Load management'] }
    case 'event':
      return { discipline: arenaRaw?.trim() || 'Your event', energySystem: 'Aerobic + event-specific', keyQualities: ['Aerobic capacity', 'Event-specific strength', 'Tissue durability'] }
    case 'all_around':
    default:
      return { discipline: 'All-around athlete', energySystem: 'Mixed (GPP base)', keyQualities: ['Strength', 'Conditioning', 'Movement quality'] }
  }
}

/** Every candidate limiter for an arena, used to pick a distinct P2. */
function allLimiterCandidates(input: {
  arenaType: ArenaType
  sportKey?: SportKey | null
  liftKey?: LiftKey | null
  obstacle?: string | null
}): LimiterCandidate[] {
  const { arenaType } = input
  return LIMITER_QUESTIONS[arenaType].options.map((o) =>
    resolveLimiter({ ...input, optionKey: o.axis }),
  )
}

/**
 * The second-most-likely limiter, distinct from the primary. Prefers a candidate
 * whose category matches the obstacle prior (the athlete's own words), else the
 * first remaining candidate. Returns null if the arena has no distinct second.
 */
export function secondaryLimiter(input: {
  arenaType: ArenaType
  sportKey?: SportKey | null
  liftKey?: LiftKey | null
  obstacle?: string | null
  primary: LimiterCandidate
}): LimiterCandidate | null {
  const { primary, obstacle } = input
  const candidates = allLimiterCandidates(input).filter((c) => c.label !== primary.label)
  if (candidates.length === 0) return null
  const prior = obstacleLimiterPrior(obstacle)
  if (prior) {
    const aligned = candidates.find((c) => c.category === prior.category)
    if (aligned) return aligned
  }
  return candidates[0]
}

/** The durability axis — injury priors / corrective load (Arena + Limiter jointly). */
function durabilityAxis(input: {
  arenaType: ArenaType
  arenaRaw: string | null
  liftKey: LiftKey | null
  primary: LimiterCandidate
}): ReadAxis {
  const { arenaType, arenaRaw, liftKey, primary } = input
  if (arenaType === 'sport') {
    const p = DEMAND_PROFILES[matchSport(arenaRaw)]
    const priors = p.injuryPriors.filter((x) => x !== '—')
    return {
      id: 'durability',
      label: 'Durability',
      category: priors.length ? regionToChain(priors[0]) : primary.category,
      claim: priors.length
        ? `Common failure points in ${p.discipline.toLowerCase()}: ${priors.join(', ').toLowerCase()}. We hold load there until they're stable.`
        : 'We keep the working joints stable before adding load.',
      confidence: READ_FLOORS.durability,
      tilt: 'Corrective / tissue-capacity bias on the injury-prone region',
    }
  }
  if (arenaType === 'number') {
    const s = NUMBER_LIMITER_MAP[liftKey ?? 'generic'].structural
    return {
      id: 'durability',
      label: 'Durability',
      category: s.category,
      claim: `${s.label} can quietly cap the lift — we stabilize it before we chase load ("never load over instability").`,
      confidence: READ_FLOORS.durability,
      tilt: s.tilt,
    }
  }
  return {
    id: 'durability',
    label: 'Durability',
    category: primary.category,
    claim: 'We keep the working joints stable before adding load.',
    confidence: READ_FLOORS.durability,
    tilt: 'Stabilize before loading',
  }
}

/** The capacity axis — funnel start + convergence rate (training age). */
function capacityAxis(trainingAge: number | null | undefined): ReadAxis {
  if (trainingAge == null) {
    return {
      id: 'capacity',
      label: 'Capacity',
      category: 'Recovery',
      claim: 'Sharpens once you tell me your training age — it sets where you start and how fast we converge.',
      confidence: READ_FLOORS.capacityUnknown,
      tilt: null,
    }
  }
  let claim: string
  if (trainingAge < 1) claim = 'New to training — the general base IS your fastest path, so we converge slowly and bank it.'
  else if (trainingAge <= 3) claim = 'Developing base — room to specialize as the base banks.'
  else claim = 'Experienced — the base is banked, so we can converge faster and load sooner.'
  return {
    id: 'capacity',
    label: 'Capacity',
    category: 'Recovery',
    claim,
    confidence: READ_FLOORS.capacityKnown,
    tilt: trainingAge < 1 ? 'General work, slow progression' : trainingAge <= 3 ? 'Mixed general/specific' : 'Earlier specificity, faster load',
  }
}

/**
 * Build the full multi-axis read from the answers + the demand tables. Pure and
 * deterministic — no I/O, no model. The engine's synthesizeRead wraps this and
 * layers agent-drafted language on top; with no model this stands alone as the
 * coherent, S&C-valid fallback read.
 */
export function buildReadSkeleton(input: {
  arenaType: ArenaType
  arenaRaw: string | null
  limiterChoice: string | null
  obstacle?: string | null
  trainingAge?: number | null
  arenaConfidence?: 'high' | 'low'
}): ReadSkeleton {
  const { arenaType, arenaRaw, limiterChoice, obstacle, trainingAge, arenaConfidence = 'high' } = input
  const sportKey = arenaType === 'sport' ? matchSport(arenaRaw) : null
  const liftKey = arenaType === 'number' ? matchLift(arenaRaw) : null

  const heading = getHeading(arenaType, arenaRaw)
  const p1 = resolveLimiter({ arenaType, optionKey: limiterChoice, sportKey, liftKey, obstacle })
  const p2 = secondaryLimiter({ arenaType, sportKey, liftKey, obstacle, primary: p1 })

  const axes: ReadAxis[] = []

  axes.push({
    id: 'heading',
    label: 'Heading',
    category: p1.category,
    claim: `${heading.discipline}: ${heading.energySystem.toLowerCase()}. Built on ${heading.keyQualities.slice(0, 3).join(', ').toLowerCase()}.`,
    confidence: arenaConfidence === 'high' ? READ_FLOORS.headingHigh : READ_FLOORS.headingLow,
    tilt: `Converge toward ${heading.discipline.toLowerCase()}`,
  })

  axes.push({
    id: 'limiter_p1',
    label: 'Primary limiter',
    category: p1.category,
    claim: `Most likely first limiter: ${p1.label.toLowerCase()}.`,
    confidence: READ_FLOORS.limiterP1,
    tilt: p1.tilt,
  })

  if (p2) {
    axes.push({
      id: 'limiter_p2',
      label: 'Secondary suspect',
      category: p2.category,
      claim: `Second suspect: ${p2.label.toLowerCase()}.`,
      confidence: READ_FLOORS.limiterP2,
      tilt: p2.tilt,
    })
  }

  axes.push(durabilityAxis({ arenaType, arenaRaw, liftKey, primary: p1 }))
  axes.push(capacityAxis(trainingAge))

  const aggregateConfidence = clamp01(
    Math.min(
      READ_FLOORS.aggregateCap,
      axes.reduce((s, a) => s + a.confidence, 0) / axes.length,
    ),
  )

  return { arenaType, heading, axes, aggregateConfidence }
}
