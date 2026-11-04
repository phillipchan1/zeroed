/**
 * Preview validators (G5, tracks_v1). Every preview path — program edits,
 * week-only overrides, and the proposals parked from them — runs these on the
 * week before and after the edit, with the athlete's methodology params:
 *
 *   U8   session order: warm-up → speed/plyo → heavy lift → accessories → conditioning
 *   U9   interference: HIIT ≤ N sessions a week; no HIIT the day before a heavy lower lift
 *   U10  supersets: no two heavy compounds, press + triceps, anything + plyo/sprint,
 *        grip-heavy + deadlift; top sets ≥ RPE 9 run straight; main-lift rest 2–3 min
 *   U13  surgical edits: more than 30% of the week's exercises changed without
 *        rewrite=true fails the preview. One exercise is always surgical (the
 *        spec's own example), so a tiny week can still take a single change.
 *   U7   red flags: loading a blocked region fails the preview
 *
 * Warnings name only what THIS edit introduces (a violation already in the
 * week before the edit is not repeated), and an exercise classify() can't
 * place is never the reason for one. Only U13 and red flags block.
 *
 * D3: a U7 warning names the blocked region, which is health data. A coach
 * the athlete hasn't shared health data with gets forViewer(result, false):
 * the same refusal with a generic message (HEALTH_HELD_TEXT) and only the
 * session as its target, never the region or the exercise that loads it.
 */
import type { ExerciseTemplate } from '../../../src/types/database.ts'
import { classify, type Classified } from './classify.ts'
import type { MethodologyParams } from './v1.ts'

export type ValidatedRule = 'U7' | 'U8' | 'U9' | 'U10' | 'U13'

export interface PreviewWarning {
  rule: ValidatedRule
  message: string
  /** The session (and exercise) it is about. */
  target: string
  /** True for U13 and red flags: the preview fails. */
  blocking?: true
}

export interface WeekSession {
  /** Stable key to pair before/after: routine id, or routine@date for an override. */
  key: string
  name: string
  /** 0 = Mon … 6 = Sun; null when unscheduled. */
  dow: number | null
  exercises: ExerciseTemplate[]
}

export interface ValidateInput {
  before: WeekSession[]
  after: WeekSession[]
  params: MethodologyParams
  /** Exercises this edit adds, drops or changes, and how many the week had. */
  changed: number
  total: number
  rewrite: boolean
  blockedRegions: string[]
}

export interface ValidateResult {
  warnings: PreviewWarning[]
  /** The first blocking warning, if any: the preview fails with it. */
  blocked: PreviewWarning | null
}

const RANK_LABEL = ['warm-up', 'speed/plyo', 'heavy lift', 'accessory', 'conditioning']

function sessionLabel(s: WeekSession): string {
  return s.name
}

// ---- U8 --------------------------------------------------------------------------------------

function orderBreaks(s: WeekSession): Map<string, PreviewWarning> {
  const out = new Map<string, PreviewWarning>()
  let highest: { rank: number; name: string } | null = null
  for (const ex of s.exercises) {
    const c = classify(ex)
    if (c.rank == null) continue
    if (highest && c.rank < highest.rank) {
      const key = `${ex.name.toLowerCase()}<${highest.name.toLowerCase()}`
      out.set(key, {
        rule: 'U8',
        message: `${ex.name} (${RANK_LABEL[c.rank]}) comes after ${highest.name} (${RANK_LABEL[highest.rank]}). Order: warm-up → speed/plyo → heavy lift → accessories → conditioning.`,
        target: `${sessionLabel(s)} · ${ex.name}`,
      })
    }
    if (!highest || c.rank > highest.rank) highest = { rank: c.rank, name: ex.name }
  }
  return out
}

// ---- U10 -------------------------------------------------------------------------------------

function pairProblem(a: Classified, b: Classified): string | null {
  const has = (c: Classified, k: Parameters<Classified['classes']['has']>[0]) => c.classes.has(k)
  if (has(a, 'heavy') && has(b, 'heavy')) return 'two heavy compounds'
  if ((has(a, 'press') && has(b, 'triceps')) || (has(b, 'press') && has(a, 'triceps'))) return 'a press with a triceps-dominant lift'
  if (has(a, 'plyo') || has(b, 'plyo')) return 'sprints/plyos belong in straight sets'
  if ((has(a, 'grip') && has(b, 'deadlift')) || (has(b, 'grip') && has(a, 'deadlift'))) return 'grip-heavy work with a deadlift'
  return null
}

function supersetBreaks(s: WeekSession, p: MethodologyParams): Map<string, PreviewWarning> {
  const out = new Map<string, PreviewWarning>()
  const groups = new Map<string, ExerciseTemplate[]>()
  for (const ex of s.exercises) {
    const g = typeof ex.superset_group === 'string' ? ex.superset_group.trim().replace(/\d+$/, '').toUpperCase() : ''
    if (!g) continue
    groups.set(g, [...(groups.get(g) ?? []), ex])
  }
  for (const [g, list] of groups) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const why = pairProblem(classify(list[i]), classify(list[j]))
        if (!why) continue
        const names = [list[i].name, list[j].name].sort()
        out.set(`pair:${names.join('+').toLowerCase()}`, {
          rule: 'U10',
          message: `Superset ${g}: ${names.join(' + ')} — ${why}. Allowed: press + pull, upper + lower accessory, main lift + mobility/core.`,
          target: `${sessionLabel(s)} · ${names.join(' + ')}`,
        })
      }
    }
    for (const ex of list) {
      if (typeof ex.target_rpe === 'number' && ex.target_rpe >= p.U10.straight_sets_at_or_above_rpe && classify(ex).classes.has('heavy')) {
        out.set(`rpe:${ex.name.toLowerCase()}`, {
          rule: 'U10',
          message: `${ex.name} @RPE ${ex.target_rpe} is in superset ${g}; top sets at RPE ${p.U10.straight_sets_at_or_above_rpe}+ run as straight sets.`,
          target: `${sessionLabel(s)} · ${ex.name}`,
        })
      }
    }
  }
  const [lo, hi] = p.U10.main_lift_rest_s
  for (const ex of s.exercises) {
    if (typeof ex.rest_s !== 'number' || !classify(ex).classes.has('heavy')) continue
    if (ex.rest_s < lo || ex.rest_s > hi) {
      out.set(`rest:${ex.name.toLowerCase()}`, {
        rule: 'U10',
        message: `${ex.name} rests ${ex.rest_s}s; keep main-lift rest at ${lo / 60}–${hi / 60} min.`,
        target: `${sessionLabel(s)} · ${ex.name}`,
      })
    }
  }
  return out
}

// ---- U9 --------------------------------------------------------------------------------------

const hasClass = (s: WeekSession, k: 'hiit' | 'heavy_lower') => s.exercises.some((ex) => classify(ex).classes.has(k))

function interferenceBreaks(week: WeekSession[], p: MethodologyParams): Map<string, PreviewWarning> {
  const out = new Map<string, PreviewWarning>()
  const hiit = week.filter((s) => hasClass(s, 'hiit'))
  if (hiit.length > p.U9.hiit_max_per_week) {
    out.set('hiit-count', {
      rule: 'U9',
      message: `${hiit.length} sessions with HIIT this week (${hiit.map((s) => s.name).join(', ')}); keep it to ${p.U9.hiit_max_per_week} a week plus sport.`,
      target: 'week',
    })
  }
  for (const a of week) {
    if (a.dow == null || !hasClass(a, 'hiit')) continue
    const next = (a.dow + 1) % 7
    for (const b of week) {
      if (b === a || b.dow !== next || !hasClass(b, 'heavy_lower')) continue
      out.set(`eve:${a.key}>${b.key}`, {
        rule: 'U9',
        message: `HIIT in ${a.name} lands the day before the heavy lower work in ${b.name}. Move the HIIT, or put a day between them.`,
        target: `${a.name} → ${b.name}`,
      })
    }
  }
  return out
}

// ---- U7 red flags ----------------------------------------------------------------------------

/** What a coach without health access is told about a U7 refusal (D3). */
export const HEALTH_HELD_TEXT = 'This edit loads a region the athlete has held for health reasons; ask the athlete.'

/** The session a U7 warning is about, for the redacted target. */
const SESSION_OF = new WeakMap<PreviewWarning, string>()

function redFlagBreaks(before: WeekSession[], after: WeekSession[], blocked: string[]): PreviewWarning | null {
  if (!blocked.length) return null
  const had = new Map(before.map((s) => [s.key, new Set(s.exercises.map((ex) => JSON.stringify(ex)))]))
  for (const s of after) {
    const old = had.get(s.key) ?? new Set<string>()
    for (const ex of s.exercises) {
      if (old.has(JSON.stringify(ex))) continue
      const hit = classify(ex).regions.find((r) => blocked.includes(r))
      if (hit) {
        const w: PreviewWarning = {
          rule: 'U7',
          message: `Red flag: ${hit} is blocked until a clinician clears it, and ${ex.name} loads it. Red flags always block; leave it out or pick work that spares the ${hit.replace('_', ' ')}.`,
          target: `${s.name} · ${ex.name}`,
          blocking: true,
        }
        SESSION_OF.set(w, s.name)
        return w
      }
    }
  }
  return null
}

// ---- all of it -------------------------------------------------------------------------------

function newOnly(before: Map<string, PreviewWarning>, after: Map<string, PreviewWarning>): PreviewWarning[] {
  return [...after.entries()].filter(([k]) => !before.has(k)).map(([, w]) => w)
}

export function validateEdit(input: ValidateInput): ValidateResult {
  const p = input.params
  const warnings: PreviewWarning[] = []
  const prior = new Map(input.before.map((s) => [s.key, s]))
  for (const s of input.after) {
    const was = prior.get(s.key)
    const empty = new Map<string, PreviewWarning>()
    warnings.push(...newOnly(was ? orderBreaks(was) : empty, orderBreaks(s)))
    warnings.push(...newOnly(was ? supersetBreaks(was, p) : empty, supersetBreaks(s, p)))
  }
  warnings.push(...newOnly(interferenceBreaks(input.before, p), interferenceBreaks(input.after, p)))

  const red = redFlagBreaks(input.before, input.after, input.blockedRegions)
  if (red) warnings.unshift(red)

  const cap = p.U13.small_edit_max_fraction
  if (!input.rewrite && input.total > 0 && input.changed > 1 && input.changed / input.total > cap) {
    warnings.unshift({
      rule: 'U13',
      message: `This edit changes ${input.changed} of the week's ${input.total} exercises (${Math.round((input.changed / input.total) * 100)}%), over the ${Math.round(cap * 100)}% small-edit cap. Edit surgically — one exercise, set or load — or preview again with rewrite=true if a rewrite is really the call.`,
      target: 'week',
      blocking: true,
    })
  }
  const blocked = warnings.find((w) => w.blocking) ?? null
  return { warnings, blocked }
}

/**
 * The result as this viewer may see it (D3). With health data shared (the
 * athlete, app_coach, a coach with the toggle on) it is unchanged; without,
 * every U7 warning — and so the refusal — says HEALTH_HELD_TEXT instead.
 */
export function forViewer(result: ValidateResult, seesHealth: boolean): ValidateResult {
  if (seesHealth || !result.warnings.some((w) => w.rule === 'U7')) return result
  const held = (w: PreviewWarning): PreviewWarning => (w.rule === 'U7'
    ? { rule: 'U7', message: HEALTH_HELD_TEXT, target: SESSION_OF.get(w) ?? 'week', ...(w.blocking ? { blocking: true as const } : {}) }
    : w)
  const warnings = result.warnings.map(held)
  return { warnings, blocked: result.blocked ? warnings[result.warnings.indexOf(result.blocked)] ?? held(result.blocked) : null }
}

/** For preview text: a section the coach reads, with the structured list. */
export function warningsSection(warnings: PreviewWarning[]): string {
  if (!warnings.length) return ''
  return [
    '## Warnings',
    ...warnings.map((w) => `- [${w.rule}]${w.blocking ? ' BLOCKS' : ''} ${w.target}: ${w.message}`),
    '',
    '```json',
    JSON.stringify({ warnings }, null, 2),
    '```',
  ].join('\n')
}
