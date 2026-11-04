/**
 * Session prescription compute — the only place a load, call, or reason is
 * decided for display. The Worker runs this. The app renders the result.
 */
import type {
  ExerciseTemplate, InsightRow, SetLog, WeeklyDirective,
} from '../types/database.ts'
import type { UnitContext } from '../lib/units.ts'
import type { SessionOverrideView } from './sessionOverride.ts'
import {
  allowsAutoProgress, autoregulateDelta, capIsActive, clearanceTestOf,
  CLEARANCE_SESSIONS, CLEARANCE_TOP_SETS, describeClearanceTest, isLiftHeld,
  maxUpFor, pickClearanceLift, projectExerciseLoad, recommendedLoad,
  rpeContract, writtenBarWeight,
} from './prescription.ts'
import {
  canonicalLiftId, dayOfModifiers, exerciseCall, fmtLoad, localDay, modelFromSources,
  readModelLog,
  type DayOf, type LiftModelSources, type Recommendation,
} from './liftModel.ts'

export interface IntelligenceRule {
  name: string
  reasoning: string
}

export interface ClearanceView {
  lift: string
  requirement: string
  sessionsPassed: number
  sessionsNeeded: number
  minRpe: number
  exerciseIndex: number
}

export interface ExerciseRx {
  index: number
  name: string
  load: number | null
  sets: number
  reps: string
  rpe: number | null
  call: string | null
  reason: string | null
  reasons: string[]
  skip: boolean
  held: boolean
  backoff: { onTarget: number; ifHeavy: number; ifLight: number } | null
}

export interface SessionPrescription {
  directive: WeeklyDirective | null
  loadDeltaPct: number
  rpeTarget: number | null
  rationale: string | null
  hints: Record<number, string>
  held: Record<number, boolean>
  targets: Record<number, number | null>
  pushTargets?: Record<number, number | null>
  rule: IntelligenceRule | null
  phaseName?: string | null
  clearance?: ClearanceView | null
  exerciseNames?: string[]
  reasons?: Record<number, string[]>
  skip?: Record<number, boolean>
  exercises?: ExerciseRx[]
  version?: string
  /**
   * tracks_v1 only, and only when the request named a date with an active
   * week-only override. The prescription's indexes follow override.exercises.
   */
  override?: SessionOverrideView
  /**
   * tracks_v1 only: the methodology version this ran on (worker/src/methodology),
   * "v1", or "v1+<hash>" with the athlete's overrides or the under-18 rules.
   */
  methodology_version?: string
  /**
   * tracks_v1 only, and only when the date has a check-in, a pain report or a
   * blocked region (G4): the day's readiness flags (U6) and region calls (U7).
   */
  readiness?: RxReadiness
  /** With readiness: every change it made to this session, each with its rule. */
  adjustments?: RxAdjustment[]
}

export interface RxReadiness {
  date: string
  flags: Array<{ kind: string; message: string; rule_refs: string[] }>
  level: 'none' | 'trim_accessories' | 'pull_hiit_plyo'
  regions: Array<{ region: string; status: 'ok' | 'capped' | 'blocked'; score: number; cap: number; reason: string; rule_refs: string[]; refer_out: boolean }>
  blocked_regions: string[]
  /** Set when a region is blocked: see a clinician before loading it. */
  refer_out: string | null
}

export interface RxAdjustment {
  index: number
  exercise: string
  action: 'skip' | 'trim_sets' | 'reduce_load' | 'check_region'
  reason: string
  rule_refs: string[]
  before?: number | null
  after?: number | null
}

export interface SessionRxInput {
  exercises: ExerciseTemplate[]
  u: UnitContext
  phaseName: string | null
  directive: WeeklyDirective | null
  loadDeltaPct: number
  rpeTarget: number | null
  rationale: string | null
  p1: InsightRow | null
  lastWeights: Record<string, SetLog[]> | null
  lastSnapshot: ExerciseTemplate[] | null
  routineName: string | null
  routineIntent: string | null
  byName: Map<string, SetLog>
  liftSrc: LiftModelSources | null
  dayOf: DayOf | null
  today: string
}

const CALL_LABEL: Record<Recommendation['call'], string> = {
  push: 'Push', hold: 'Hold', drop: 'Drop', repeat: 'Repeat', miss: 'Missed',
  deload: 'Deload', program_pct: 'Program', establish: 'Re-establish',
  explicit: 'Program', manual: 'Manual',
}

const CALL_CHIP: Record<Recommendation['call'], string> = {
  push: 'PUSH', hold: 'HOLD', drop: 'DROP', repeat: 'REPEAT', miss: 'MISSED',
  deload: 'DELOAD', program_pct: 'PROGRAM', establish: 'RE-ESTABLISH',
  explicit: 'PROGRAM', manual: 'MANUAL',
}

function liftHint(rec: Recommendation, unit: string): string {
  if (rec.skip) return 'Skip today'
  const capped = rec.capped ? ' · capped' : ''
  return `${CALL_LABEL[rec.call]} · ${fmtLoad(rec.load)}${unit} × ${rec.reps} @${fmtLoad(rec.targetRpe)}${capped}`
}

function buildHint(
  top: SetLog | null,
  u: UnitContext,
  directive: WeeklyDirective | null,
  delta: number,
  rpe: number | null,
  target: number | null,
): string {
  const rpeStr = rpe != null ? `RPE ${rpe}` : null
  if (top && top.weight != null) {
    const last = `${u.fmt(top.weight)}${u.unit} last`
    if (delta !== 0 && target != null) {
      const pct = `${delta > 0 ? '+' : ''}${delta}%`
      return `${last} → ${target}${u.unit} (${pct})${rpeStr ? `, aim ${rpeStr}` : ''}`
    }
    if (directive) return `${last} → repeat${rpeStr ? `, ${rpeStr}` : ''}`
    return last
  }
  if (top && top.reps != null) return `${top.reps} reps last${rpeStr ? `, aim ${rpeStr}` : ''}`
  if (top && top.duration != null) return `${top.duration}s last`
  if (directive === 'DELOAD') return `Ease in${rpeStr ? `, ${rpeStr}` : ''}`
  if (directive === 'PROGRESS') return `Find a working weight${rpeStr ? `, aim ${rpeStr}` : ''}`
  return ''
}

function topWorkingSet(sets: SetLog[] | undefined): SetLog | null {
  if (!Array.isArray(sets) || sets.length === 0) return null
  const loaded = sets.filter((s) => s.weight != null)
  if (loaded.length) return loaded.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
  const logged = sets.filter((s) => s.done || s.reps != null || s.duration != null || s.distance != null)
  return logged.length ? logged[logged.length - 1] : null
}

function accessoryCall(delta: number, directive: WeeklyDirective | null): string | null {
  if (directive === 'DELOAD' || directive === 'RECOVERY') return 'DELOAD'
  if (delta > 0) return 'PUSH'
  if (delta < 0) return 'DROP'
  if (directive) return 'HOLD'
  return null
}

/**
 * The load the session UI must show. Server `targets` only — never recompute
 * from the exercise template or a training max.
 */
export function displayedSessionLoad(
  rx: Pick<SessionPrescription, 'targets'>,
  index: number,
): number | null {
  return rx.targets[index] ?? null
}

export function rxVersionHash(parts: unknown): string {
  const s = JSON.stringify(parts)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}

export function exerciseStamp(ex: ExerciseTemplate): unknown {
  return {
    name: ex.name,
    load: ex.load ?? null,
    sets: ex.sets,
    reps: ex.reps,
    target_rpe: ex.target_rpe ?? null,
  }
}

export function computeSessionPrescription(input: SessionRxInput): SessionPrescription {
  const {
    exercises, u, phaseName, directive, loadDeltaPct, rpeTarget, rationale,
    p1, lastWeights, lastSnapshot, routineName, routineIntent, byName, liftSrc,
    dayOf,
  } = input
  const today = input.today || localDay(new Date().toISOString())
  const maxUp = maxUpFor(phaseName)
  const capActive = capIsActive(p1)
  const rule: IntelligenceRule | null = capActive && p1
    ? {
        name: 'Never load over instability',
        reasoning:
          `Your ${p1.category} is still the P1 limiter (${Math.round(p1.confidence * 100)}% confident, ${p1.status}). ` +
          `Load stays capped on the work that addresses it until the pattern clears — earn the load, don't force it.`,
      }
    : null

  const sameSlot = (i: number, name: string) =>
    !lastSnapshot?.length || lastSnapshot[i]?.name === name

  const hints: Record<number, string> = {}
  const held: Record<number, boolean> = {}
  const targets: Record<number, number | null> = {}
  const pushTargets: Record<number, number | null> = {}
  const reasons: Record<number, string[]> = {}
  const skip: Record<number, boolean> = {}
  const exerciseRx: ExerciseRx[] = []
  const phaseTarget = rpeContract(phaseName).target
  const loggedSets = liftSrc ? readModelLog(liftSrc.workouts, { convert: liftSrc.convert }).sets : []

  const pushRx = (i: number, ex: ExerciseTemplate, extra: Partial<ExerciseRx>) => {
    exerciseRx[i] = {
      index: i,
      name: ex.name,
      load: targets[i] ?? null,
      sets: ex.sets,
      reps: ex.reps,
      rpe: ex.target_rpe ?? rpeTarget,
      call: extra.call ?? null,
      reason: extra.reason ?? (reasons[i]?.[0] ?? null),
      reasons: extra.reasons ?? reasons[i] ?? [],
      skip: extra.skip ?? !!skip[i],
      held: extra.held ?? !!held[i],
      backoff: extra.backoff ?? null,
    }
  }

  exercises.forEach((ex, i) => {
    const written = writtenBarWeight(ex.load, u)
    if (written != null) {
      targets[i] = written
      held[i] = isLiftHeld(ex, p1, capActive)
      hints[i] = `Program · ${written}${u.unit}`
      pushRx(i, ex, {
        load: written,
        call: 'PROGRAM',
        reason: `Programmed ${written}${u.unit}`,
        held: held[i],
      })
      return
    }
    const lift = canonicalLiftId(ex.name)
    if (lift && liftSrc) {
      const isHeld = isLiftHeld(ex, p1, capActive)
      const src = {
        ...liftSrc, phaseName, directive, dayOf,
        sessions: [{ name: routineName ?? undefined, intent: routineIntent, exercises: [ex] }],
      }
      const model = modelFromSources(lift, { ...src, noPush: isHeld ? `${p1!.category} cap holds until it clears` : null })
      const rec = model.recommendation
      if (rec) {
        held[i] = isHeld
        targets[i] = rec.skip ? null : rec.load
        skip[i] = rec.skip
        pushTargets[i] = isHeld ? modelFromSources(lift, src).recommendation?.load ?? null : null
        hints[i] = liftHint(rec, u.unit)
        const stale = model.trainingMax?.override?.stale ?? []
        reasons[i] = [
          rec.reason, ...rec.why, ...rec.conditional,
          ...(stale.length ? [`Hand-set TM may be out of date (${stale.join('; ')}) — check it in You → Training maxes`] : []),
        ]
        pushRx(i, ex, {
          load: targets[i],
          sets: rec.sets,
          reps: String(rec.reps),
          rpe: rec.targetRpe,
          call: rec.skip ? 'SKIP' : CALL_CHIP[rec.call],
          reason: rec.reason,
          reasons: reasons[i],
          skip: rec.skip,
          held: isHeld,
          backoff: rec.backoff,
        })
        return
      }
    }
    const top = (lastWeights && sameSlot(i, ex.name) ? topWorkingSet(lastWeights[String(i)]) : null)
      ?? byName.get(ex.name) ?? null
    const exTarget = ex.target_rpe ?? phaseTarget ?? rpeTarget
    const prescribed = projectExerciseLoad({
      exercise: ex,
      lastWeight: top?.weight ?? null,
      lastRpe: top?.rpe,
      lastReps: top?.reps,
      weeklyDelta: loadDeltaPct,
      directive,
      sessionIntent: routineIntent,
      sessionName: routineName,
      u,
    })
    const canProgress = allowsAutoProgress({
      exercise: ex, sessionIntent: routineIntent, sessionName: routineName, directive,
    })
    const call = top?.rpe != null && directive !== 'DELOAD' && directive !== 'RECOVERY'
      ? exerciseCall(loggedSets, ex.name, today, exTarget ?? 8)
      : null
    const exDelta = prescribed.source === 'explicit' || !canProgress
      ? 0
      : call
        ? call.deltaPct
        : autoregulateDelta(top?.rpe, exTarget, loadDeltaPct, directive, maxUp)
    if (call && canProgress && prescribed.source !== 'explicit') reasons[i] = [call.why]
    let uncapped = prescribed.source === 'explicit'
      ? prescribed.weight
      : canProgress
        ? recommendedLoad(top, exDelta, u)
        : prescribed.weight
    for (const m of dayOfModifiers(ex.name, dayOf)) {
      reasons[i] = [...(reasons[i] ?? []), m.note]
      if (m.skip) { skip[i] = true; uncapped = null; continue }
      if (uncapped != null) uncapped = u.prescribe(u.store(uncapped) * m.factor)
    }

    const isHeld = isLiftHeld(ex, p1, capActive)
    held[i] = isHeld
    pushTargets[i] = isHeld ? uncapped : null

    if (skip[i]) {
      targets[i] = null
      hints[i] = 'Skip today'
    } else if (isHeld && (exDelta > 0 || directive === 'PROGRESS')) {
      targets[i] = top?.weight != null ? u.show(top.weight) : null
      hints[i] = top && top.weight != null
        ? `Hold ${u.fmt(top.weight)}${u.unit} — cap stays until ${p1!.category} clears`
        : `Hold steady — ${p1!.category} not cleared yet`
    } else {
      targets[i] = uncapped
      hints[i] = buildHint(top, u, directive, exDelta, exTarget, targets[i])
    }
    const chip = skip[i] ? 'SKIP' : isHeld ? 'HOLD' : (call ? CALL_CHIP[call.call] : accessoryCall(exDelta, directive))
    pushRx(i, ex, {
      call: chip,
      reason: reasons[i]?.[0] ?? (hints[i] || null),
      reasons: reasons[i] ?? [],
      skip: !!skip[i],
      held: isHeld,
    })
  })

  let clearance: ClearanceView | null = null
  if (capActive && p1) {
    const open = clearanceTestOf(p1)
    const lift = open?.lift ?? pickClearanceLift(exercises, p1.category, (n) => byName.has(n))
    if (lift) {
      const test = open ?? {
        kind: 'clearance_test' as const,
        lift,
        criterion: { top_sets: CLEARANCE_TOP_SETS, min_rpe: phaseTarget, sessions: CLEARANCE_SESSIONS, pain_free: true as const },
        opened_at: '', sessions_passed: 0, status: 'open' as const,
      }
      clearance = {
        lift,
        requirement: describeClearanceTest(test),
        sessionsPassed: test.sessions_passed,
        sessionsNeeded: test.criterion.sessions,
        minRpe: test.criterion.min_rpe,
        exerciseIndex: exercises.findIndex((ex) => ex.name === lift),
      }
    }
  }

  return {
    directive, loadDeltaPct, rpeTarget, rationale, hints, held, targets, pushTargets, rule, clearance, phaseName,
    exerciseNames: exercises.map((ex) => ex.name),
    reasons, skip,
    exercises: exerciseRx,
  }
}
