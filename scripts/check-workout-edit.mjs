/* Integrity check for "Review / edit" on a session that's already been saved —
 * the path that opened blank. Dev-only, not shipped. Same convention as the
 * engine's *.check.ts files: no test runner, run it directly.
 *
 *   npm i -D playwright            # same dep preview-loop.mjs needs, unshipped
 *   npx vite --port 5199 --host 127.0.0.1 &
 *   node scripts/check-workout-edit.mjs
 *
 * It seeds the caches the app itself writes when a session commits, then blocks
 * every Supabase call — the condition the bug lives on, since the workout row is
 * a good few seconds behind the tap even on a working connection. What the
 * device already holds has to be enough to open the session on its numbers. */
import { chromium } from 'playwright'

const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:5199'
const USER_ID = '11111111-1111-1111-1111-111111111111'
const ATHLETE_ID = '22222222-2222-2222-2222-222222222222'
const R1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const W1 = 'wwwwwwww-0000-0000-0000-000000000001'
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString()

const ex = (name, sets, reps, load, extra = {}) => ({
  name, sets, reps, load, cue: null, insight_id: null,
  reading: false, reading_why: null, tracking_type: extra.tracking_type ?? null,
})
const ROUTINE = {
  id: R1, program_id: 'prog-1', phase_id: 'phase-1', name: 'Lower A — Squat pattern',
  session_type: 'strength', intent: 'x', intended_dow: null, created_at: iso(20),
  exercises: [
    ex('Back Squat', 3, '5', '225 lbs'),
    ex('Romanian Deadlift', 3, '8', '185 lbs'),
  ],
}

// What the athlete logged. Exactly the shape commitSession writes to
// workout.actual_weights, and actualsFromPending/gatherSessionActuals return.
const SET_LOGS = {
  0: [
    { set: 1, weight: 225, reps: 5, rpe: 8, done: true },
    { set: 2, weight: 225, reps: 5, rpe: 8, done: true },
    { set: 3, weight: 225, reps: 4, rpe: 9, done: true },
  ],
  1: [
    { set: 1, weight: 185, reps: 8, rpe: 7, done: true },
    { set: 2, weight: 185, reps: 8, rpe: 7, done: true },
    { set: 3, weight: 185, reps: 8, rpe: 8, done: true },
  ],
}

const APP_STATE = {
  athlete: {
    id: ATHLETE_ID, auth_user_id: USER_ID, name: 'Phil', email: null, sport: null,
    goals: null, obstacle: null, training_age: 8, sessions_per_week: 3,
    onboarding_step: 'complete', arena_type: null, arena_raw: null,
    limiter_choice: null, created_at: iso(60),
  },
  profile: { athlete_id: ATHLETE_ID, current_phase: 'Strength', retest_date: null, last_updated: iso(1) },
  hasDiagnostic: true, routines: [ROUTINE], weekWorkouts: [],
}
const WORKOUT_BOOT = {
  routine: ROUTINE, athleteId: ATHLETE_ID, athleteName: 'Phil', onboardingStep: 'complete',
  prevByExercise: {}, insightMap: {}, prescription: null,
}
const ACTUALS = {
  workoutId: W1, performedAt: iso(1), durationMins: 42, rpe: 8, setLogs: SET_LOGS,
}
const SESSION = {
  access_token: 'fake', token_type: 'bearer', expires_in: 999999,
  expires_at: Math.floor(Date.now() / 1000) + 999999, refresh_token: 'fake',
  user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'p@e.com', app_metadata: {}, user_metadata: {}, created_at: iso(60) },
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
// The bug's condition: the workout row is unreachable (offline, or simply
// slower than the athlete). Everything the device already holds must still work.
await ctx.route('**/placeholder.supabase.co/**', (r) => r.abort())
await ctx.route('**/fonts.g*/**', (r) => r.abort())
const page = await ctx.newPage()

async function seed(withActuals) {
  await page.goto(BASE)
  await page.evaluate(([cache, session, prefix]) => {
    localStorage.clear()
    for (const [k, v] of Object.entries(cache)) {
      localStorage.setItem(prefix + k, JSON.stringify({ v: 'v1', at: Date.now(), data: v }))
    }
    localStorage.setItem('sb-placeholder-auth-token', JSON.stringify(session))
  }, [
    {
      [`app-state:${USER_ID}`]: APP_STATE,
      [`workout:${R1}`]: WORKOUT_BOOT,
      ...(withActuals ? { [`actuals:${W1}`]: ACTUALS } : {}),
    },
    SESSION,
    'zeroed:cache:v1:',
  ])
}

async function readGrid(ms = 9000) {
  await page.waitForTimeout(ms)
  return page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('.set-row__input')).map((i) => i.value),
    refused: document.body.innerText.includes("Couldn't open that session"),
    spinner: !!document.querySelector('.screen--centered svg, .screen--centered .spinner'),
    body: document.body.innerText.slice(0, 200),
  }))
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`)
  if (!ok) failures++
}

// A — the reported case: session saved, its numbers held locally, hit edit.
await seed(true)
await page.goto(`${BASE}/app/workout/${R1}?w=${W1}`)
// The instant the athlete is looking at it — a second after the tap, long
// before the server answers. This is the frame they reported as blank.
const early = await readGrid(1200)
check(
  'edit is never a blank grid the moment it opens',
  !(early.inputs.length > 0 && early.inputs.every((v) => v === '')),
  `${early.inputs.length} empty fields on screen at 1.2s`,
)
const a = await readGrid()
const filled = a.inputs.filter((v) => v !== '').length
check(
  'edit of a saved session opens on its numbers',
  filled === 12 && a.inputs.includes('225') && a.inputs.includes('185'),
  `${filled}/12 fields filled — ${JSON.stringify(a.inputs)}`,
)

// B — nothing held for it and the server is unreachable: it must say so, not
// present an empty grid that a Save would write over the real log.
await seed(false)
await page.goto(`${BASE}/app/workout/${R1}?w=${W1}`)
const b = await readGrid()
check(
  'unreachable edit refuses instead of showing a blank grid',
  b.refused && b.inputs.length === 0,
  `refused=${b.refused} inputs=${b.inputs.length} — ${JSON.stringify(b.body)}`,
)

// C — a normal (non-edit) open is untouched: empty grid, ready to train.
await seed(true)
await page.goto(`${BASE}/app/workout/${R1}`)
const c = await readGrid()
check(
  'starting a fresh session still opens on an empty grid',
  c.inputs.length === 12 && c.inputs.every((v) => v === ''),
  `inputs=${JSON.stringify(c.inputs)}`,
)

await browser.close()
console.log(failures ? `\n${failures} failing` : '\nall good')
process.exit(failures ? 1 : 0)
