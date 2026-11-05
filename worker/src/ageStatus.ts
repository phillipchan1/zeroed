/**
 * Age status (spec section 8, D6, section 11b; tracks_v1): the one place the
 * Worker decides whether the under-18 rules apply. Every age decision
 * (methodology resolve, readiness, session-rx, validators, composer, app
 * coach, weekly review, MCP reads, reverts) goes through here;
 * ageStatus.check.ts fails if a direct birth-date age check appears anywhere
 * else.
 *
 *   adult    the birth date says 18+, or there is no birth date and the
 *            athlete tapped "I'm 18 or older" (athlete.adult_confirmed_at)
 *   minor    the birth date says under 18. The birth date wins over a
 *            confirmation, whichever came first.
 *   unknown  neither. Section 11b: we don't assume adult, so unknown gets
 *            every under-18 rule (consent, RPE ≤ 8, contacts ≤ 60, no max
 *            tests, no raised pain cap, v1.1 behaviour for the two rules v1.2
 *            loosens, a guardian confirmation to clear a red flag).
 *
 * With tracks_v1 off, exactly as before: the confirmation is not read and an
 * unknown age gets the adult rules (`minorRules` false). Before
 * worker/schema/age-status.sql the confirmation reads as not given.
 */
import { mcpStamp } from '../../src/engine/mcpStamp.ts'
import { CURRENT_METHODOLOGY } from './methodology/v1.ts'
import { calendarZone, type ConnectedStore } from './store.ts'

export type AgeStatus = 'adult' | 'minor' | 'unknown'

export interface AthleteAge {
  status: AgeStatus
  /** The under-18 rules apply: minor or unknown with tracks_v1 on; a minor only with it off (as before). */
  minorRules: boolean
  /** Whole years from the birth date, or null with none on file. */
  years: number | null
  birthDate: string | null
  adultConfirmedAt: string | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

/** Whole years from YYYY-MM-DD to `today`. */
export function ageOn(birthDate: string, today: string): number {
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0)
}

/** The rule, pure: the birth date wins; a confirmation counts only without one. */
export function ageStatusFrom(input: {
  birthDate: string | null
  adultConfirmed: boolean
  today: string
  ageUnder?: number
}): AgeStatus {
  const under = input.ageUnder ?? CURRENT_METHODOLOGY.minors.age_under
  if (input.birthDate && DATE_RE.test(input.birthDate)) return ageOn(input.birthDate, input.today) < under ? 'minor' : 'adult'
  return input.adultConfirmed ? 'adult' : 'unknown'
}

/** Whether the under-18 rules apply to a status (tracks_v1). Unknown is treated as under 18. */
export function minorRulesFor(status: AgeStatus): boolean {
  return status !== 'adult'
}

/**
 * The tri-state the override guards take (methodology/resolve.ts
 * checkOverride): true under 18, false adult, null unknown. Null is refused
 * everything a minor is refused, and the refusal says the age isn't on file.
 */
export function overrideAgeOf(status: AgeStatus): boolean | null {
  return status === 'adult' ? false : status === 'minor' ? true : null
}

/** This athlete's age status, read once. */
export async function athleteAge(store: ConnectedStore, now: Date = new Date()): Promise<AthleteAge> {
  const [row] = await store.sql<{ birth_date: string | null; adult_confirmed_at: string | null; time_zone: string | null; on: boolean | null }[]>`
    SELECT to_jsonb(a) ->> 'birth_date' AS birth_date, to_jsonb(a) ->> 'adult_confirmed_at' AS adult_confirmed_at,
           a.time_zone, (a.flags->'tracks_v1') = 'true'::jsonb AS on
    FROM athlete a WHERE a.id = ${store.athleteId}
  `
  const birthDate = row?.birth_date && DATE_RE.test(row.birth_date) ? row.birth_date.slice(0, 10) : null
  const flagOn = row?.on === true
  const adultConfirmedAt = flagOn ? row?.adult_confirmed_at ?? null : null
  const today = mcpStamp(now, calendarZone(row?.time_zone ?? null)).local_date
  const status = ageStatusFrom({ birthDate, adultConfirmed: adultConfirmedAt != null, today })
  return {
    status,
    minorRules: flagOn ? minorRulesFor(status) : status === 'minor',
    years: birthDate ? ageOn(birthDate, today) : null,
    birthDate,
    adultConfirmedAt,
  }
}
