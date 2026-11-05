// =============================================================================
// EVIDENCE — what one session's sets say about a capacity, and how sure.
//
// A coach doesn't wait for a test day to know where a lift is. Every working
// set says something: 285×3 @8 is a max of about 315; 8 pull-ups @8 is about
// ten to failure; eight rounds holding 22 calories on the bike is the engine.
// This file reads those sets. It doesn't decide what a goal is or when to test;
// capacity.ts does that from the measurements this file feeds.
//
// Every reading carries a TIER, because "how strong are you" and "how do we
// know" are different questions and the athlete deserves both answers:
//
//   tested    a max-intent effort: a single at RPE 9+, a jump, a sprint,
//             a measured hold, a counted rate. The number was done.
//   strong    two or more heavy sets (1–3 reps, RPE 8+) that agree within 2%.
//             As good as a test for calling a goal done.
//   estimate  a usable working set off the RPE chart. Honest, not proof.
//   inferred  a related lift through a ratio (liftFamilies.ts). The weakest.
//
// The tier is written into the measurement's note ("Bench Press — 285×3 @8 ·
// estimate") so a person can read it and the code can parse it back, and no
// schema change was needed to carry it.
//
// Pure, no I/O (see evidence.check.ts).
// =============================================================================

import { e1rmFromSet } from './liftModel.ts'

export const EVIDENCE_TIERS = ['tested', 'strong', 'estimate', 'inferred'] as const
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number]

/** How much a tier counts when readings are pooled into one capacity. */
export const TIER_WEIGHT: Record<EvidenceTier, number> = {
  tested: 3,
  strong: 2,
  estimate: 1,
  inferred: 0.5,
}

/** Tiers good enough to call a goal Zeroed. */
export function isProof(tier: EvidenceTier): boolean {
  return tier === 'tested' || tier === 'strong'
}

export interface EvidenceSet {
  weight?: number | null
  reps?: number | null
  rpe?: number | null
  done?: boolean
  missed_reps?: number | null
  duration?: number | null
  distance?: number | null
  /** Conditioning output for the round or set: calories, meters or watts. */
  output?: number | null
  output_unit?: string | null
  /** A skill's tries and successes in the set. */
  attempts?: number | null
  makes?: number | null
}

export interface Evidence {
  value: number
  tier: EvidenceTier
  /** The set behind it, as a person reads it: "285×3 @8". */
  detail: string
}

// Below RPE 7 a set says too little about a max to count (liftModel agrees).
export const MIN_USABLE_RPE = 7
// The chart is good to 12 reps; past 10 it overshoots enough to leave out.
export const MAX_ESTIMATE_REPS = 10

function fmt(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function setDetail(weight: number, reps: number, rpe: number | null | undefined): string {
  return `${fmt(weight)}×${reps}${rpe != null ? ` @${fmt(rpe)}` : ''}`
}

/** A set that counts toward a strength estimate. A missed rep is a failed set, not a reading. */
function usableStrengthSet(s: EvidenceSet): s is EvidenceSet & { weight: number; reps: number } {
  if (s.done !== true) return false
  if (!(typeof s.weight === 'number' && s.weight > 0)) return false
  if (!(typeof s.reps === 'number' && s.reps >= 1 && s.reps <= MAX_ESTIMATE_REPS)) return false
  if ((s.missed_reps ?? 0) > 0) return false
  if (s.rpe != null && s.rpe < MIN_USABLE_RPE) return false
  return true
}

/**
 * The best estimated max in a session, off the RTS reps × RPE chart. A set
 * with no RPE reads at 10: what it proves, never a guess upward. `load` maps
 * a set to the load the max is of (bodyweight + added, for a pull-up).
 */
export function strengthEvidence(
  sets: EvidenceSet[],
  load: (s: EvidenceSet) => number | null = (s) => s.weight ?? null,
): Evidence | null {
  const read: Array<{ e1: number; reps: number; rpe: number | null; weight: number }> = []
  for (const s of sets) {
    if (!usableStrengthSet(s)) continue
    const w = load(s)
    if (w == null || !(w > 0)) continue
    const e1 = e1rmFromSet(w, s.reps, s.rpe ?? null)
    if (e1 == null || !Number.isFinite(e1)) continue
    read.push({ e1, reps: s.reps, rpe: s.rpe ?? null, weight: s.weight })
  }
  if (!read.length) return null
  const best = read.reduce((a, b) => (b.e1 > a.e1 ? b : a))
  let tier: EvidenceTier = 'estimate'
  if (best.reps === 1 && (best.rpe == null || best.rpe >= 9)) tier = 'tested'
  else {
    const heavy = read.filter((r) => r.reps <= 3 && r.rpe != null && r.rpe >= 8 && Math.abs(r.e1 - best.e1) / best.e1 <= 0.02)
    if (heavy.length >= 2) tier = 'strong'
  }
  return { value: best.e1, tier, detail: setDetail(best.weight, best.reps, best.rpe) }
}

/**
 * Reps to failure: 8 @8 is about 10. A set with no RPE is what was done, a
 * floor. Only RPE 9.5+ (or an honest 10) counts as a test of max reps.
 */
export function repsToFailureEvidence(sets: EvidenceSet[]): Evidence | null {
  let best: Evidence | null = null
  for (const s of sets) {
    if (s.done !== true || !(typeof s.reps === 'number' && s.reps >= 1)) continue
    if (s.rpe != null && s.rpe < MIN_USABLE_RPE) continue
    const value = s.reps + (s.rpe != null ? 10 - s.rpe : 0)
    const tier: EvidenceTier = s.rpe != null && s.rpe >= 9.5 ? 'tested' : 'estimate'
    if (!best || value > best.value) {
      best = { value, tier, detail: `${s.reps} reps${s.rpe != null ? ` @${fmt(s.rpe)}` : ''}` }
    }
  }
  return best
}

function outputSets(sets: EvidenceSet[], unit: string | null): Array<EvidenceSet & { output: number }> {
  const want = normalizeOutputUnit(unit)
  return sets.filter((s): s is EvidenceSet & { output: number } => {
    if (s.done !== true || !(typeof s.output === 'number' && s.output > 0)) return false
    const have = normalizeOutputUnit(s.output_unit ?? null)
    return !want || !have || want === have
  })
}

export const OUTPUT_UNITS = ['cal', 'm', 'W'] as const
export type OutputUnit = (typeof OUTPUT_UNITS)[number]

export function normalizeOutputUnit(unit: string | null | undefined): OutputUnit | null {
  const u = String(unit ?? '').trim().toLowerCase()
  if (!u) return null
  if (['cal', 'cals', 'kcal', 'calories'].includes(u)) return 'cal'
  if (['m', 'meter', 'meters', 'metres'].includes(u)) return 'm'
  if (['w', 'watt', 'watts'].includes(u)) return 'W'
  return null
}

/**
 * Conditioning output: the mean across the rounds that logged one. Same RPE,
 * more output, better engine — the read's detail carries the RPE so the two
 * stay together.
 */
export function outputEvidence(sets: EvidenceSet[], unit: string | null): Evidence | null {
  const rows = outputSets(sets, unit)
  if (!rows.length) return null
  const mean = rows.reduce((a, s) => a + s.output, 0) / rows.length
  const rpes = rows.map((s) => s.rpe).filter((r): r is number => typeof r === 'number')
  const rpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null
  const u = normalizeOutputUnit(rows[0].output_unit ?? unit) ?? ''
  return {
    value: mean,
    tier: 'estimate',
    detail: `${rows.length} round${rows.length === 1 ? '' : 's'} avg ${fmt(mean)}${u ? ` ${u}` : ''}${rpe != null ? ` @${fmt(rpe)}` : ''}`,
  }
}

/** Last round over first, as a percent. 100 is no fade. Needs three rounds. */
export function fadeEvidence(sets: EvidenceSet[], unit: string | null): Evidence | null {
  const rows = outputSets(sets, unit)
  if (rows.length < 3) return null
  const first = rows[0].output
  const last = rows[rows.length - 1].output
  const value = (last / first) * 100
  return { value, tier: 'tested', detail: `${fmt(first)} → ${fmt(last)} over ${rows.length} rounds` }
}

/** Makes over attempts, as a percent. Needs ten attempts to say anything. */
export const MIN_ATTEMPTS = 10

export function successRateEvidence(sets: EvidenceSet[]): Evidence | null {
  let attempts = 0
  let makes = 0
  for (const s of sets) {
    if (typeof s.attempts !== 'number' || s.attempts <= 0) continue
    attempts += s.attempts
    makes += Math.min(s.attempts, Math.max(0, s.makes ?? 0))
  }
  if (attempts < MIN_ATTEMPTS) return null
  return { value: (makes / attempts) * 100, tier: 'tested', detail: `${makes}/${attempts}` }
}

// ── The note: readable by a person, parseable by the code ───────────────────

const TIER_WORD: Record<EvidenceTier, string> = {
  tested: 'tested',
  strong: 'strong estimate',
  estimate: 'estimate',
  inferred: 'inferred',
}

/** "Bench Press — 285×3 @8 · estimate". */
export function formatEvidenceNote(exercise: string, ev: Pick<Evidence, 'tier' | 'detail'>, via?: string | null): string {
  const tag = ev.tier === 'inferred' && via ? `inferred from ${via}` : TIER_WORD[ev.tier]
  return `${exercise} — ${ev.detail} · ${tag}`
}

/** The tier a note was written with, or null for a note from before tiers. */
export function parseEvidenceTier(note: string | null | undefined): EvidenceTier | null {
  const m = String(note ?? '').match(/·\s*(tested|strong estimate|estimate|inferred)\b[^·]*$/i)
  if (!m) return null
  const word = m[1].toLowerCase()
  if (word === 'strong estimate') return 'strong'
  return word as EvidenceTier
}

/** The exercise a note names, for a note written by formatEvidenceNote or the bare-name notes before it. */
export function noteExercise(note: string | null | undefined): string | null {
  const text = String(note ?? '').trim()
  if (!text) return null
  const at = text.indexOf(' — ')
  return at === -1 ? text : text.slice(0, at)
}
