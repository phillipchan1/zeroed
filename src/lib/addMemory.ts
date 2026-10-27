// Per-device memory for adding to a session — the two things worth not
// re-asking:
//
//   · the last interval block built by hand (work, rest, rounds, sets and the
//     movement), so the second finisher of the week is one tap: open, Start;
//   · the movements added before, most recent first, so the accessory you tack
//     onto every upper day is at the top of the list.
//
// Conveniences only, like swapMemory. localStorage, every access guarded: a
// private window or a cleared site just means the sheet opens on its defaults.
// Nothing here is a record — the addition itself lives in the session's
// exercises_snapshot.

const INTERVALS_KEY = 'zeroed:intervals-last'
const RECENT_KEY = 'zeroed:added-recent'
const RECENT_MAX = 6

export interface LastIntervals {
  name: string
  work: number
  rest: number
  rounds: number
  sets: number
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function loadLastIntervals(): LastIntervals | null {
  try {
    const raw = localStorage.getItem(INTERVALS_KEY)
    const v = raw ? JSON.parse(raw) : null
    if (!v || typeof v.name !== 'string' || !num(v.work) || !num(v.rest) || !num(v.rounds) || !num(v.sets)) return null
    return { name: v.name, work: v.work, rest: v.rest, rounds: v.rounds, sets: v.sets }
  } catch {
    return null
  }
}

export function saveLastIntervals(v: LastIntervals): void {
  try { localStorage.setItem(INTERVALS_KEY, JSON.stringify(v)) } catch { /* non-fatal */ }
}

export function recentAdditions(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rememberAddition(name: string): void {
  try {
    const next = [name, ...recentAdditions().filter((n) => n !== name)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* non-fatal */ }
}
