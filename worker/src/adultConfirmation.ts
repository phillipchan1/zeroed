/**
 * "I'm 18 or older" (section 11b, tracks_v1): the athlete's own confirmation,
 * from Intake or Profile, for an athlete with no birth date on file. Until a
 * birth date or this confirmation is on file the age is unknown and the
 * under-18 rules apply (ageStatus.ts).
 *
 *   - A logged athlete write: the athlete's tap is the approval, one
 *     change_log row (confirm_adult), in one transaction.
 *   - Athlete only. No coach, app_coach included, can set it: there is no
 *     tool for it and /api/data can't write the column.
 *   - A birth date wins. With one on file there is nothing to confirm (18+)
 *     or it is refused (under 18); one recorded later overrides it.
 *   - Undo (reverts.ts) clears it: back to unknown, the under-18 rules. That
 *     only tightens, so it is always allowed.
 *
 * The column is hand-applied on Neon (worker/schema/age-status.sql). Before
 * it exists nothing here writes. The prod cut-over for an athlete already
 * known to be an adult is worker/schema/ops/confirm-adult.sql (actor system).
 */
import { ApprovalSpent, consumeApproval, directTapApproval } from './approvals.ts'
import { athleteAge, type AgeStatus } from './ageStatus.ts'
import { withTx, writeChange } from './changeLog.ts'
import { tracksV1On, type OverrideActor } from './sessionOverride.ts'
import type { ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'

export const CONFIRM_ADULT_TOOL = 'confirm_adult'

export const adultConfirmationUnavailable = 'The 18+ confirmation is not set up on this database yet. Nothing changed.'

/** True once worker/schema/age-status.sql is on this database. */
export async function adultConfirmationReady(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'athlete' AND column_name = 'adult_confirmed_at'
    ) AS ok
  `
  return row?.ok === true
}

export interface AgeView {
  age_status: AgeStatus
  /** The under-18 rules apply (minor, or unknown). */
  under_18_rules: boolean
  birth_date_on_file: boolean
  adult_confirmed_at: string | null
  /** The athlete can tap "I'm 18 or older" now: no birth date, not confirmed, and the column exists. */
  can_confirm: boolean
}

/** What Intake and Profile show. The birth date itself is not sent back. */
export async function ageView(store: ConnectedStore): Promise<AgeView> {
  const [age, ready] = await Promise.all([athleteAge(store), adultConfirmationReady(store)])
  return {
    age_status: age.status,
    under_18_rules: age.minorRules,
    birth_date_on_file: age.birthDate != null,
    adult_confirmed_at: age.adultConfirmedAt,
    can_confirm: ready && age.birthDate == null && age.adultConfirmedAt == null,
  }
}

export async function confirmAdult(
  store: ConnectedStore,
  actor: OverrideActor,
  opts: { source?: 'profile' | 'intake' } = {},
): Promise<{ ok: boolean; text: string; change_id?: string }> {
  if (actor.type !== 'athlete' || actor.id !== store.athleteId) {
    return { ok: false, text: 'Refused: only the athlete can confirm they are 18 or older. A coach never can.' }
  }
  if (!(await tracksV1On(store))) return { ok: false, text: 'Off for this athlete.' }
  if (!(await adultConfirmationReady(store))) return { ok: false, text: adultConfirmationUnavailable }
  const age = await athleteAge(store)
  if (age.birthDate) {
    return age.status === 'minor'
      ? { ok: false, text: 'Refused: your birth date is on file and shows you are under 18. The birth date wins; the under-18 rules stay.' }
      : { ok: true, text: 'Your birth date is on file and shows 18+. Nothing to confirm.' }
  }
  if (age.adultConfirmedAt) return { ok: true, text: 'Already confirmed.' }
  const changeId = crypto.randomUUID()
  try {
    return await withTx(store.sql, async () => {
      const tapDiff = { field: 'adult_confirmed_at', before: null, age_status: { before: age.status, after: 'adult' } }
      const tap = await directTapApproval(store, 'app_editor', `adult_confirmed:${store.athleteId}:${changeId}`, tapDiff)
      const [done] = await store.sql<{ at: string }[]>`
        UPDATE athlete SET adult_confirmed_at = NOW()
        WHERE id = ${store.athleteId} AND adult_confirmed_at IS NULL AND birth_date IS NULL
        RETURNING to_jsonb(adult_confirmed_at) #>> '{}' AS at
      `
      if (!done) throw new McpUserError('Your age changed since you opened this. Try again.')
      await writeChange(store, {
        id: changeId,
        actor,
        tool: 'confirm_adult',
        targetType: 'athlete',
        targetId: store.athleteId,
        diff: { ...tapDiff, after: done.at, source: opts.source ?? 'profile' },
        rationale: 'The athlete confirmed they are 18 or older (no birth date on file). Adult rules apply (section 11b).',
        ruleRefs: [],
        approvalRef: tap.ref,
        approvalId: tap.id,
      })
      if (!(await consumeApproval(store, tap.id, changeId))) throw new ApprovalSpent()
      return { ok: true, change_id: changeId, text: 'Confirmed: you are 18 or older. Adult rules apply. You can undo this in Changes.' }
    })
  } catch (e) {
    if (e instanceof McpUserError) return { ok: false, text: e.message }
    throw e
  }
}
