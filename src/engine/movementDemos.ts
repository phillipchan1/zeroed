// =============================================================================
// Movement demos — the "show me" half of the how-to.
//
// coachingNotes.ts says how a lift is performed in words; this table shows it: a
// side-view figure looping through the rep, drawn by MovementDemo.tsx in the
// brand's own ink (bone-white figure, signal-yellow load, the bar path traced).
// Same doctrine as the other two tables — code-owned, closed, resolved through
// the library's alias-aware lookup so "db rdl" lands on the RDL demo.
//
// A demo is a few key poses and the time between them. A pose is a skeleton:
// the hip's position, the torso's lean, and each limb either swung to an angle
// (a hanging arm, a bent knee in the air) or REACHED to a point (a foot planted
// on the floor, a hand on the bar). Reached limbs are solved every frame, so a
// planted foot stays planted and the bar travels where the hands put it while
// the body moves between poses — the tween never skates a foot across the floor.
//
// Coverage is the main lifts. Anything else falls back to the written note and
// the video link; a missing demo is never an error.
// =============================================================================

import { findLibraryExercise, normalizeName } from './exerciseLibrary.ts'

export type Pt = [number, number]

// Angles are absolute, in degrees, measured from straight down and turning
// toward the figure's front: 0 hangs down, 90 points forward (the figure faces
// +x), 180 points up, -90 points back.
type Angle = number

/**
 * A limb is swung (two absolute angles: upper then lower segment), swung with
 * the torso (`rel` — the angles as they'd read on an upright torso, rotated by
 * however far the torso leans), or reached to a point with its middle joint
 * bending toward `bend`.
 */
export type Limb =
  | [Angle, Angle]
  | { rel: [Angle, Angle] }
  | { reach: Pt; bend: 'fwd' | 'back' | 'up' | 'down' }

export interface Pose {
  hip: Pt
  torso: Angle           // hip → shoulder
  head?: Angle           // tilt off the torso line; positive tips it back
  legs: [Limb, Limb]     // near, far
  arms: [Limb, Limb]     // near, far
  feet?: [Angle, Angle]  // absolute foot angles; default flat, toes forward
}

export interface Beat {
  pose: Pose
  hold: number   // seconds held at this pose
  move: number   // seconds travelling to the next pose
  cue: string    // what's happening from this pose to the next
}

export type LoadKind = 'barbell' | 'dumbbell' | 'kettlebell' | 'handle'

export interface Load {
  kind: LoadKind
  // Where it rides: in the hands, across the upper back, in the front rack, or
  // across the hips (a thrust).
  at: 'hands' | 'back' | 'rack' | 'hips'
}

export type Prop =
  | { kind: 'bench'; x: number; w: number; top: number }
  | { kind: 'incline'; from: Pt; to: Pt }
  | { kind: 'rail'; x: number; w: number; y: number }   // parallel-bar or pull-up bar, side on
  | { kind: 'pad'; at: Pt }                             // pulldown thigh pad
  | { kind: 'cable'; from: Pt }                         // cable runs from here to the load

export interface MovementDemo {
  beats: Beat[]
  load?: Load
  props?: Prop[]
  floor?: boolean         // default true
  trace?: boolean         // draw the load's path — the bar path is the lesson
  view?: [number, number, number, number]
}

// ---- body ------------------------------------------------------------------
// Rough adult proportions in view units. The floor is at y = 110 and a standing
// figure's ankles at x = 80, facing right.

export const BONE = {
  torso: 30, neck: 4, head: 6.5,
  upper: 17, fore: 16, thigh: 23, shin: 22, foot: 8,
} as const

export const FLOOR = 110
export const DEFAULT_VIEW: [number, number, number, number] = [14, 10, 132, 104]

// ---- the table -------------------------------------------------------------

const PLANTED = { reach: [80, FLOOR] as Pt, bend: 'fwd' as const }
const HANG: Limb = { rel: [0, 0] }

/** The torso angle that points the shoulder from `hip` at `shoulder`. */
function aim(hip: Pt, shoulder: Pt): Angle {
  return (Math.atan2(shoulder[0] - hip[0], shoulder[1] - hip[1]) * 180) / Math.PI
}

const BACK_SQUAT: MovementDemo = {
  load: { kind: 'barbell', at: 'back' },
  trace: true,
  beats: [
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: [{ rel: [-40, -160] }, { rel: [-40, -160] }] },
      hold: 0.6, move: 1.5, cue: 'Brace, then sit down between your hips',
    },
    {
      pose: { hip: [67, 90], torso: 146, legs: [PLANTED, PLANTED], arms: [{ rel: [-40, -160] }, { rel: [-40, -160] }] },
      hold: 0.25, move: 1.1, cue: 'Drive the whole foot through the floor',
    },
  ],
}

const FRONT_SQUAT: MovementDemo = {
  load: { kind: 'barbell', at: 'rack' },
  trace: true,
  beats: [
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: [{ rel: [100, -110] }, { rel: [100, -110] }] },
      hold: 0.6, move: 1.5, cue: 'Elbows high, sit straight down',
    },
    {
      pose: { hip: [70, 91], torso: 162, legs: [PLANTED, PLANTED], arms: [{ rel: [100, -110] }, { rel: [100, -110] }] },
      hold: 0.25, move: 1.1, cue: 'Stand up tall — elbows stay up',
    },
  ],
}

const GOBLET_SQUAT: MovementDemo = {
  load: { kind: 'dumbbell', at: 'hands' },
  beats: [
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: [{ rel: [20, 150] }, { rel: [20, 150] }] },
      hold: 0.6, move: 1.5, cue: 'Weight at your chest, sit between your knees',
    },
    {
      pose: { hip: [70, 92], torso: 156, legs: [PLANTED, PLANTED], arms: [{ rel: [20, 150] }, { rel: [20, 150] }] },
      hold: 0.25, move: 1.1, cue: 'Chest tall, drive up through mid-foot',
    },
  ],
}

// Four beats, not two: the bar passing the knees is the checkpoint of the lift
// (and a straight tween from floor to lockout would swing the bar off the legs).
const DL_HANDS = (at: Pt): [Limb, Limb] => [{ reach: at, bend: 'back' }, { reach: at, bend: 'back' }]
const DL_KNEES: Pose = {
  hip: [68, 75], torso: aim([68, 75], [86, 52]), head: -6,
  legs: [PLANTED, PLANTED], arms: DL_HANDS([83, 83]),
}
const DEADLIFT: MovementDemo = {
  load: { kind: 'barbell', at: 'hands' },
  trace: true,
  beats: [
    {
      pose: {
        hip: [64, 83], torso: aim([64, 83], [87, 66]), head: -10,
        legs: [PLANTED, PLANTED], arms: DL_HANDS([84, 98]),
      },
      hold: 0.5, move: 0.7, cue: 'Brace and push the floor away',
    },
    { pose: DL_KNEES, hold: 0, move: 0.6, cue: 'Past the knees — hips through' },
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: DL_HANDS([81, 67]) },
      hold: 0.5, move: 0.7, cue: 'Hips back first — bar stays on your legs',
    },
    { pose: DL_KNEES, hold: 0, move: 0.6, cue: 'Bend the knees once the bar passes' },
  ],
}

const RDL_THIGHS: Pose = {
  hip: [68, 70], torso: aim([68, 70], [85, 46]), head: -4,
  legs: [PLANTED, PLANTED], arms: DL_HANDS([82, 77]),
}
const ROMANIAN_DEADLIFT: MovementDemo = {
  load: { kind: 'barbell', at: 'hands' },
  trace: true,
  beats: [
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: DL_HANDS([81, 67]) },
      hold: 0.5, move: 0.8, cue: 'Soft knees, push your hips back',
    },
    { pose: RDL_THIGHS, hold: 0, move: 0.8, cue: 'Bar slides down your thighs' },
    {
      pose: {
        hip: [57, 73], torso: aim([57, 73], [84, 62]), head: -8,
        legs: [PLANTED, PLANTED], arms: DL_HANDS([83, 94]),
      },
      hold: 0.3, move: 0.6, cue: 'Hamstrings loaded — drive the hips through',
    },
    { pose: RDL_THIGHS, hold: 0, move: 0.5, cue: 'Stand tall and squeeze' },
  ],
}

// Lying on a bench, head to the right. The bar comes down to the lower chest
// and presses back up over the shoulders.
const BENCH_PRESS: MovementDemo = {
  load: { kind: 'barbell', at: 'hands' },
  trace: true,
  props: [{ kind: 'bench', x: 36, w: 72, top: 88 }],
  beats: [
    {
      pose: {
        hip: [62, 84], torso: 90,
        legs: [{ reach: [44, FLOOR], bend: 'up' }, { reach: [44, FLOOR], bend: 'up' }],
        arms: [{ reach: [93, 51], bend: 'down' }, { reach: [93, 51], bend: 'down' }],
        feet: [-90, -90],
      },
      hold: 0.4, move: 1.4, cue: 'Lower to your lower chest, elbows tucked',
    },
    {
      pose: {
        hip: [62, 84], torso: 90,
        legs: [{ reach: [44, FLOOR], bend: 'up' }, { reach: [44, FLOOR], bend: 'up' }],
        arms: [{ reach: [88, 77], bend: 'down' }, { reach: [88, 77], bend: 'down' }],
        feet: [-90, -90],
      },
      hold: 0.2, move: 1.0, cue: 'Press up and back over your shoulders',
    },
  ],
}

const OVERHEAD_PRESS: MovementDemo = {
  load: { kind: 'barbell', at: 'hands' },
  trace: true,
  view: [14, -12, 132, 128],
  beats: [
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: [{ reach: [87, 36], bend: 'down' }, { reach: [87, 36], bend: 'down' }] },
      hold: 0.4, move: 0.5, cue: 'Squeeze glutes, press — head back',
    },
    {
      pose: { hip: [79, 66], torso: 180, head: 14, legs: [PLANTED, PLANTED], arms: [{ reach: [89, 16], bend: 'down' }, { reach: [89, 16], bend: 'down' }] },
      hold: 0, move: 0.6, cue: 'Head through, lock out over mid-foot',
    },
    {
      pose: { hip: [79, 66], torso: 180, legs: [PLANTED, PLANTED], arms: [{ reach: [80, 4], bend: 'down' }, { reach: [80, 4], bend: 'down' }] },
      hold: 0.4, move: 0.7, cue: 'Lower under control',
    },
    {
      pose: { hip: [79, 66], torso: 180, head: 14, legs: [PLANTED, PLANTED], arms: [{ reach: [89, 16], bend: 'down' }, { reach: [89, 16], bend: 'down' }] },
      hold: 0, move: 0.6, cue: 'Bar back to your collarbones',
    },
  ],
}

const PULL_UP: MovementDemo = {
  floor: false,
  view: [14, -12, 132, 128],
  props: [{ kind: 'rail', x: 70, w: 30, y: 8 }],
  beats: [
    {
      pose: {
        hip: [83, 70], torso: 177,
        legs: [[8, -60], [8, -60]],
        arms: [{ reach: [88, 8], bend: 'down' }, { reach: [88, 8], bend: 'down' }],
      },
      hold: 0.5, move: 1.1, cue: 'Pull your elbows down to your ribs',
    },
    {
      pose: {
        hip: [78, 42], torso: 172,
        legs: [[14, -50], [14, -50]],
        arms: [{ reach: [88, 8], bend: 'down' }, { reach: [88, 8], bend: 'down' }],
      },
      hold: 0.3, move: 1.4, cue: 'Chin over — lower all the way to a full hang',
    },
  ],
}

const BARBELL_ROW: MovementDemo = {
  load: { kind: 'barbell', at: 'hands' },
  trace: true,
  beats: [
    {
      pose: {
        hip: [64, 72], torso: 125, head: -10,
        legs: [PLANTED, PLANTED],
        arms: [{ reach: [88, 87], bend: 'up' }, { reach: [88, 87], bend: 'up' }],
      },
      hold: 0.4, move: 0.8, cue: 'Pull the bar to your lower ribs',
    },
    {
      pose: {
        hip: [64, 72], torso: 125, head: -10,
        legs: [PLANTED, PLANTED],
        arms: [{ reach: [79, 74], bend: 'up' }, { reach: [79, 74], bend: 'up' }],
      },
      hold: 0.3, move: 1.1, cue: 'Lower to a full hang — torso stays put',
    },
  ],
}

// Upper back on the bench edge, feet planted, the bar across the hips.
const HIP_THRUST: MovementDemo = {
  load: { kind: 'barbell', at: 'hips' },
  view: [8, 10, 132, 104],
  props: [{ kind: 'bench', x: 18, w: 34, top: 88 }],
  beats: [
    {
      pose: {
        hip: [74, 101.5], torso: aim([74, 101.5], [50, 84]), head: 10,
        legs: [{ reach: [103, FLOOR], bend: 'up' }, { reach: [103, FLOOR], bend: 'up' }],
        arms: [{ reach: [74, 95], bend: 'up' }, { reach: [74, 95], bend: 'up' }],
      },
      hold: 0.3, move: 1.0, cue: 'Chin tucked, drive your hips up',
    },
    {
      pose: {
        hip: [80, 84], torso: -90, head: -20,
        legs: [{ reach: [103, FLOOR], bend: 'up' }, { reach: [103, FLOOR], bend: 'up' }],
        arms: [{ reach: [80, 78], bend: 'up' }, { reach: [80, 78], bend: 'up' }],
      },
      hold: 0.6, move: 1.2, cue: 'Squeeze at the top, lower with control',
    },
  ],
}

// Lying on the floor, the same hip drive as the thrust.
const GLUTE_BRIDGE: MovementDemo = {
  view: [14, 44, 132, 72],
  beats: [
    {
      pose: {
        hip: [76, 103], torso: aim([76, 103], [46, 103]),
        legs: [{ reach: [96, FLOOR], bend: 'up' }, { reach: [96, FLOOR], bend: 'up' }],
        arms: [{ reach: [78, 107], bend: 'up' }, { reach: [78, 107], bend: 'up' }],
      },
      hold: 0.3, move: 0.9, cue: 'Heels down, drive your hips up',
    },
    {
      pose: {
        hip: [73, 90], torso: aim([73, 90], [46, 103]),
        legs: [{ reach: [96, FLOOR], bend: 'up' }, { reach: [96, FLOOR], bend: 'up' }],
        arms: [{ reach: [78, 107], bend: 'up' }, { reach: [78, 107], bend: 'up' }],
      },
      hold: 0.7, move: 1.1, cue: 'Squeeze — ribs down — then lower',
    },
  ],
}

// Rear foot on the bench behind; the front leg does the work.
const SPLIT_SQUAT_ARMS: [Limb, Limb] = [{ rel: [-4, -4] }, { rel: [-4, -4] }]
const BULGARIAN_SPLIT_SQUAT: MovementDemo = {
  load: { kind: 'dumbbell', at: 'hands' },
  props: [{ kind: 'bench', x: 28, w: 28, top: 90 }],
  beats: [
    {
      pose: {
        hip: [78, 70], torso: 176,
        legs: [{ reach: [96, FLOOR], bend: 'fwd' }, { reach: [50, 86], bend: 'down' }],
        arms: SPLIT_SQUAT_ARMS, feet: [90, -100],
      },
      hold: 0.5, move: 1.4, cue: 'Sink straight down, weight on the front leg',
    },
    {
      pose: {
        hip: [76, 88], torso: 170,
        legs: [{ reach: [96, FLOOR], bend: 'fwd' }, { reach: [50, 86], bend: 'down' }],
        arms: SPLIT_SQUAT_ARMS, feet: [90, -100],
      },
      hold: 0.2, move: 1.1, cue: 'Drive through the front heel',
    },
  ],
}

const WALKING_LUNGE: MovementDemo = {
  load: { kind: 'dumbbell', at: 'hands' },
  beats: [
    {
      pose: {
        hip: [80, 70], torso: 180,
        legs: [{ reach: [100, FLOOR - 1], bend: 'fwd' }, { reach: [56, 103], bend: 'down' }],
        arms: [HANG, HANG], feet: [90, 45],
      },
      hold: 0.4, move: 1.2, cue: 'Long stride — drop the back knee',
    },
    {
      pose: {
        hip: [79, 88], torso: 178,
        legs: [{ reach: [100, FLOOR - 1], bend: 'fwd' }, { reach: [56, 103], bend: 'down' }],
        arms: [HANG, HANG], feet: [90, 45],
      },
      hold: 0.2, move: 1.0, cue: 'Torso tall, drive through the front heel',
    },
  ],
}

// Plank facing the floor, head to the right; the body pivots on the toes.
const PUSH_UP: MovementDemo = {
  beats: [
    {
      pose: {
        hip: [72, 87.7], torso: 110.9,
        legs: [{ reach: [30, 104], bend: 'down' }, { reach: [30, 104], bend: 'down' }],
        arms: [{ reach: [101, 108], bend: 'back' }, { reach: [101, 108], bend: 'back' }],
        feet: [45, 45],
      },
      hold: 0.4, move: 1.2, cue: 'Lower as one rigid plank',
    },
    {
      pose: {
        hip: [74.9, 100.4], torso: 94.6,
        legs: [{ reach: [30, 104], bend: 'down' }, { reach: [30, 104], bend: 'down' }],
        arms: [{ reach: [101, 108], bend: 'up' }, { reach: [101, 108], bend: 'up' }],
        feet: [45, 45],
      },
      hold: 0.2, move: 0.9, cue: 'Push the floor away',
    },
  ],
}

const KETTLEBELL_SWING: MovementDemo = {
  load: { kind: 'kettlebell', at: 'hands' },
  beats: [
    {
      pose: {
        hip: [62, 70], torso: 120, head: -10,
        legs: [PLANTED, PLANTED],
        arms: [{ reach: [76, 84], bend: 'back' }, { reach: [76, 84], bend: 'back' }],
      },
      hold: 0.05, move: 0.55, cue: 'Snap the hips — the bell floats',
    },
    {
      pose: {
        hip: [79, 66], torso: 182,
        legs: [PLANTED, PLANTED],
        arms: [{ reach: [111, 42], bend: 'down' }, { reach: [111, 42], bend: 'down' }],
      },
      hold: 0.15, move: 0.6, cue: 'Hike it back between your legs',
    },
  ],
}

const LAT_PULLDOWN: MovementDemo = {
  load: { kind: 'handle', at: 'hands' },
  props: [
    { kind: 'bench', x: 62, w: 26, top: 89 },
    { kind: 'pad', at: [98, 80] },
    { kind: 'cable', from: [79, -2] },
  ],
  beats: [
    {
      pose: {
        hip: [75, 85], torso: 188,
        legs: [{ reach: [100, FLOOR], bend: 'up' }, { reach: [100, FLOOR], bend: 'up' }],
        arms: [{ reach: [79, 23], bend: 'fwd' }, { reach: [79, 23], bend: 'fwd' }],
      },
      hold: 0.4, move: 1.0, cue: 'Chest up, pull elbows to your ribs',
    },
    {
      pose: {
        hip: [75, 85], torso: 192,
        legs: [{ reach: [100, FLOOR], bend: 'up' }, { reach: [100, FLOOR], bend: 'up' }],
        arms: [{ reach: [79, 57], bend: 'down' }, { reach: [79, 57], bend: 'down' }],
      },
      hold: 0.3, move: 1.3, cue: 'Let the arms reach long again',
    },
  ],
}

const DIP: MovementDemo = {
  floor: false,
  props: [{ kind: 'rail', x: 64, w: 34, y: 61 }],
  view: [14, 6, 132, 108],
  beats: [
    {
      pose: {
        hip: [78, 58], torso: 178,
        legs: [[6, -55], [6, -55]],
        arms: [{ reach: [80, 60], bend: 'back' }, { reach: [80, 60], bend: 'back' }],
      },
      hold: 0.4, move: 1.3, cue: 'Lean a little forward, lower under control',
    },
    {
      pose: {
        hip: [65, 78], torso: 160,
        legs: [[16, -45], [16, -45]],
        arms: [{ reach: [80, 60], bend: 'back' }, { reach: [80, 60], bend: 'back' }],
      },
      hold: 0.2, move: 1.0, cue: 'Press back up to straight arms',
    },
  ],
}

/** Swap the load on a demo — same movement, different implement. */
function withLoad(demo: MovementDemo, kind: LoadKind): MovementDemo {
  return { ...demo, load: demo.load && { ...demo.load, kind }, trace: kind === 'barbell' && demo.trace }
}

// Keyed by canonical library name. Variants that move the same way (Chin-Up,
// Trap Bar Deadlift) point at the parent here; split-off entries also inherit
// through the library's noteAs, the same way coaching notes do.
const DEMOS: Record<string, MovementDemo> = {
  'Back Squat': BACK_SQUAT,
  'Front Squat': FRONT_SQUAT,
  'Goblet Squat': GOBLET_SQUAT,
  'Deadlift': DEADLIFT,
  'Trap Bar Deadlift': DEADLIFT,
  'Romanian Deadlift': ROMANIAN_DEADLIFT,
  'Bench Press': BENCH_PRESS,
  'DB Bench Press': withLoad(BENCH_PRESS, 'dumbbell'),
  'Overhead Press': OVERHEAD_PRESS,
  'DB Shoulder Press': withLoad(OVERHEAD_PRESS, 'dumbbell'),
  'Pull-Up': PULL_UP,
  'Chin-Up': PULL_UP,
  'Barbell Row': BARBELL_ROW,
  'Hip Thrust': HIP_THRUST,
  'Glute Bridge': GLUTE_BRIDGE,
  'Bulgarian Split Squat': BULGARIAN_SPLIT_SQUAT,
  'Walking Lunge': WALKING_LUNGE,
  'Lunge': { ...WALKING_LUNGE, load: undefined },
  'Push-Up': PUSH_UP,
  'Kettlebell Swing': KETTLEBELL_SWING,
  'Lat Pulldown': LAT_PULLDOWN,
  'Dip': DIP,
}

const DEMO_LOOKUP = new Map<string, MovementDemo>()
for (const [name, demo] of Object.entries(DEMOS)) DEMO_LOOKUP.set(normalizeName(name), demo)

export const DEMO_NAMES = Object.keys(DEMOS)

/** The animated demo for an exercise, or null when there isn't one yet. */
export function getMovementDemo(name: string): MovementDemo | null {
  const lib = findLibraryExercise(name)
  if (!lib) return DEMO_LOOKUP.get(normalizeName(name)) ?? null
  return DEMO_LOOKUP.get(normalizeName(lib.name))
    ?? (lib.noteAs ? DEMO_LOOKUP.get(normalizeName(lib.noteAs)) : undefined)
    ?? null
}

/** A video search for any exercise — the fallback when a figure isn't enough. */
export function videoSearchUrl(name: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} exercise proper form`)}`
}

// ---- solving a frame -------------------------------------------------------

export interface Figure {
  head: Pt
  shoulder: Pt
  hip: Pt
  legs: [Pt[], Pt[]]   // hip, knee, ankle, toe
  arms: [Pt[], Pt[]]   // shoulder, elbow, hand
  forearm: Angle       // near forearm direction, for hanging a kettlebell
  load: Pt | null
}

function dir(a: Angle): Pt {
  const r = (a * Math.PI) / 180
  return [Math.sin(r), Math.cos(r)]
}
function add(p: Pt, d: Pt, len: number): Pt {
  return [p[0] + d[0] * len, p[1] + d[1] * len]
}
function angleOf(from: Pt, to: Pt): Angle {
  return (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI
}

const BEND: Record<'fwd' | 'back' | 'up' | 'down', Pt> = {
  fwd: [1, 0], back: [-1, 0], up: [0, -1], down: [0, 1],
}

/**
 * Two-bone reach: the middle joint for a limb rooted at `root` whose end should
 * land on `target`, bent toward `bend`. Out-of-reach targets straighten the limb
 * toward them rather than tearing it.
 */
export function solveReach(root: Pt, target: Pt, a: number, b: number, bend: Pt): [Pt, Pt] {
  const dx = target[0] - root[0]
  const dy = target[1] - root[1]
  const raw = Math.hypot(dx, dy)
  const d = Math.min(Math.max(raw, Math.abs(a - b) + 1e-6), a + b - 1e-6)
  const ux = raw > 0 ? dx / raw : 0
  const uy = raw > 0 ? dy / raw : 1
  const along = (a * a + d * d - b * b) / (2 * d)
  const off = Math.sqrt(Math.max(a * a - along * along, 0))
  // The two mirror solutions; keep the one on the bend side.
  const m1: Pt = [root[0] + ux * along - uy * off, root[1] + uy * along + ux * off]
  const m2: Pt = [root[0] + ux * along + uy * off, root[1] + uy * along - ux * off]
  const s1 = (m1[0] - root[0]) * bend[0] + (m1[1] - root[1]) * bend[1]
  const s2 = (m2[0] - root[0]) * bend[0] + (m2[1] - root[1]) * bend[1]
  const mid = s1 >= s2 ? m1 : m2
  const end = add(root, [ux, uy], d)
  return [mid, end]
}

function limb(root: Pt, spec: Limb, torso: Angle, a: number, b: number): Pt[] {
  if (Array.isArray(spec)) {
    const mid = add(root, dir(spec[0]), a)
    return [root, mid, add(mid, dir(spec[1]), b)]
  }
  if ('rel' in spec) {
    const t = torso - 180
    const mid = add(root, dir(spec.rel[0] + t), a)
    return [root, mid, add(mid, dir(spec.rel[1] + t), b)]
  }
  const [mid, end] = solveReach(root, spec.reach, a, b, BEND[spec.bend])
  return [root, mid, end]
}

export function solvePose(pose: Pose, load?: Load): Figure {
  const td = dir(pose.torso)
  const hip = pose.hip
  const shoulder = add(hip, td, BONE.torso)
  const head = add(shoulder, dir(pose.torso + (pose.head ?? 0)), BONE.neck + BONE.head)

  const legs = pose.legs.map((spec, i) => {
    const [h, knee, ankle] = limb(hip, spec, pose.torso, BONE.thigh, BONE.shin)
    // A planted foot lies flat; a swung one stays square to its shin.
    const footAngle = pose.feet?.[i] ?? (Array.isArray(spec) ? spec[1] + 90 : 90)
    return [h, knee, ankle, add(ankle, dir(footAngle), BONE.foot)]
  }) as [Pt[], Pt[]]

  const arms = pose.arms.map((spec) => limb(shoulder, spec, pose.torso, BONE.upper, BONE.fore)) as [Pt[], Pt[]]
  const hand = arms[0][2]

  // The load's centre. Back and rack sit a hand's width behind / in front of the
  // shoulder, perpendicular to the torso line.
  const back: Pt = [td[1], -td[0]]   // torso rotated a quarter turn, toward the back
  let at: Pt | null = null
  if (load?.at === 'hands') at = hand
  else if (load?.at === 'back') at = add(shoulder, back, 4)
  else if (load?.at === 'rack') at = add(add(shoulder, back, -6), td, -1)
  else if (load?.at === 'hips') at = [hip[0], hip[1] - 9]

  return { head, shoulder, hip, legs, arms, forearm: angleOf(arms[0][1], hand), load: at }
}

// ---- timeline --------------------------------------------------------------

export function cycleLength(demo: MovementDemo): number {
  return demo.beats.reduce((s, b) => s + b.hold + b.move, 0)
}

// Ease in and out so every movement starts and finishes under control.
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
}

function lerpLimb(a: Limb, b: Limb, t: number): Limb {
  if (Array.isArray(a) && Array.isArray(b)) return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
  if (!Array.isArray(a) && !Array.isArray(b) && 'rel' in a && 'rel' in b) {
    return { rel: [lerp(a.rel[0], b.rel[0], t), lerp(a.rel[1], b.rel[1], t)] }
  }
  if (!Array.isArray(a) && !Array.isArray(b) && 'reach' in a && 'reach' in b) {
    // Bend side flips at the halfway mark (a push-up's elbows go from pointing
    // back to pointing up — they never pass through each other mid-rep).
    return { reach: lerpPt(a.reach, b.reach, t), bend: t < 0.5 ? a.bend : b.bend }
  }
  return t < 0.5 ? a : b
}

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    hip: lerpPt(a.hip, b.hip, t),
    torso: lerp(a.torso, b.torso, t),
    head: lerp(a.head ?? 0, b.head ?? 0, t),
    legs: [lerpLimb(a.legs[0], b.legs[0], t), lerpLimb(a.legs[1], b.legs[1], t)],
    arms: [lerpLimb(a.arms[0], b.arms[0], t), lerpLimb(a.arms[1], b.arms[1], t)],
    feet: a.feet || b.feet
      ? [lerp(a.feet?.[0] ?? 90, b.feet?.[0] ?? 90, t), lerp(a.feet?.[1] ?? 90, b.feet?.[1] ?? 90, t)]
      : undefined,
  }
}

export interface Frame {
  pose: Pose
  beat: number   // which cue is showing
}

/** Where the demo is `seconds` into its loop. */
export function frameAt(demo: MovementDemo, seconds: number): Frame {
  const total = cycleLength(demo)
  let t = ((seconds % total) + total) % total
  const n = demo.beats.length
  for (let i = 0; i < n; i++) {
    const beat = demo.beats[i]
    if (t < beat.hold) return { pose: beat.pose, beat: i }
    t -= beat.hold
    if (t < beat.move) {
      const next = demo.beats[(i + 1) % n]
      return { pose: lerpPose(beat.pose, next.pose, ease(t / beat.move)), beat: i }
    }
    t -= beat.move
  }
  return { pose: demo.beats[0].pose, beat: 0 }
}

/** The load's path over one rep, sampled — the line a good rep draws. */
export function loadPath(demo: MovementDemo, samples = 48): Pt[] {
  if (!demo.load) return []
  const total = cycleLength(demo)
  const out: Pt[] = []
  for (let i = 0; i <= samples; i++) {
    const at = solvePose(frameAt(demo, (i / samples) * total).pose, demo.load).load
    if (at) out.push(at)
  }
  return out
}
