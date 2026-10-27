// Run: node --experimental-strip-types src/engine/outsidePlan.check.ts
import {
  activityChoices, buildOutsidePlanSession, nextOneOff, oneOffMessage, cleanActivity, cleanMinutes, cleanSessionRpe,
  isOffPlan, isOutsidePlan, rememberActivity, sessionRpeWord, SESSION_RPE_VALUES, SUGGESTED_ACTIVITIES,
} from './outsidePlan.ts'
import { workoutRpeError } from './rpeScale.ts'
import type { ProgramEdit } from './agentClient.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

// ---- session RPE: Foster's CR-10, whole numbers 0–10 -----------------------
ok(SESSION_RPE_VALUES.length === 11 && SESSION_RPE_VALUES[0] === 0 && SESSION_RPE_VALUES[10] === 10, 'CR-10 runs 0..10')
ok(SESSION_RPE_VALUES.every((v) => sessionRpeWord(v).length > 0), 'every value has words')
ok(sessionRpeWord(0) === 'Rest' && sessionRpeWord(5) === 'Hard' && sessionRpeWord(10) === 'Maximal', 'anchors read as the scale')
ok(cleanSessionRpe(0) === 0, 'session RPE 0 is a real answer (rest), not missing')
ok(cleanSessionRpe(7) === 7 && cleanSessionRpe('7') === 7, 'whole numbers, number or string')
ok(cleanSessionRpe(7.5) === null, 'no half steps on CR-10')
ok(cleanSessionRpe(11) === null && cleanSessionRpe(-1) === null, 'outside 0–10 is null')
ok(cleanSessionRpe(null) === null && cleanSessionRpe('') === null && cleanSessionRpe('x') === null, 'nothing is null')

// ---- minutes ----------------------------------------------------------------
ok(cleanMinutes(90) === 90 && cleanMinutes('45') === 45, 'minutes, number or string')
ok(cleanMinutes(44.6) === 45, 'rounded to whole minutes')
ok(cleanMinutes(0) === null && cleanMinutes(601) === null && cleanMinutes(NaN) === null, 'outside 1–600 is null')

// ---- activity ---------------------------------------------------------------
ok(cleanActivity('  bjj   no-gi ') === 'Bjj no-gi', 'one line, trimmed, first letter up')
ok(cleanActivity('BJJ') === 'BJJ', 'capitals the athlete typed stay')
ok(cleanActivity('   ') === null && cleanActivity(null) === null, 'blank is null')
ok((cleanActivity('x'.repeat(80)) ?? '').length === 40, 'capped at 40')

const mem = rememberActivity(rememberActivity(rememberActivity([], 'BJJ'), 'Run'), 'bjj')
ok(mem.length === 2 && mem[0] === 'Bjj' && mem[1] === 'Run', 'remembered newest first, deduped ignoring case')
ok(rememberActivity(['a', 'b', 'c', 'd', 'e', 'f'], 'g').length === 6, 'remembers six')
const choices = activityChoices(['Bjj'])
ok(choices[0] === 'Bjj' && !choices.slice(1).some((c) => c.toLowerCase() === 'bjj'), 'own activities first; a suggestion they already use is not repeated')
ok(activityChoices([]).length === Math.min(6, SUGGESTED_ACTIVITIES.length), 'no history → the suggestions')

// ---- the queued session -----------------------------------------------------
const p = buildOutsidePlanSession({
  id: 'q1', athleteId: 'a1', athleteName: 'Phil', activity: ' bjj ', minutes: 90, sessionRpe: 7,
  exposure: { contact: true, impact: false }, performedAt: '2026-10-27T19:00:00.000Z', queuedAt: '2026-10-27T21:00:00.000Z',
})
ok(p.routineId === '', 'no routine until commit files it, so no planned slot can match it')
ok(isOutsidePlan(p) && !isOutsidePlan({}), 'marked outside the plan')
ok(isOffPlan(p) && isOffPlan({ source: 'external' }), 'a log and a coach-planned one-off are both off the plan')
ok(!isOffPlan({}) && !isOffPlan({ source: null }) && !isOffPlan({ source: 'plan' }), 'a planned session is not')
ok(p.outsidePlan?.activity === 'Bjj' && p.outsidePlan?.minutes === 90, 'carries what was said')
ok(p.sessionRpe === 7 && p.rpe === null, 'session RPE is its own field; the set-RPE mean stays empty')
ok(p.durationMins === 90, 'duration is the minutes, so load = 7 × 90')
ok(p.exercisesSnapshot?.length === 1 && p.exercisesSnapshot[0].tracking_type === 'time', 'one timed row')
ok(p.actualWeights[0]?.[0]?.duration === 5400 && p.actualWeights[0][0].done, 'the row holds the minutes as a done timed set')
ok(JSON.stringify(p.exercisesSnapshot?.[0].exposure) === '{"contact":true}', 'only the tags that are on')
ok(p.debrief === null && p.onboardingTransition === null && p.editWorkoutId === null, 'no debrief, no onboarding step, not an edit')
ok(workoutRpeError({ rpe: p.rpe, actual_weights: p.actualWeights }) === null, 'passes the workout RPE validator')
ok(JSON.parse(JSON.stringify(p)).outsidePlan.minutes === 90, 'survives the outbox round trip')

let threw = false
try {
  buildOutsidePlanSession({ id: 'q2', athleteId: 'a1', athleteName: null, activity: '', minutes: 30, sessionRpe: 5, exposure: {}, performedAt: '', queuedAt: '' })
} catch { threw = true }
ok(threw, 'refuses a log with no activity')

// ---- a one-off the coach plans -----------------------------------------------
const msg = oneOffMessage('  Easy run   with my wife,\n about 40 min ')
ok(msg.endsWith('What they want: Easy run with my wife, about 40 min'), 'the athlete\'s words close the message, on one line')
ok(/OUTSIDE THE PROGRAM/.test(msg) && /exactly one add_session/.test(msg), 'framed as one session, not a week edit')
ok(/never write kg or lb/.test(msg), 'the model is told not to write loads')
ok(oneOffMessage('x'.repeat(2000)).length < 2000, 'a pasted essay is capped')

const edit = (over: Partial<ProgramEdit>): ProgramEdit => ({
  type: 'add_session', rationale: '', session_name: null, exercise_name: null, after_exercise: null,
  set_name: null, set_intent: null, set_session_type: null, set_intended_dow: null, sets: null, reps: null,
  load: null, cue: null, target_rpe: null, sessions_per_week: null, note: null, exercises: [], ...over,
})
const run = nextOneOff(null, [
  edit({ type: 'add_note', note: 'enjoy it' }),
  edit({
    session_name: 'Easy run together', set_intent: 'Conversational pace', set_session_type: 'conditioning',
    exercises: [{ name: 'Easy run', sets: 1, reps: '40 min', load: 'bodyweight', cue: 'You can talk the whole way', target_rpe: 3 }],
  }),
  edit({ session_name: 'A second one', exercises: [{ name: 'Push-up', sets: 3, reps: '10', load: 'bodyweight', cue: '', target_rpe: null }] }),
])
ok(run?.name === 'Easy run together', 'takes the add_session, ignoring a note')
ok(run?.exercises.length === 1 && run.exercises[0].reps === '40 min', 'keeps the easy run as one movement')
ok(run?.sessionType === 'conditioning' && run.intent === 'Conversational pace', 'type and intent come through')
ok(run?.routineId === null, 'not a routine of the program')
const capped = nextOneOff(null, [edit({ session_name: 'Too much', exercises: [{ name: 'Squat', sets: 40, reps: '5', load: 'heavy', cue: '', target_rpe: 8 }] })])
ok((capped?.exercises[0].sets ?? 99) <= 10, 'the editor\'s set ceiling applies to a one-off too')
ok(nextOneOff(null, []) === null, 'a reply with no session (a question) is null')
ok(nextOneOff(null, [edit({ session_name: 'Empty' })]) === null, 'a session with no exercises is null')
ok(/handed holds only that one-off/.test(oneOffMessage('shorter', true)) && !/exactly one add_session/.test(oneOffMessage('shorter', true)), 'revising asks for edits to that session')
const shorter = nextOneOff(run, [edit({ type: 'update_exercise', session_name: 'Easy run together', exercise_name: 'Easy run', reps: '25 min' })])
ok(shorter?.exercises[0].reps === '25 min' && shorter.name === 'Easy run together', 'a surgical edit changes the session on the table')
ok(nextOneOff(run, [])?.name === 'Easy run together', 'a reply with no edits keeps the session on the table')
ok(nextOneOff(run, [edit({ type: 'set_sessions_per_week', sessions_per_week: 6 })])?.exercises.length === 1, 'week-level edits are ignored')
const swapped = nextOneOff(run, [edit({ session_name: 'Hotel dumbbells', exercises: [{ name: 'Goblet Squat', sets: 3, reps: '10', load: 'moderate', cue: '', target_rpe: 7 }] })])
ok(swapped?.name === 'Hotel dumbbells', 'a fresh add_session replaces the one on the table')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('outsidePlan: ok')
