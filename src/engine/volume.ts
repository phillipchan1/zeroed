// =============================================================================
// VOLUME — how much work, not just how many sets.
//
// Everything in this app counted SETS. A set is a unit of effort only if every
// set is the same size, and they never are: three sets of 5 at 315 and three
// sets of 12 at 95 both read as "3 sets", and the week that halved its load
// while adding a set read as a bigger week. Volume (load × reps, summed) is the
// number that actually moves with the training, and it is the one metric this
// app's own autoregulation implicitly reasons about while never showing it.
//
// Conventions, chosen to be honest rather than flattering:
//   · Only LOADED reps count. Bodyweight work contributes its ADDED load only
//     (a weighted pull-up counts the belt, not the athlete) — we do not know
//     what the athlete weighs, and inventing a number to inflate a headline
//     stat is the kind of thing this app exists not to do.
//   · Time and distance work contributes nothing. It is real training and it is
//     not tonnage; `loadedSets` says how much of the session the number covers,
//     so a session of carries reads as "no loaded work" rather than "zero".
//   · Volume is in the STORAGE unit, like every other stored weight. Convert at
//     the display boundary (UnitContext.volume).
//
// Pure, no I/O (see volume.check.ts).
// =============================================================================

import type { SetLog } from '../types/database'

export interface VolumeTally {
  /** Σ weight × reps, in the storage unit. */
  load: number
  /** Sets that contributed load — the denominator for "is this number meaningful". */
  loadedSets: number
  /** Sets carrying any signal at all, loaded or not. */
  loggedSets: number
  /** Total reps performed across loaded and unloaded rep work. */
  reps: number
}

export const NO_VOLUME: VolumeTally = { load: 0, loadedSets: 0, loggedSets: 0, reps: 0 }

/**
 * Whether a set carries real signal. The single shared definition — the app
 * previously had this predicate written out three times with two different
 * meanings, so a session's set count changed depending on which screen read it
 * (the logger counted only tapped checkboxes; every read-back counted any set
 * with numbers in it).
 */
export function isSetLogged(s: SetLog): boolean {
  return s.done || s.reps != null || s.duration != null || s.distance != null
}

/** One set's contribution. Negative or absent numbers contribute nothing. */
export function setLoad(s: SetLog): number {
  if (s.weight == null || s.reps == null) return 0
  if (s.weight <= 0 || s.reps <= 0) return 0
  return s.weight * s.reps
}

/** Tally a flat list of sets. */
export function tallySets(sets: Iterable<SetLog>): VolumeTally {
  let load = 0, loadedSets = 0, loggedSets = 0, reps = 0
  for (const s of sets) {
    if (!isSetLogged(s)) continue
    loggedSets++
    if (s.reps != null && s.reps > 0) reps += s.reps
    const l = setLoad(s)
    if (l > 0) { load += l; loadedSets++ }
  }
  return { load: Math.round(load), loadedSets, loggedSets, reps }
}

/** Tally a whole session's exercise-indexed grid. */
export function tallySession(
  setLogs: Record<string | number, SetLog[]> | null | undefined,
): VolumeTally {
  if (!setLogs) return NO_VOLUME
  return tallySets(Object.values(setLogs).flat().filter(Boolean))
}

/** Add two tallies — for rolling a week or a block up out of its sessions. */
export function addVolume(a: VolumeTally, b: VolumeTally): VolumeTally {
  return {
    load: a.load + b.load,
    loadedSets: a.loadedSets + b.loadedSets,
    loggedSets: a.loggedSets + b.loggedSets,
    reps: a.reps + b.reps,
  }
}

export function sumVolume(tallies: Iterable<VolumeTally>): VolumeTally {
  let out = NO_VOLUME
  for (const t of tallies) out = addVolume(out, t)
  return out
}
