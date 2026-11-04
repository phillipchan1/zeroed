/**
 * Methodology resolution and override guards, the pure half (G3). No I/O:
 * worker/src/methodology.ts reads the rows and calls these.
 *
 *   effective = global version  →  athlete overrides (track_id null)
 *                               →  that track's overrides (track_id = X)
 *                               →  the under-18 clamp, last, for a minor
 *
 * Guards (D2, D6, section 8):
 *   - Paths are a closed schema; anything else is refused, as is a value of
 *     the wrong type or out of range.
 *   - The under-18 rules (minors.*) can only be tightened, for anyone; for an
 *     athlete under 18 no override may loosen any rule that has a stricter
 *     direction, and the clamp still applies on top.
 *   - The universal pain cap is 3/10 at most. The raised cap (≤ 5/10 if it
 *     settles by the next morning) is a per-region opt-in, never for a minor
 *     (nor when age is unknown), and never on a region with a red flag.
 *   - A red flag (U7.regions.<r>.blocked) can be set by any proposal; only the
 *     athlete clears it (cleared by a clinician). Red flags always block.
 */
import type { LiftModelParams } from '../../../src/engine/liftModel.ts'
import {
  CONTACT_LEVELS, PAIN_REGIONS,
  type Methodology, type MethodologyParams, type MinorsRules, type Range,
} from './v1.ts'

export interface OverrideRecord {
  id: string
  track_id: string | null
  path: string
  value: unknown
}

export interface Resolved {
  version: string
  base_version: string
  params: MethodologyParams
  minors: MinorsRules
  preview_ttl_hours: number
  /** The overrides that went into params, athlete-level first. */
  applied: OverrideRecord[]
  minor: boolean
}

type Obj = Record<string, unknown>

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Obj)[seg]
  }
  return cur
}

function setPath(root: Obj, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur = root
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[seg] = {}
    cur = cur[seg] as Obj
  }
  cur[segs[segs.length - 1]] = clone(value)
}

/** FNV-1a, 8 hex: a short, stable fingerprint of an override set. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The version a prescription ran on: the global version alone, or with a
 * fingerprint of exactly which overrides were in force ("v1+1a2b3c4d").
 */
export function effectiveVersion(base: string, applied: OverrideRecord[], minor: boolean): string {
  if (!applied.length && !minor) return base
  const key = JSON.stringify({
    o: applied.map((o) => [o.track_id ?? '', o.path, o.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    m: minor,
  })
  return `${base}+${fingerprint(key)}`
}

function clampRange(r: Range, hi: number): Range {
  const top = Math.min(r[1], hi)
  return [Math.min(r[0], top), top]
}

/** The under-18 rules on top of everything else: they only ever take numbers down. */
function clampForMinor(p: MethodologyParams, m: MinorsRules): void {
  p.U5.base_rpe = clampRange(p.U5.base_rpe, m.max_rpe)
  p.U5.top_single_rpe = clampRange(p.U5.top_single_rpe, m.max_rpe)
  p.U11.deload_rpe_cap = Math.min(p.U11.deload_rpe_cap, m.max_rpe)
  for (const level of CONTACT_LEVELS) {
    p.U14.contacts_per_session[level] = clampRange(p.U14.contacts_per_session[level], m.contacts_per_session_max)
  }
  for (const rule of Object.values(p.U7.regions)) {
    if (rule) delete rule.raised_cap
  }
  // v1.2 (section 11a) loosened two rules for adults. Under 18 the stricter
  // v1.1 behaviour stands (D6): one short night or one day at stress /
  // soreness 4 is still a flag, and a block stays until a clinician clears
  // it. v1.2's tighter parts (worse-next-morning at ≥ 4, rising 3 sessions,
  // > 5 twice in 14 days) apply to minors too.
  delete p.U6.single_day_sleep_under_hours
  delete p.U6.single_day_stress_soreness_at
  if (p.U7.temporary_blocks) p.U7.temporary_blocks = false
}

/** Effective params for an athlete (and optionally one track). */
export function resolveParams(
  base: Methodology,
  overrides: OverrideRecord[],
  opts: { trackId?: string | null; minor: boolean },
): Resolved {
  const root = clone({ params: base.params, minors: base.minors }) as unknown as Obj
  const trackId = opts.trackId ?? null
  const athleteLevel = overrides.filter((o) => o.track_id == null)
  const trackLevel = trackId ? overrides.filter((o) => o.track_id === trackId) : []
  const applied: OverrideRecord[] = []
  for (const o of [...athleteLevel, ...trackLevel]) {
    const spec = specFor(o.path)
    if (!spec) continue
    // Under-18 rules only tighten (D6), against this version too: an override
    // set under an older, looser default (minors contacts 70 under v1's 80)
    // never loosens the newer one (v1.1's 60).
    if (spec.rule === 'minors' && strictness(spec, getPath(root, o.path), o.value) > 0) continue
    setPath(root, o.path.startsWith('minors.') ? o.path : `params.${o.path}`, o.value)
    applied.push(o)
  }
  const params = root.params as MethodologyParams
  const minors = root.minors as MinorsRules
  if (opts.minor) clampForMinor(params, minors)
  return {
    version: effectiveVersion(base.version, applied, opts.minor),
    base_version: base.version,
    params,
    minors,
    preview_ttl_hours: base.preview_ttl_hours,
    applied,
    minor: opts.minor,
  }
}

/** What the lift model runs on. Defaults equal its constants (methodology.check.ts). */
export function engineParams(r: Resolved): LiftModelParams {
  return {
    tmFraction: r.params.U4.tm_fraction,
    pushPct: { upper: r.params.U3.push_pct.upper, lower: r.params.U3.push_pct.lower },
    deloadTmPct: r.params.U11.deload_tm_pct,
    deloadRpeCap: r.params.U11.deload_rpe_cap,
    maxRpe: r.minor ? r.minors.max_rpe : null,
    // v1.1 (U4): RPE-less sets by Epley, the method recorded. v1 leaves it out: today's math.
    ...(r.params.U4.e1rm_without_rpe === 'epley' ? { e1rmNoRpe: 'epley' as const } : {}),
  }
}

/** Regions with a red flag: no loading there, whatever else is set. */
export function blockedRegions(r: Resolved): string[] {
  return Object.entries(r.params.U7.regions).filter(([, rule]) => rule?.blocked === true).map(([region]) => region).sort()
}

// ---- the override schema -----------------------------------------------------------------

export interface PathSpec {
  /** U1–U15, or minors. */
  rule: string
  type: 'number' | 'int' | 'range' | 'bool'
  min?: number
  max?: number
  /** Which way is stricter; null when neither is. A range compares its top. */
  stricter: 'lower' | 'higher' | 'true' | 'false' | null
  /** athlete: one value per athlete (no track_id). any: per track too. */
  scope: 'athlete' | 'any'
  /** The lift model reads it (athlete scope only, since it runs per athlete). */
  engine?: boolean
}

const REGION = `(${PAIN_REGIONS.join('|')})`
const LEVEL = `(${CONTACT_LEVELS.join('|')})`

const SPECS: Array<[RegExp, PathSpec]> = [
  [/^U2\.max_priority_tracks$/, { rule: 'U2', type: 'int', min: 1, max: 2, stricter: null, scope: 'athlete' }],
  [/^U3\.load_step_lb\.upper$/, { rule: 'U3', type: 'range', min: 1, max: 10, stricter: 'lower', scope: 'any' }],
  [/^U3\.load_step_lb\.lower$/, { rule: 'U3', type: 'range', min: 2.5, max: 20, stricter: 'lower', scope: 'any' }],
  [/^U3\.load_step_kg\.upper$/, { rule: 'U3', type: 'range', min: 0.5, max: 5, stricter: 'lower', scope: 'any' }],
  [/^U3\.load_step_kg\.lower$/, { rule: 'U3', type: 'range', min: 1, max: 10, stricter: 'lower', scope: 'any' }],
  [/^U3\.push_pct\.upper$/, { rule: 'U3', type: 'number', min: 0.5, max: 5, stricter: 'lower', scope: 'athlete', engine: true }],
  [/^U3\.push_pct\.lower$/, { rule: 'U3', type: 'number', min: 1, max: 10, stricter: 'lower', scope: 'athlete', engine: true }],
  [/^U4\.tm_fraction$/, { rule: 'U4', type: 'number', min: 0.8, max: 0.95, stricter: 'lower', scope: 'athlete', engine: true }],
  [/^U5\.base_rpe$/, { rule: 'U5', type: 'range', min: 5, max: 9, stricter: 'lower', scope: 'any' }],
  [/^U5\.top_single_rpe$/, { rule: 'U5', type: 'range', min: 6, max: 10, stricter: 'lower', scope: 'any' }],
  [/^U5\.hold_after_weeks_over$/, { rule: 'U5', type: 'int', min: 1, max: 4, stricter: 'lower', scope: 'any' }],
  [/^U5\.deload_or_swap_after_weeks_over$/, { rule: 'U5', type: 'int', min: 2, max: 6, stricter: 'lower', scope: 'any' }],
  [/^U5\.backoff_pct_under_top$/, { rule: 'U5', type: 'range', min: 0, max: 20, stricter: 'higher', scope: 'any' }],
  [/^U7\.pain_cap$/, { rule: 'U7', type: 'int', min: 0, max: 3, stricter: 'lower', scope: 'athlete' }],
  [new RegExp(`^U7\\.regions\\.${REGION}\\.raised_cap$`), { rule: 'U7', type: 'bool', stricter: 'false', scope: 'athlete' }],
  [new RegExp(`^U7\\.regions\\.${REGION}\\.blocked$`), { rule: 'U7', type: 'bool', stricter: 'true', scope: 'athlete' }],
  [/^U9\.hiit_minutes$/, { rule: 'U9', type: 'range', min: 5, max: 30, stricter: 'lower', scope: 'any' }],
  [/^U9\.hiit_max_per_week$/, { rule: 'U9', type: 'int', min: 0, max: 3, stricter: 'lower', scope: 'any' }],
  [/^U9\.conditioning_gap_hours$/, { rule: 'U9', type: 'number', min: 0, max: 24, stricter: 'higher', scope: 'any' }],
  [/^U10\.straight_sets_at_or_above_rpe$/, { rule: 'U10', type: 'number', min: 7, max: 10, stricter: 'lower', scope: 'any' }],
  [/^U10\.main_lift_rest_s$/, { rule: 'U10', type: 'range', min: 60, max: 300, stricter: null, scope: 'any' }],
  [/^U11\.deload_every_weeks$/, { rule: 'U11', type: 'range', min: 3, max: 8, stricter: 'lower', scope: 'any' }],
  [/^U11\.deload_tm_pct$/, { rule: 'U11', type: 'number', min: 50, max: 75, stricter: 'lower', scope: 'athlete', engine: true }],
  [/^U11\.deload_rpe_cap$/, { rule: 'U11', type: 'number', min: 5, max: 7, stricter: 'lower', scope: 'athlete', engine: true }],
  [/^U11\.compliance_trigger$/, { rule: 'U11', type: 'number', min: 0.5, max: 0.9, stricter: 'higher', scope: 'any' }],
  [/^U13\.small_edit_max_fraction$/, { rule: 'U13', type: 'number', min: 0.1, max: 0.5, stricter: 'lower', scope: 'any' }],
  [new RegExp(`^U14\\.contacts_per_session\\.${LEVEL}$`), { rule: 'U14', type: 'range', min: 0, max: 200, stricter: 'lower', scope: 'any' }],
  [/^U15\.compliance_target$/, { rule: 'U15', type: 'number', min: 0.5, max: 1, stricter: 'higher', scope: 'any' }],
  [/^minors\.max_rpe$/, { rule: 'minors', type: 'number', min: 5, max: 8, stricter: 'lower', scope: 'athlete' }],
  [/^minors\.contacts_per_session_max$/, { rule: 'minors', type: 'int', min: 0, max: 80, stricter: 'lower', scope: 'athlete' }],
]

/** Fixed by the spec or a decision: listed so the refusal says why, not just "unknown". */
const FIXED: Array<[RegExp, string]> = [
  [/^U7\.red_flags_block$/, 'red flags always block loading for that region (section 8)'],
  [/^U7\.(raised_cap|raised_cap_requires|stop_above|regress_band)$/, 'the pain bands are fixed; raise one region with U7.regions.<region>.raised_cap (D2)'],
  [/^preview_ttl_hours$|^params\.preview_ttl_hours$/, 'previews expire after 24 h for everyone (section 6)'],
  [/^U8\.order$/, 'session order is the rule the validator checks (U8)'],
  [/^U4\.(e1rm_source|written_load_wins)$/, 'a written load always beats TM math (U4, #49)'],
  [/^U6\.single_day_(sleep_under_hours|stress_soreness_at)$|^U7\.(worse_next_morning_at|temporary_blocks|persistent_after(\..+)?)$/, 'the readiness and pain thresholds are set by the methodology version (U6, U7, section 11a)'],
  [/^U4\.e1rm_without_rpe$/, 'how an RPE-less set is estimated is set by the methodology version (U4, section 11)'],
  [/^minors\.(age_under|parental_consent_required|max_testing|raised_pain_cap)$/, 'under-18 rules can only be tightened, and these are already at their strictest (D6)'],
]

export function specFor(path: string): PathSpec | null {
  for (const [re, spec] of SPECS) if (re.test(path)) return spec
  return null
}

/** Every overridable path, for get_methodology. */
export const OVERRIDE_PATHS: string[] = SPECS.map(([re]) => re.source.replace(/^\^|\$$/g, '').replace(/\\\./g, '.').replace(/\(([a-z_|]+)\)/g, '<$1>'))

function asRange(v: unknown): Range | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const [lo, hi] = v
  return typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi ? [lo, hi] : null
}

/** The value, normalized, or why it doesn't fit the path. */
export function parseValue(spec: PathSpec, path: string, value: unknown): { ok: true; value: unknown } | { ok: false; text: string } {
  const bounds = `${spec.min}–${spec.max}`
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, text: `${path} takes true or false.` }
    case 'int':
    case 'number': {
      const n = typeof value === 'number' ? value : NaN
      if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) return { ok: false, text: `${path} takes ${spec.type === 'int' ? 'a whole number' : 'a number'} (${bounds}).` }
      if (n < spec.min! || n > spec.max!) return { ok: false, text: `${path} must be within ${bounds}.` }
      return { ok: true, value: n }
    }
    case 'range': {
      const r = asRange(value)
      if (!r) return { ok: false, text: `${path} takes [low, high], two numbers with low ≤ high.` }
      if (r[0] < spec.min! || r[1] > spec.max!) return { ok: false, text: `${path} must be within ${bounds}.` }
      return { ok: true, value: r }
    }
  }
}

/** −1 stricter, 0 same, 1 looser: `next` compared with `now` under this spec. */
export function strictness(spec: PathSpec, now: unknown, next: unknown): -1 | 0 | 1 {
  if (spec.stricter == null) return 0
  if (spec.type === 'bool') {
    const a = now === true
    const b = next === true
    if (a === b) return 0
    return (spec.stricter === 'true') === b ? -1 : 1
  }
  const num = (v: unknown) => (Array.isArray(v) ? Number(v[1]) : Number(v))
  const a = num(now)
  const b = num(next)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
    if (Array.isArray(now) && Array.isArray(next) && Number(now[0]) !== Number(next[0])) {
      const lo = Number(next[0]) < Number(now[0])
      return (spec.stricter === 'lower') === lo ? -1 : 1
    }
    return 0
  }
  return (spec.stricter === 'lower') === (b < a) ? -1 : 1
}

export interface OverrideCheckInput {
  path: string
  /** Absent with clear. */
  value?: unknown
  clear: boolean
  trackId: string | null
  /** Effective at the target scope now, and with this path's own override taken out. */
  now: Resolved
  withoutThis: Resolved
  /** True under 18, false 18+, null when the athlete's age isn't known. */
  minor: boolean | null
  /** Who proposed it (the preview's author). */
  actorType: 'athlete' | 'mcp' | 'app_coach' | 'system'
  /** Whether an override row for this path and scope exists now. */
  exists: boolean
}

export type OverrideCheck =
  | { ok: true; spec: PathSpec; before: unknown; after: unknown }
  | { ok: false; text: string }

/** Every guard an override must pass, at preview and again at apply. */
export function checkOverride(input: OverrideCheckInput): OverrideCheck {
  const path = input.path.trim()
  for (const [re, why] of FIXED) {
    if (re.test(path)) return { ok: false, text: `Refused: ${path} can't be overridden — ${why}.` }
  }
  const spec = specFor(path)
  if (!spec) return { ok: false, text: `Refused: unknown methodology path "${path}". get_methodology lists the paths a coach can override.` }
  if (spec.scope === 'athlete' && input.trackId) {
    return { ok: false, text: `Refused: ${path} is set per athlete, not per track${spec.engine ? ' (the lift model reads it for every lift)' : ''}. Leave track out.` }
  }
  if (input.clear && !input.exists) return { ok: false, text: `Refused: there is no override on ${path}${input.trackId ? ' for that track' : ''} to clear.` }
  const before = getPath(input.now.params, path) ?? getPath({ minors: input.now.minors }, path)
  let after: unknown
  if (input.clear) {
    after = getPath(input.withoutThis.params, path) ?? getPath({ minors: input.withoutThis.minors }, path)
  } else {
    const parsed = parseValue(spec, path, input.value)
    if (!parsed.ok) {
      if (path === 'U7.pain_cap' && typeof input.value === 'number' && input.value > 3) {
        return { ok: false, text: 'Refused: the universal pain cap stays at 3/10 or lower (D2). A coach can raise ONE region to "≤ 5/10 if it settles by the next morning" with U7.regions.<region>.raised_cap = true.' }
      }
      return { ok: false, text: `Refused: ${parsed.text}` }
    }
    after = parsed.value
  }
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) {
    return { ok: false, text: `Refused: ${path} is already ${JSON.stringify(after)}; nothing to change.` }
  }
  const looser = strictness(spec, before, after) > 0

  const region = /^U7\.regions\.([a-z_]+)\.(raised_cap|blocked)$/.exec(path)
  if (region && region[2] === 'raised_cap' && after === true) {
    if (input.minor === true) return { ok: false, text: 'Refused: a raised pain cap is never allowed for an athlete under 18 (D2).' }
    if (input.minor == null) return { ok: false, text: 'Refused: a raised pain cap needs the athlete\'s date of birth on file showing 18+; it is never allowed for a minor (D2).' }
    if (input.now.params.U7.regions[region[1] as keyof typeof input.now.params.U7.regions]?.blocked === true) {
      return { ok: false, text: `Refused: ${region[1]} has a red flag. Red flags always block loading there; no cap can be raised until a clinician clears it.` }
    }
  }
  // Under-18 rules: tightened only, for anyone.
  if (spec.rule === 'minors' && looser) {
    return { ok: false, text: `Refused: under-18 rules can only be tightened, never loosened (D6). ${path} is ${JSON.stringify(before)}.` }
  }
  // An athlete under 18: nothing loosens.
  if (input.minor === true && looser) {
    return { ok: false, text: `Refused: this athlete is under 18; their rules can only be tightened (D6). ${path} is ${JSON.stringify(before)}.` }
  }
  if (region && region[2] === 'blocked' && after !== true && input.actorType !== 'athlete') {
    return { ok: false, text: `Refused: only the athlete can clear a red flag on ${region[1]}, once a clinician has cleared it (section 8). A coach can only set one.` }
  }
  return { ok: true, spec, before: before ?? null, after: after ?? null }
}
