// Round 2 PR 5: what the athlete's app reads for validator warnings (G5) and
// the weekly review (G8), against a real schema. Flag off: a parked proposal's
// diff, the override and change-log routes and the weekly-review route are
// exactly as before (no warnings key; 404s). Flag on: a coach's proposal keeps
// its U8–U10 warnings in the diff the athlete lists; a refused override
// preview (U13, red flag) hands the athlete the structured refusal, region
// and all, while the coach's text stays generic without health access; a
// refused Undo carries its red-flag warning; the weekly review renders for a
// week with data and for an empty one. Athletes A and B never see each
// other's proposals, warnings or review.
// Synthetic athletes A and B from isolation-seed.sql; synthetic numbers only.
// Uses throwaway Postgres when ZEROED_TEST_DATABASE_URL is set, else PGlite.
// Run: node --experimental-strip-types worker/src/warningsReview.check.ts

import { openIsolationHarness } from './isolationDb.ts'
import { createApproval } from './approvals.ts'
import { athleteChangeLogAction } from './changeLogRoute.ts'
import { HEALTH_HELD_TEXT } from './methodology/validators.ts'
import { listProposals } from './proposals.ts'
import { athleteReadinessAction, saveCheckin, setCoachHealth } from './readiness.ts'
import { addDays } from './readiness/rules.ts'
import { athleteOverrideAction, athleteToday, type OverrideActor } from './sessionOverride.ts'
import { executeZeroedTool } from './tools.ts'
import { makeStore } from './store.ts'
import { proposalWarnings, readWarnings, warningsView } from '../../src/lib/previewWarnings.ts'
import { complianceLine, isEmptyWeek, whyLine, type WeeklyReview } from '../../src/lib/weeklyReview.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const A_DAY = '77777777-7777-7777-7777-777777777777'
const TOKEN_A_ID = 'aaaa6666-0000-4000-8000-000000000001'
const TOKEN_B_ID = 'bbbb6666-0000-4000-8000-000000000001'

const harness = await openIsolationHarness()
const sql = harness.sql
const storeA = makeStore(sql, A)
const storeB = makeStore(sql, B)
const coachA: OverrideActor = { type: 'mcp', id: TOKEN_A_ID }
const coachB: OverrideActor = { type: 'mcp', id: TOKEN_B_ID }
const athleteA: OverrideActor = { type: 'athlete', id: A }

const call = async (name: string, args: Record<string, unknown>, actor: OverrideActor = coachA, athlete = A): Promise<string> => {
  try {
    return await executeZeroedTool(sql, athlete, name, args, {}, actor)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const flag = async (athleteId: string, on: boolean) => {
  if (on) await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) || '{"tracks_v1": true}'::jsonb WHERE id = ${athleteId}`
  else await sql`UPDATE athlete SET flags = COALESCE(flags, '{}'::jsonb) - 'tracks_v1' WHERE id = ${athleteId}`
}
const kept = (text: string) => /"preview_id": "(chp_[0-9a-f]+)"/.exec(text)?.[1] ?? /preview_id: (chp_[0-9a-f]+)/.exec(text)?.[1] ?? ''
const latestDiff = async (athleteId = A) => (await harness.query<{ diff: Record<string, unknown> }>(
  `SELECT diff FROM coach_proposal WHERE athlete_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [athleteId],
))[0]?.diff ?? {}
const plyoAfterSquat = [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Box Jump', sets: 3, reps: '3', load: 'bodyweight' }]
const plank = [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Plank', sets: 3, reps: '30s', load: 'bodyweight' }]

// ---- pure: the app's reading of the Worker's list ---------------------------------------------
const raw = [
  { rule: 'U8', message: 'Box Jump comes after Back Squat.', target: 'A day · Box Jump' },
  { rule: 'U99', message: 'not a rule', target: 'x' },
  { rule: 'U13', message: 'Too big.', target: 'week', blocking: true },
  { rule: 'U10', message: '' },
  'junk',
]
const read = readWarnings(raw)
ok(read.length === 2 && read[0].rule === 'U13' && read[1].rule === 'U8', 'read: unknown rules and empty rows dropped, refusals first')
ok(warningsView(raw, false).refusal == null && warningsView(raw, false).notes.length === 0, 'read: flag off → nothing to render')
ok(warningsView(raw, true).refusal?.rule === 'U13' && warningsView(raw, true).notes.length === 1, 'read: flag on → the refusal and one note')

// ---- flag OFF: exactly as before -----------------------------------------------------------------
const offPark = await call('preview_program_edits', { propose: true, title: 'Box jumps for pop.', edits: plyoAfterSquat })
ok(offPark.includes('Parked') && !offPark.includes('## Warnings'), 'flag off: parks as before, no warnings section')
const offDiff = await latestDiff()
ok(!('warnings' in offDiff), 'flag off: the parked diff has no warnings key')
ok(proposalWarnings(offDiff, true).notes.length === 0, 'flag off: the card has nothing to render')
ok((await athleteOverrideAction(storeA, { action: 'preview', date: '2026-01-05', session: A_DAY, ops: [] }))[1] === 404, 'flag off: the override route reads as absent')
ok((await athleteReadinessAction(storeA, { action: 'weekly_review' }))[1] === 404, 'flag off: the weekly-review route reads as absent')
ok((await athleteChangeLogAction(storeA, { action: 'list' }))[1] === 404, 'flag off: the change-log route reads as absent')
await sql`DELETE FROM coach_proposal WHERE athlete_id = ${A}`

// ---- flag ON: warnings on a parked proposal ------------------------------------------------------
await flag(A, true)
const today = await athleteToday(storeA)
const parked = await call('preview_program_edits', { propose: true, title: 'Box jumps for pop.', edits: plyoAfterSquat })
ok(parked.includes('Parked') && parked.includes('"rule": "U8"'), 'flag on: the coach sees the U8 warning and the proposal parks')
const listed = (await listProposals(storeA)) ?? []
const prop = listed[0]
const view = proposalWarnings(prop?.diff, true)
ok(listed.length === 1 && view.refusal == null && view.notes.some((w) => w.rule === 'U8' && w.target.includes('Box Jump') && w.message.length > 0), 'flag on: the athlete\'s list carries U8 with its target and message')
ok(proposalWarnings(prop?.diff, false).notes.length === 0, 'flag on, client flag off: nothing renders')
ok(Array.isArray((prop?.diff as { sessions?: unknown[] })?.sessions), 'flag on: the diff the card already renders is intact')
await call('preview_program_edits', { propose: true, title: 'Core.', edits: plank })
ok(!('warnings' in (await latestDiff())), 'flag on: a clean proposal has no warnings key')

// Week-only override proposal.
const ovPark = await call('preview_session_override', {
  date: today, session: A_DAY, ops: [{ op: 'add', exercise: { name: 'Box Jump', sets: 3, reps: '3' } }], propose: true, title: 'Jumps today.',
})
ok(ovPark.includes('Parked'), 'override: parks')
const ovProp = ((await listProposals(storeA)) ?? []).find((p) => p.kind === 'session_override')
ok(proposalWarnings(ovProp?.diff, true).notes.some((w) => w.rule === 'U8'), 'override: the parked diff carries U8 for the card')

// ---- refusals, structured for the athlete ------------------------------------------------------------
const [big] = await athleteOverrideAction(storeA, { action: 'preview', date: today, session: A_DAY, ops: [
  { op: 'add', exercise: { name: 'Romanian Deadlift', sets: 3, reps: '8' } },
  { op: 'add', exercise: { name: 'Walking Lunge', sets: 3, reps: '10' } },
] })
const bigOut = big as { ok: boolean; text: string; warnings?: unknown }
const bigView = warningsView(bigOut.warnings, true)
ok(!bigOut.ok && bigOut.text.startsWith('Refused (U13)') && bigView.refusal?.rule === 'U13' && bigView.refusal.target === 'week', 'U13: the app refusal carries the structured U13 warning')

// An edit made before the block, for the refused Undo below: rows in, then out.
const addRow = [{ type: 'add_exercise', session_name: 'A day', exercise_name: 'Dumbbell Row', sets: 3, reps: '10', load: 'moderate' }]
const dropRow = [{ type: 'remove_exercise', session_name: 'A day', exercise_name: 'Dumbbell Row' }]
for (const edits of [addRow, dropRow]) {
  const p = await call('preview_program_edits', { edits })
  const tap = await createApproval(storeA, athleteA, { preview_id: kept(p) })
  await call('apply_program_edits', { edits, confirm: true, preview_id: kept(p), approval_ref: tap.ok ? tap.approval_ref : '' })
}
// v1.2: a red flag makes the block persistent (6/10 alone lapses after the next session).
const elbow = await saveCheckin(storeA, athleteA, { pain: [{ region: 'elbow', score: 6, red_flags: ['swelling'] }] })
ok(elbow.ok, 'red flag: elbow 6/10 with swelling blocks the elbow')
const rowOps = [{ op: 'add', exercise: { name: 'Dumbbell Row', sets: 3, reps: '10' } }]
const [red] = await athleteOverrideAction(storeA, { action: 'preview', date: today, session: A_DAY, ops: rowOps })
const redOut = red as { ok: boolean; text: string; warnings?: unknown }
const redView = warningsView(redOut.warnings, true)
ok(!redOut.ok && redView.refusal?.rule === 'U7' && redView.refusal.blocking === true, 'U7: the app refusal is a structured red flag')
ok(redView.refusal?.message.includes('elbow') === true && redView.refusal.target.includes('Dumbbell Row'), 'U7: the athlete sees the region and the exercise')
// Nothing new for coaches: without health access the refusal stays generic.
await setCoachHealth(storeA, athleteA, TOKEN_A_ID, false)
const coachRed = await call('preview_session_override', { date: today, session: A_DAY, ops: rowOps })
ok(coachRed.startsWith('Refused (U7)') && coachRed.includes(HEALTH_HELD_TEXT) && !coachRed.includes('elbow') && !coachRed.includes('Dumbbell Row'), 'privacy: a coach without health access gets the generic refusal')
const coachRedPark = await call('preview_session_override', { date: today, session: A_DAY, ops: rowOps, propose: true, title: 'Rows.' })
ok(coachRedPark.startsWith('Refused (U7)'), 'privacy: a red-flag change is never parked, so no card carries it')
await setCoachHealth(storeA, athleteA, TOKEN_A_ID, true)

// A refused Undo carries its red-flag warning.
const [dropLog] = await harness.query<{ id: string }>(`SELECT id::text AS id FROM change_log WHERE athlete_id = $1 AND tool = 'apply_program_edits' ORDER BY created_at DESC, id DESC LIMIT 1`, [A])
const [undo] = await athleteChangeLogAction(storeA, { action: 'preview_revert', id: dropLog?.id ?? '' })
const undoOut = undo as { ok: boolean; reason?: string; text: string; warnings?: unknown }
const undoView = warningsView(undoOut.warnings, true)
ok(!undoOut.ok && undoOut.reason === 'not_revertible' && undoView.refusal?.rule === 'U7' && undoView.refusal.message.includes('elbow'),
  `undo: putting rows back on a blocked elbow is refused, structured (${undoOut.text.slice(0, 60)})`)

// ---- weekly review --------------------------------------------------------------------------------------
type Review = WeeklyReview
const [emptyOut, emptyStatus] = await athleteReadinessAction(storeA, { action: 'weekly_review', week: addDays(today, -70) })
const empty = emptyOut as Review
ok(emptyStatus === 200 && isEmptyWeek(empty), 'review: a week with nothing logged reads as empty')
ok(['progress', 'hold', 'deload'].includes(empty.call) && whyLine(empty).length > 0 && complianceLine(empty.compliance).target === 'target 80%', 'review: the empty week still has its call, why and target')
const [thisOut] = await athleteReadinessAction(storeA, { action: 'weekly_review' })
const thisWeek = thisOut as Review
ok(!isEmptyWeek(thisWeek) && thisWeek.pain?.blocked.includes('elbow') === true, 'review: this week shows the athlete\'s own pain and block')
ok(thisWeek.methodology_version.startsWith('v1'), 'review: names the methodology version')
const [badOut, badStatus] = await athleteReadinessAction(storeA, { action: 'weekly_review', week: 'not-a-date' })
ok(badStatus === 400 && typeof (badOut as { error?: string }).error === 'string', 'review: a bad week is a 400 the card shows as an error')

// ---- isolation ------------------------------------------------------------------------------------------
ok(((await listProposals(storeB)) ?? []).every((p) => !JSON.stringify(p.diff).includes('Box Jump')), 'isolation: B lists none of A\'s proposals or warnings')
ok((await athleteReadinessAction(storeB, { action: 'weekly_review' }))[1] === 404, 'isolation: B\'s flag is off, so B\'s review is absent')
await flag(B, true)
const bReview = (await athleteReadinessAction(storeB, { action: 'weekly_review' }))[0] as Review
ok(!JSON.stringify(bReview).includes('elbow'), 'isolation: B\'s review knows nothing of A\'s elbow')
const [bUndo] = await athleteChangeLogAction(storeB, { action: 'preview_revert', id: dropLog?.id ?? '' })
ok(!(bUndo as { ok: boolean }).ok && !JSON.stringify(bUndo).includes('elbow'), 'isolation: B can\'t preview an Undo of A\'s change')
const bCoach = await call('preview_session_override', { date: today, session: A_DAY, ops: rowOps }, coachB, B)
ok(!bCoach.includes('elbow') && !bCoach.includes('Dumbbell Row'), 'isolation: B\'s coach can\'t reach A\'s session')

await harness.close()

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
