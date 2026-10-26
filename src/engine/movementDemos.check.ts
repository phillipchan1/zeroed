// Standalone integrity check for the movement demos (no test runner installed,
// same convention as the other *.check.ts files).
// Run: node --experimental-strip-types src/engine/movementDemos.check.ts
//
// The properties that matter:
//
//   · every demo is keyed by a real library movement, so it's reachable
//   · aliases and split-off variants land on their parent's demo
//   · a reached limb actually reaches — a planted foot stays on its mark and a
//     hand stays on the bar through the whole rep, never short of it
//   · bones keep their length mid-tween (no stretching figure)
//   · each beat pairs limbs of the same kind, so the tween has something to blend
//   · the cue showing always belongs to the motion on screen

import {
  DEMO_NAMES, getMovementDemo, solvePose, frameAt, frontFrameAt, solveFront, cycleLength, loadPath,
  videoSearchUrl, BONE, FLOOR,
  type Limb, type Pt,
} from './movementDemos.ts'
import { findLibraryExercise } from './exerciseLibrary.ts'
import { getCoachingNote } from './coachingNotes.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
const kind = (l: Limb) => (Array.isArray(l) ? 'swing' : 'rel' in l ? 'rel' : 'reach')

for (const name of DEMO_NAMES) {
  const lib = findLibraryExercise(name)
  ok(lib?.name === name, `${name}: demo key is not a canonical library name`)
  // The figure shows it; the note says it. A demo never ships without one.
  ok(getCoachingNote(name) !== null, `${name}: has a demo but no coaching note`)

  const demo = getMovementDemo(name)
  if (!demo) { ok(false, `${name}: no demo resolves`); continue }
  ok(demo.beats.length >= 2, `${name}: a demo needs at least two poses`)
  ok(cycleLength(demo) > 0.7, `${name}: rep is too fast to read`)
  for (const b of demo.beats) {
    ok(b.cue.length > 0 && b.cue.length <= 48, `${name}: cue "${b.cue}" must be short enough for one line`)
  }

  if (demo.facing === 'front') {
    // Facing the viewer: feet land where they're put, never through the floor,
    // and the torso keeps its length.
    const total = cycleLength(demo)
    for (let i = 0; i < 60; i++) {
      const { pose } = frontFrameAt(demo, (i / 60) * total)
      const fig = solveFront(pose)
      ok(Math.abs(dist(fig.pelvis, fig.neck) - BONE.torso) < 1e-6, `${name}: torso stretched at ${i}`)
      for (const side of [0, 1] as const) {
        ok(dist(fig.legs[side][2], pose.feet[side]) < 0.6, `${name}: foot ${side} off its mark at ${i}`)
        ok(pose.feet[side][1] <= FLOOR, `${name}: foot ${side} through the floor at ${i}`)
      }
    }
    continue
  }

  const first = demo.beats[0].pose
  for (const b of demo.beats) {
    for (const side of [0, 1] as const) {
      ok(kind(b.pose.legs[side]) === kind(first.legs[side]), `${name}: leg ${side} changes kind between beats`)
      ok(kind(b.pose.arms[side]) === kind(first.arms[side]), `${name}: arm ${side} changes kind between beats`)
    }
  }

  // Sample the loop: reached limbs land on their targets, bones hold length.
  const total = cycleLength(demo)
  for (let i = 0; i < 60; i++) {
    const { pose, beat } = frameAt(demo, (i / 60) * total)
    ok(beat >= 0 && beat < demo.beats.length, `${name}: beat index out of range`)
    const fig = solvePose(pose, demo.load)
    ok(Math.abs(dist(fig.hip, fig.shoulder) - BONE.torso) < 1e-6, `${name}: torso stretched`)
    for (const side of [0, 1] as const) {
      const [hip, knee, ankle] = fig.legs[side]
      const [sh, elbow, hand] = fig.arms[side]
      ok(Math.abs(dist(hip, knee) - BONE.thigh) < 0.01, `${name}: thigh stretched at ${i}`)
      ok(Math.abs(dist(knee, ankle) - BONE.shin) < 0.01, `${name}: shin stretched at ${i}`)
      ok(Math.abs(dist(sh, elbow) - BONE.upper) < 0.01, `${name}: upper arm stretched at ${i}`)
      ok(Math.abs(dist(elbow, hand) - BONE.fore) < 0.01, `${name}: forearm stretched at ${i}`)
      const leg = pose.legs[side]
      const arm = pose.arms[side]
      // Half a unit of slack — a straight limb is clamped a hair short.
      if (kind(leg) === 'reach') ok(dist(ankle, (leg as { reach: Pt }).reach) < 0.6, `${name}: foot ${side} off its mark at ${i}`)
      // A toe may touch the floor but never sink through it.
      if (demo.floor !== false) ok(fig.legs[side][3][1] <= FLOOR + 1.5, `${name}: toe ${side} through the floor at ${i}`)
      if (kind(arm) === 'reach') ok(dist(hand, (arm as { reach: Pt }).reach) < 0.6, `${name}: hand ${side} off its mark at ${i}`)
    }
  }

  if (demo.trace) ok(loadPath(demo).length > 10, `${name}: traced demo has no load path`)
}

// Aliases and variants reach their parent's figure.
const same = (a: string, b: string) => ok(getMovementDemo(a) !== null && getMovementDemo(a) === getMovementDemo(b), `${a} should show the ${b} demo`)
same('rdl', 'Romanian Deadlift')
same('DB Romanian Deadlift', 'Romanian Deadlift')
same('barbell back squat', 'Back Squat')
same('Incline Push-Up', 'Push-Up')
same('Chin-Up', 'Pull-Up')
same('hex bar deadlift', 'Deadlift')
// The court work as it's written in a program.
same('Sprint (court length)', 'Sprint')
same('Defensive lateral slide (AM skills)', 'Defensive Slide')
same('skater jump', 'Lateral Bound')
same('countermovement jump', 'Vertical Jump')
ok(getMovementDemo('Pallof Press') === null, 'a lift with no demo resolves to null')
ok(getMovementDemo('Not A Real Lift') === null, 'an unknown lift resolves to null')

ok(videoSearchUrl('DB Bench Press').startsWith('https://www.youtube.com/results?search_query='), 'video link is a YouTube search')
ok(videoSearchUrl('Push-Up & Hold').includes('%26'), 'video query is URL-encoded')

if (fails.length) {
  console.error(`movementDemos.check: ${fails.length}/${checks} failed`)
  for (const f of fails.slice(0, 30)) console.error('  ✗', f)
  process.exit(1)
}
console.log(`movementDemos.check: ${checks} checks passed`)
