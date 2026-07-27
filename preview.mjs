/* Dev-only visual harness. Seeds the app's localStorage caches with a realistic
 * athlete, blocks the network so revalidation fails and the cached view stays,
 * then screenshots every loop screen at iPhone dimensions. Not shipped. */
import { chromium } from 'playwright'

const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:5199'
const OUT = process.env.PREVIEW_OUT || '.'
const USER_ID = '11111111-1111-1111-1111-111111111111'
const ATHLETE_ID = '22222222-2222-2222-2222-222222222222'
const R1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const R2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const R3 = 'aaaaaaaa-0000-0000-0000-000000000003'

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString()
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d })()
const sunday = (() => { const d = new Date(monday); d.setDate(d.getDate() + 6); return d })()

const ex = (name, sets, reps, load, extra = {}) => ({
  name, sets, reps, load, cue: extra.cue ?? null, insight_id: extra.insight_id ?? null,
  reading: extra.reading ?? false, reading_why: extra.reading_why ?? null,
  tracking_type: extra.tracking_type ?? null,
})

const INSIGHT = {
  id: 'ins-1', athlete_id: ATHLETE_ID, source_id: null,
  claim: 'Your left hip gives out before your right under load — the squat pattern is losing depth on that side first.',
  category: 'Lower Chain', priority: 'P1', confidence: 0.72, status: 'likely',
  evidence: null, source: 'session_observation',
  program_impact: 'Single-leg work leads every lower session until the gap closes.',
  generated_at: iso(9), resolved_at: null, updated_at: iso(2), prev_status: 'hypothesis',
}
const INSIGHT2 = {
  ...INSIGHT, id: 'ins-2', priority: 'P2', confidence: 0.44, status: 'hypothesis',
  claim: 'Overhead position is limited by thoracic extension, not shoulder range.',
  category: 'Upper Chain', program_impact: null, prev_status: null,
}

const routine = (id, name, intent, exercises) => ({
  id, program_id: 'prog-1', phase_id: 'phase-1', name, session_type: 'strength',
  exercises, intent, intended_dow: null, created_at: iso(20),
})

const ROUTINES = [
  routine(R1, 'Lower A — Squat pattern', 'Rebuild single-leg control before we load the bilateral squat again.', [
    ex('Back Squat', 4, '5', '225 lbs', { cue: 'Brace before you unrack. Knees track over the middle toe.', insight_id: 'ins-1' }),
    ex('Bulgarian Split Squat', 3, '8 each side', '40 lbs', { reading: true, reading_why: 'This is the one that tells us whether the left hip is catching up.' }),
    ex('Romanian Deadlift', 3, '8', '185 lbs'),
    ex('Copenhagen Plank', 3, '30s', null, { tracking_type: 'time' }),
  ]),
  routine(R2, 'Upper A — Press', 'Overhead volume, earned through the thoracic work.', [
    ex('Bench Press', 4, '6', '185 lbs', { cue: 'Elbows at 45°, not flared.' }),
    ex('Overhead Press', 3, '6', '105 lbs', { insight_id: 'ins-2' }),
    ex('Chin-Up', 3, '6-8', 'bodyweight', { tracking_type: 'bodyweight_reps' }),
  ]),
  routine(R3, 'Conditioning', 'Aerobic base. Keep it conversational.', [
    ex('Row', 4, '500', 'moderate', { tracking_type: 'distance' }),
    ex('Farmer Carry', 3, '40s', '70 lbs', { tracking_type: 'time' }),
  ]),
]

const APP_STATE = {
  athlete: {
    id: ATHLETE_ID, auth_user_id: USER_ID, name: 'Phil', email: null,
    sport: null, goals: '315 lb squat', obstacle: 'left hip gives out',
    training_age: 8, sessions_per_week: 3, onboarding_step: 'complete',
    arena_type: 'number', arena_raw: '315 squat', limiter_choice: 'strength',
    created_at: iso(60),
  },
  profile: {
    athlete_id: ATHLETE_ID, current_phase: 'Strength',
    retest_date: ymd(new Date(Date.now() + 11 * 864e5)), last_updated: iso(1),
  },
  hasDiagnostic: true,
  todayRoutine: ROUTINES[0],
  routines: ROUTINES,
}

const TODAY_VIEW = {
  weekWorkouts: [{ id: 'w-1', routineId: R2, performedAt: iso(2) }],
  totalInsights: 5, likelyCount: 2, p1Count: 1, lastSignalAt: iso(2),
  goal: '315 lb squat',
  p1: { category: 'Lower Chain', confidence: 0.72, claim: INSIGHT.claim },
  retestDate: ymd(new Date(Date.now() + 11 * 864e5)),
  sessionsPerWeek: 3,
  latestReview: { id: 'rev-1', weekEnding: ymd(new Date(Date.now() - 3 * 864e5)) },
  lastDoneByRoutine: { [R1]: iso(9), [R3]: iso(12) },
}

const PROGRAM_VIEW = {
  program: { id: 'prog-1', athlete_id: ATHLETE_ID, goal: 'Add 40 lb to the squat without the left hip folding.', start_date: ymd(new Date(Date.now() - 40 * 864e5)), retest_date: ymd(new Date(Date.now() + 11 * 864e5)), status: 'active' },
  phase: {
    id: 'phase-1', program_id: 'prog-1', name: 'Strength',
    week_start: ymd(new Date(Date.now() - 14 * 864e5)), week_end: ymd(new Date(Date.now() + 20 * 864e5)),
    non_negotiables: ['Single-leg work before bilateral, every lower session.', 'Stop a set the moment depth collapses.', 'Two full rest days, minimum.'],
    advancement_criteria: ['Split squat within 10% left vs right for two straight weeks.', 'Squat 275×5 at RPE 8 or below.'],
    status: 'active',
  },
  routines: ROUTINES,
  profile: APP_STATE.profile,
}

const PROGRAM_MAP = {
  phases: [
    { name: 'Stability', state: 'done', goal: '', gate: [] },
    { name: 'Strength', state: 'current', goal: '', gate: [] },
    { name: 'Power', state: 'upcoming', goal: 'Turn the strength into speed off the floor.', gate: ['Squat 300×3 clean'] },
    { name: 'Sport', state: 'upcoming', goal: 'Express it under fatigue.', gate: ['Power phase complete'] },
  ],
  nextWeek: {
    directive: 'PROGRESS', loadDeltaPct: 3, rpeTarget: 8, provisional: true,
    rationale: 'Three sessions logged, RPE held at 7. You earned a small bump.',
    sessions: [
      { routineId: R1, routineName: 'Lower A — Squat pattern', lines: [
        { name: 'Back Squat', hint: '232 lbs × 5', held: false },
        { name: 'Romanian Deadlift', hint: '190 lbs × 8', held: false },
      ] },
      { routineId: R2, routineName: 'Upper A — Press', lines: [
        { name: 'Bench Press', hint: '190 lbs × 6', held: false },
        { name: 'Overhead Press', hint: '105 lbs × 6 (hold)', held: true },
      ] },
    ],
  },
}

const LOG = {
  weeks: [
    { weekStart: ymd(monday), weekEnding: ymd(sunday), totalSets: 14, sessions: [
      { workoutId: 'w-1', routineId: R2, routineName: 'Upper A — Press', performedAt: iso(2), setsDone: 14, rpe: 8, phaseName: 'Strength', pending: false,
        highlights: [{ name: 'Bench Press', set: { weight: 185, reps: 6 } }, { name: 'Overhead Press', set: { weight: 105, reps: 6 } }] },
    ] },
    { weekStart: ymd(new Date(monday.getTime() - 7 * 864e5)), weekEnding: ymd(new Date(sunday.getTime() - 7 * 864e5)), totalSets: 38, sessions: [
      { workoutId: 'w-2', routineId: R1, routineName: 'Lower A — Squat pattern', performedAt: iso(9), setsDone: 13, rpe: 7, phaseName: 'Strength', pending: false,
        highlights: [{ name: 'Back Squat', set: { weight: 225, reps: 5 } }] },
      { workoutId: 'w-3', routineId: R3, routineName: 'Conditioning', performedAt: iso(12), setsDone: 7, rpe: 6, phaseName: 'Strength', pending: false, highlights: [] },
    ] },
  ],
}

const RECAP = {
  weekStart: ymd(new Date(monday.getTime() - 7 * 864e5)),
  weekEnd: ymd(new Date(sunday.getTime() - 7 * 864e5)),
  planned: 3, totalSets: 38,
  review: {
    id: 'rev-1',
    adjustments: { adherence: 0.67, avgRPE: 7, painCount: 1, positiveCount: 4 },
    next_week_prescription: {
      directive: 'PROGRESS', load_delta_pct: 3, rpe_target: 8,
      rationale: 'Two of three sessions in, effort held at 7, and the left-side gap narrowed. Small bump this week.',
    },
  },
  movements: [
    { id: 'ins-1', category: 'Lower Chain', claim: INSIGHT.claim, confidence: 0.72, status: 'likely', prevStatus: 'hypothesis' },
  ],
  sessions: LOG.weeks[1].sessions.map((s) => ({ ...s })),
}

const WEEK_PAGER = { past: [], future: [], boundary: null }

const WORKOUT_BOOT = {
  routine: ROUTINES[0], athleteId: ATHLETE_ID, athleteName: 'Phil', onboardingStep: 'complete',
  prevByExercise: { 0: [{ set: 1, weight: 220, reps: 5, rpe: 7, done: true }, { set: 2, weight: 220, reps: 5, rpe: 8, done: true }] },
  insightMap: { 'ins-1': INSIGHT },
  prescription: {
    rule: { name: 'Progressive overload', reasoning: 'You cleared last week at RPE 7 with clean depth, so we add a plate per side.' },
    hints: { 0: '225 lbs · +5 from last week', 1: 'Match last week', 2: '', 3: '' },
    held: { 0: false, 1: true, 2: false, 3: false },
  },
}

const CACHE = {
  [`app-state:${USER_ID}`]: APP_STATE,
  [`today:${ATHLETE_ID}`]: TODAY_VIEW,
  [`weekpager:${ATHLETE_ID}`]: WEEK_PAGER,
  [`program:${ATHLETE_ID}`]: PROGRAM_VIEW,
  [`programmap:${ATHLETE_ID}`]: PROGRAM_MAP,
  [`history:${ATHLETE_ID}`]: LOG,
  [`recap:${ATHLETE_ID}:latest`]: RECAP,
  [`recap:${ATHLETE_ID}:rev-1`]: RECAP,
  [`workout:${R1}`]: WORKOUT_BOOT,
}

const SESSION = {
  access_token: 'fake', token_type: 'bearer', expires_in: 999999,
  expires_at: Math.floor(Date.now() / 1000) + 999999, refresh_token: 'fake',
  user: {
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'phil@example.com',
    app_metadata: {}, user_metadata: {}, created_at: iso(60),
  },
}

const shots = [
  ['today', '/app/today'],
  ['program', '/app/program'],
  ['coach', '/app/coach'],
  ['history', '/app/history'],
  ['recap', '/app/recap/rev-1'],
  ['profile', '/app/profile'],
  ['workout', `/app/workout/${R1}`],
]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
// Kill every Supabase call so revalidation fails and the seeded cache is what renders.
await ctx.route('**/placeholder.supabase.co/**', (r) => r.abort())
await ctx.route('**/fonts.googleapis.com/**', (r) => r.abort())
await ctx.route('**/fonts.gstatic.com/**', (r) => r.abort())

const page = await ctx.newPage()
await page.goto(BASE)
await page.evaluate(([cache, session, prefix]) => {
  localStorage.clear()
  for (const [k, v] of Object.entries(cache)) {
    localStorage.setItem(prefix + k, JSON.stringify({ v: 'v1', at: Date.now(), data: v }))
  }
  localStorage.setItem('sb-placeholder-auth-token', JSON.stringify(session))
}, [CACHE, SESSION, 'zeroed:cache:v1:'])

for (const [name, path] of shots) {
  await page.goto(BASE + path)
  await page.waitForTimeout(1400)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log('shot', name)
}

// Workout, past the opening brief.
await page.goto(BASE + `/app/workout/${R1}`)
await page.waitForTimeout(1400)
await page.locator('.obs-sheet .btn--primary').click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/workout-live.png`, fullPage: true })
console.log('shot workout-live')
await page.locator('.howto-tag').nth(1).click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/workout-details.png`, fullPage: true })
console.log('shot workout-details')

// Sheets — the sub-screens.
await page.goto(BASE + '/app/today')
await page.waitForTimeout(1200)
const card = page.locator('.card--tap').first()
if (await card.count()) { await card.click(); await page.waitForTimeout(600); await page.screenshot({ path: `${OUT}/today-sheet.png`, fullPage: true }); console.log('shot today-sheet') }

await browser.close()
