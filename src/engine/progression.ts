/**
 * Progression engines. Propose next week's prescription; never write it.
 *
 * Phil fixtures (spec §2 / §8):
 *   OHP 4x4 @115 all ≤ RPE 7 → 120; one set at 7.5 → hold
 *   DB bench 4x8 @100 → 105; 8/8/7/7 → 100
 *   Alactic 8 rounds → 10, lifts untouched
 */

import { isEngineType, type EngineType } from './tracks.ts'

export interface PerformedSet {
  reps: number | null
  load: number | null
  rpe: number | null
  distance?: number | null
}

export interface PerformedExercise {
  name: string
  prescribed: { sets: number; reps: string; load: string; target_rpe?: number | null }
  sets: PerformedSet[]
}

export interface ProgressionParams {
  tm?: number
  increment?: number
  target_rpe?: number
  hold_weeks?: number
  deload_weeks?: number
  rep_low?: number
  rep_high?: number
  sets?: number
  load?: number
  rounds?: number
  next_rounds?: number
  work?: string
  rest?: string
  contacts_cap_low?: number
  contacts_cap_high?: number
  held_rpe?: number
  [key: string]: unknown
}

export interface ProgressionRule {
  engine_type: EngineType
  exercise_name?: string | null
  params: ProgressionParams
}

export interface ProgressionProposal {
  exercise: string
  from: string
  to: string
  reason: string
  apply: boolean
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function loadFromPrescribed(load: string): number | null {
  const m = String(load ?? '').match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

function repsFromPrescribed(reps: string): { low: number; high: number } | null {
  const range = String(reps ?? '').match(/(\d+)\s*[-–]\s*(\d+)/)
  if (range) return { low: Number(range[1]), high: Number(range[2]) }
  const n = String(reps ?? '').match(/(\d+)/)
  return n ? { low: Number(n[1]), high: Number(n[1]) } : null
}

function roundsFromPrescribed(reps: string, sets: number): number {
  const m = String(reps ?? '').match(/(\d+)\s*[×x]/i)
  if (m) return Number(m[1])
  return sets
}

function allSetsAtOrUnderRpe(sets: PerformedSet[], target: number): boolean {
  const logged = sets.filter((s) => s.rpe != null)
  if (!logged.length) return false
  return logged.every((s) => (s.rpe ?? 99) <= target)
}

function allSetsHitReps(sets: PerformedSet[], target: number): boolean {
  const logged = sets.filter((s) => s.reps != null)
  if (!logged.length) return false
  return logged.every((s) => (s.reps ?? 0) >= target)
}

export function proposeForExercise(
  rule: ProgressionRule,
  performed: PerformedExercise,
): ProgressionProposal {
  const name = performed.name
  const p = rule.params ?? {}
  const prescribedLoad = loadFromPrescribed(performed.prescribed.load)
  const increment = num(p.increment, 5)

  switch (rule.engine_type) {
    case 'rpe_autoreg': {
      const target = num(p.target_rpe, performed.prescribed.target_rpe ?? 7)
      const fromLoad = prescribedLoad ?? num(p.load, 0)
      const from = `${performed.prescribed.sets}x${performed.prescribed.reps} @${fromLoad}`
      if (allSetsAtOrUnderRpe(performed.sets, target)) {
        const next = fromLoad + increment
        return {
          exercise: name, from, to: `${performed.prescribed.sets}x${performed.prescribed.reps} @${next}`,
          reason: `All sets ≤ RPE ${target} → ${next} next week`,
          apply: true,
        }
      }
      return {
        exercise: name, from, to: from,
        reason: `A set above RPE ${target} → hold ${fromLoad}`,
        apply: false,
      }
    }
    case 'double_progression': {
      const high = num(p.rep_high, repsFromPrescribed(performed.prescribed.reps)?.high ?? 8)
      const fromLoad = prescribedLoad ?? num(p.load, 0)
      const from = `${performed.prescribed.sets}x${p.rep_low ?? 6}-${high} @${fromLoad}`
      if (allSetsHitReps(performed.sets, high)) {
        const next = fromLoad + increment
        return {
          exercise: name, from, to: `${performed.prescribed.sets}x${p.rep_low ?? 6}-${high} @${next}`,
          reason: `All sets hit ${high} → ${next} next week`,
          apply: true,
        }
      }
      return {
        exercise: name, from, to: from,
        reason: `Not every set hit ${high} → hold ${fromLoad}`,
        apply: false,
      }
    }
    case 'maintenance': {
      const fromLoad = prescribedLoad ?? num(p.load, 0)
      const heldRpe = num(p.held_rpe, 8)
      const from = `${performed.prescribed.sets}x${performed.prescribed.reps} @${fromLoad}`
      const pr = performed.sets.some((s) =>
        s.reps != null
        && s.rpe != null
        && s.rpe <= heldRpe
        && s.reps > (repsFromPrescribed(performed.prescribed.reps)?.high ?? 0),
      )
      return {
        exercise: name, from, to: from,
        reason: pr ? `Rep PR at RPE ≤ ${heldRpe} — held` : `Maintenance — hold ${fromLoad}`,
        apply: false,
      }
    }
    case 'time_interval': {
      const current = num(p.rounds, roundsFromPrescribed(performed.prescribed.reps, performed.prescribed.sets))
      const next = num(p.next_rounds, current + 2)
      const work = String(p.work ?? '10s')
      const rest = String(p.rest ?? '50s')
      return {
        exercise: name,
        from: `${current} × ${work}/${rest}`,
        to: `${next} × ${work}/${rest}`,
        reason: `Interval progression ${current} → ${next} rounds (lifts untouched)`,
        apply: true,
      }
    }
    case 'tm_wave': {
      const tm = num(p.tm, 0)
      const top = performed.sets.reduce<PerformedSet | null>((best, s) => {
        if (s.load == null) return best
        if (!best || (s.load ?? 0) > (best.load ?? 0)) return s
        return best
      }, null)
      const cap = num(p.target_rpe, 8)
      const bump = top && top.rpe != null && top.rpe <= cap
      return {
        exercise: name,
        from: `TM ${tm}`,
        to: bump ? `TM ${tm + increment}` : `TM ${tm}`,
        reason: bump
          ? `Top set ≤ RPE ${cap} → TM ${tm + increment} next cycle`
          : `Top set above RPE ${cap} → hold TM ${tm}`,
        apply: Boolean(bump),
      }
    }
    case 'contacts': {
      const contacts = performed.prescribed.sets * (repsFromPrescribed(performed.prescribed.reps)?.high ?? 3)
      const capHi = num(p.contacts_cap_high, 80)
      return {
        exercise: name,
        from: `${contacts} contacts`,
        to: `${contacts} contacts`,
        reason: contacts > capHi
          ? `${contacts} contacts over the ${capHi} cap — cut a set`
          : `${contacts} contacts inside the cap`,
        apply: false,
      }
    }
    case 'measurement':
    case 'manual':
    default:
      return {
        exercise: name,
        from: performed.prescribed.load || performed.prescribed.reps,
        to: performed.prescribed.load || performed.prescribed.reps,
        reason: rule.engine_type === 'manual' ? 'Manual — coach sets the next value' : 'Measurement — no load change',
        apply: false,
      }
  }
}

export function proposeNextWeek(
  rules: ProgressionRule[],
  performed: PerformedExercise[],
): ProgressionProposal[] {
  const out: ProgressionProposal[] = []
  for (const ex of performed) {
    const rule = rules.find((r) =>
      r.exercise_name
      && r.exercise_name.toLowerCase() === ex.name.toLowerCase(),
    ) ?? rules.find((r) => !r.exercise_name)
    if (!rule || !isEngineType(rule.engine_type)) continue
    out.push(proposeForExercise(rule, ex))
  }
  return out
}

export function parseLoadLb(load: string | null | undefined): number | null {
  return loadFromPrescribed(String(load ?? ''))
}
