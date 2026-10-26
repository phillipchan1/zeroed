// =============================================================================
// Coaching notes — the hardcoded "how do I do this?" library.
//
// Companion to exerciseLibrary.ts. That table owns how a movement is *measured*;
// this one owns how it's *performed* — a plain-language how-to plus the faults to
// watch for. Same doctrine: code-owned, closed table, resolved through the
// library's alias-aware lookup so "db rdl" and "Romanian Deadlift" land on the
// same note.
//
// This is the universal half. The program-specific half (why THIS lift is in
// YOUR program, and the one-line cue the coach wrote for it) lives on the
// exercise template (cue + insight) and is folded in at render time — together
// they give "how to do it and what to watch for, specific to my program."
//
// Coverage doesn't need to be exhaustive to be useful: a lift with no note just
// falls back to its program cue. The table grows by curating the movements the
// agent actually programs.
// =============================================================================

import { findLibraryExercise, normalizeName } from './exerciseLibrary'

export interface CoachingNote {
  howTo: string[]     // ordered setup / execution steps
  watchFor: string[]  // the common faults — what "off" looks like
}

// Keyed by the canonical library name (normalized). Aliases resolve via the
// library before lookup, so only the canonical name needs an entry.
const NOTES: Record<string, CoachingNote> = {
  // ── Squat & knee-dominant ────────────────────────────────────────────────
  'Back Squat': {
    howTo: [
      'Bar on your upper back (not your neck), feet shoulder-width, toes slightly out.',
      'Brace your trunk like you\'re about to take a punch, then break at the hips and knees together.',
      'Sit down between your hips until thighs reach at least parallel, knees tracking over your toes.',
      'Drive the whole foot through the floor and stand tall — hips and chest rising together.',
    ],
    watchFor: ['Heels lifting or weight rolling to the toes', 'Knees caving inward on the way up', 'Hips shooting up first, leaving the bar over your toes'],
  },
  'Front Squat': {
    howTo: [
      'Rack the bar on the front of your shoulders, elbows high and pointed forward.',
      'Brace hard, sit straight down keeping your torso as upright as you can.',
      'Reach depth with the elbows still up, then drive up tall.',
    ],
    watchFor: ['Elbows dropping (bar rolls forward)', 'Rounding the upper back', 'Heels coming off the floor'],
  },
  'Goblet Squat': {
    howTo: [
      'Hold a dumbbell or kettlebell against your chest, elbows tucked under it.',
      'Sit down between your knees, using the weight as a counterbalance.',
      'Keep the chest tall and drive up through mid-foot.',
    ],
    watchFor: ['Letting the chest collapse forward', 'Knees caving in', 'Bouncing out of the bottom'],
  },
  'Bulgarian Split Squat': {
    howTo: [
      'Rear foot up on a bench, front foot a stride ahead, most of your weight on the front leg.',
      'Lower straight down until the front thigh is about parallel, back knee dropping toward the floor.',
      'Drive through the front heel to stand; the back leg only balances.',
    ],
    watchFor: ['Pushing off the back foot instead of loading the front leg', 'Front knee caving in', 'Leaning the torso too far forward'],
  },
  'Walking Lunge': {
    howTo: [
      'Step forward into a long stride, both knees bending to about 90°.',
      'Keep your torso tall and the front shin roughly vertical.',
      'Drive through the front heel to step the back foot through into the next lunge.',
    ],
    watchFor: ['Front knee drifting past the toes / caving in', 'Short, choppy steps', 'Trunk collapsing forward'],
  },
  'Step-Up': {
    howTo: [
      'Plant the whole working foot on a knee-height box.',
      'Drive through that heel to stand tall on top — minimal push from the bottom foot.',
      'Lower under control, tapping the floor lightly before the next rep.',
    ],
    watchFor: ['Pushing off the trailing foot to cheat up', 'Knee caving in', 'Crashing back down instead of lowering'],
  },
  'Leg Press': {
    howTo: [
      'Feet shoulder-width on the platform, mid-foot, back and hips flat against the pad.',
      'Lower until your knees reach about 90°, keeping your lower back down.',
      'Press through the whole foot without locking the knees hard at the top.',
    ],
    watchFor: ['Lower back rounding off the pad at the bottom', 'Knees caving in', 'Snapping the knees into full lockout'],
  },

  // ── Hinge & posterior chain ──────────────────────────────────────────────
  'Deadlift': {
    howTo: [
      'Bar over mid-foot, shins close, grip just outside your legs.',
      'Take the slack out of the bar, brace, and set a flat back with hips between knees and shoulders.',
      'Push the floor away and stand tall, keeping the bar dragging up your legs.',
      'Lock out by squeezing the glutes — don\'t lean back.',
    ],
    watchFor: ['Lower back rounding', 'Hips shooting up before the bar moves', 'Bar drifting away from your shins'],
  },
  'Trap Bar Deadlift': {
    howTo: [
      'Stand in the center of the bar, grip the handles, shins close to vertical.',
      'Brace, flatten the back, and drive the floor away.',
      'Stand tall and squeeze the glutes at the top.',
    ],
    watchFor: ['Rounding the back', 'Hips rising faster than the chest', 'Yanking the bar off the floor'],
  },
  'Romanian Deadlift': {
    howTo: [
      'Start standing tall with the bar against your thighs, soft knees.',
      'Push your hips straight back, sliding the bar down your legs.',
      'Feel a strong hamstring stretch around mid-shin, then drive the hips forward to stand.',
    ],
    watchFor: ['Rounding the lower back', 'Turning it into a squat (knees travelling forward)', 'Bar drifting away from the legs'],
  },
  'Single-Leg RDL': {
    howTo: [
      'Balance on one leg, soft knee, the other leg extending back as a counterweight.',
      'Hinge at the hip, lowering the weight while the back leg lifts in line with your torso.',
      'Keep your hips square to the floor, then return to standing tall.',
    ],
    watchFor: ['Hips rotating open', 'Rounding the back', 'Wobbling — go lighter and slower for balance'],
  },
  'Hip Thrust': {
    howTo: [
      'Shoulder blades on a bench, bar across the hips, feet flat and shin vertical at the top.',
      'Drive through your heels and squeeze your glutes to lift until the torso is parallel to the floor.',
      'Pause at the top with ribs down, then lower under control.',
    ],
    watchFor: ['Arching the lower back instead of squeezing glutes', 'Pushing through the toes', 'Not reaching full hip extension'],
  },
  'Glute Bridge': {
    howTo: [
      'Lie on your back, feet flat and close to your hips.',
      'Press through your heels and squeeze your glutes to lift the hips.',
      'Hold the squeeze a beat at the top, then lower slowly.',
    ],
    watchFor: ['Arching the lower back to gain height', 'Pushing through the toes', 'Rushing the reps'],
  },
  'Kettlebell Swing': {
    howTo: [
      'Hike the bell back between your legs like a snap pass.',
      'Snap your hips forward hard — the float of the bell comes from the hips, not the arms.',
      'Let it swing to about chest height, then guide it back into the next hinge.',
    ],
    watchFor: ['Squatting it instead of hinging', 'Using the arms to lift the bell', 'Rounding the back at the bottom'],
  },
  'Nordic Curl': {
    howTo: [
      'Kneel with your ankles anchored, body straight from knee to head.',
      'Lower forward as slowly as you can, resisting with the hamstrings.',
      'Catch yourself with your hands, then push back to the start.',
    ],
    watchFor: ['Bending at the hips to cheat (keep a straight line)', 'Dropping fast instead of resisting', 'Doing too many reps — these are brutal, start with low volume'],
  },
  'Good Morning': {
    howTo: [
      'Bar on your upper back, soft knees, feet hip-width.',
      'Hinge at the hips, pushing them back while keeping a flat back.',
      'Stop when you feel the hamstrings load, then drive the hips back to standing.',
    ],
    watchFor: ['Rounding the back', 'Going too heavy — this is a hinge feel, not a max lift', 'Squatting instead of hinging'],
  },
  'Back Extension': {
    howTo: [
      'Hips on the pad, anchor your feet, start folded at the hips.',
      'Extend until your body forms a straight line — squeeze the glutes, don\'t crank the lower back.',
      'Lower under control.',
    ],
    watchFor: ['Hyperextending the spine at the top', 'Using momentum', 'Leading with the lower back instead of the hips/glutes'],
  },

  // ── Press ────────────────────────────────────────────────────────────────
  'Bench Press': {
    howTo: [
      'Eyes under the bar, shoulder blades pinned back and down, slight arch, feet planted.',
      'Unrack and lower the bar to your lower chest with elbows about 45° from your body.',
      'Touch lightly, then press up and slightly back toward your face to lockout.',
    ],
    watchFor: ['Elbows flaring straight out to 90° (shoulder strain)', 'Bouncing the bar off the chest', 'Hips lifting off the bench'],
  },
  'DB Bench Press': {
    howTo: [
      'Dumbbells over your chest, shoulder blades set, feet planted.',
      'Lower until your elbows are just below the bench, forearms vertical.',
      'Press up and slightly together without clanging the bells.',
    ],
    watchFor: ['Elbows flaring out', 'Letting the dumbbells drift over your face', 'Losing the shoulder-blade set'],
  },
  'Incline Bench Press': {
    howTo: [
      'Set the bench to about 30°, shoulder blades pinned, feet planted.',
      'Lower the bar to your upper chest / collarbone line.',
      'Press up over your shoulders.',
    ],
    watchFor: ['Bench set too steep (turns into a shoulder press)', 'Elbows flaring', 'Bouncing off the chest'],
  },
  'Overhead Press': {
    howTo: [
      'Bar on your front shoulders, grip just outside the shoulders, brace your trunk and squeeze your glutes.',
      'Press straight up, moving your head back slightly to clear the bar.',
      'Lock out with the bar over the middle of your foot, ribs down.',
    ],
    watchFor: ['Leaning back / over-arching the lower back', 'Pressing the bar around your face instead of up', 'Flaring the ribs'],
  },
  'DB Shoulder Press': {
    howTo: [
      'Dumbbells at shoulder height, palms forward, brace your trunk.',
      'Press overhead until the arms are straight, bells finishing over the shoulders.',
      'Lower under control to shoulder height.',
    ],
    watchFor: ['Arching the lower back', 'Pressing the bells out in front instead of up', 'Half-repping the lockout'],
  },
  'Push Press': {
    howTo: [
      'Start like an overhead press, then dip a few inches at the knees.',
      'Drive up explosively with the legs and use that momentum to punch the bar overhead.',
      'Lock out with the bar over mid-foot, then lower to the shoulders.',
    ],
    watchFor: ['Dipping too deep (it becomes a squat)', 'Leaning back', 'Dip and drive not connected — keep it one smooth move'],
  },
  'Push-Up': {
    howTo: [
      'Hands just wider than the shoulders, body a straight line from head to heels.',
      'Lower until your chest is just off the floor, elbows about 45° from your sides.',
      'Press the floor away and keep your trunk rigid the whole time.',
    ],
    watchFor: ['Hips sagging or piking up', 'Elbows flaring straight out', 'Only doing half the range'],
  },
  'Dip': {
    howTo: [
      'Support yourself on the bars, arms straight, slight forward lean.',
      'Lower until your shoulders are roughly level with your elbows.',
      'Press back up to straight arms without shrugging.',
    ],
    watchFor: ['Going too deep (shoulder strain)', 'Shrugging the shoulders up', 'Swinging / using momentum'],
  },

  // ── Pull ─────────────────────────────────────────────────────────────────
  'Pull-Up': {
    howTo: [
      'Hang from the bar, hands just wider than shoulders, start by pulling your shoulder blades down.',
      'Drive your elbows down to your ribs, pulling your chest toward the bar.',
      'Chin over the bar, then lower all the way to a full hang under control.',
    ],
    watchFor: ['Kipping / swinging to cheat reps', 'Not reaching a full hang at the bottom', 'Shrugging instead of leading with the back'],
  },
  'Chin-Up': {
    howTo: [
      'Underhand grip, shoulder-width, start from a full hang.',
      'Pull your chest to the bar by driving the elbows down.',
      'Lower all the way under control.',
    ],
    watchFor: ['Swinging for momentum', 'Half-repping the bottom', 'Letting the shoulders roll forward'],
  },
  'Lat Pulldown': {
    howTo: [
      'Grip just wider than shoulders, sit tall with a slight lean back.',
      'Pull the bar to your upper chest by driving your elbows down and back.',
      'Control the bar back up to a full stretch.',
    ],
    watchFor: ['Leaning way back and heaving with momentum', 'Pulling behind the neck', 'Shrugging instead of using the lats'],
  },
  'Barbell Row': {
    howTo: [
      'Hinge to about 45°, flat back, bar hanging at arm\'s length.',
      'Pull the bar to your lower ribs / belly, leading with the elbows.',
      'Lower under control without rounding the back.',
    ],
    watchFor: ['Standing up / using the lower back to heave', 'Rounding the spine', 'Yanking with the arms instead of the back'],
  },
  'DB Row': {
    howTo: [
      'One hand and knee on a bench, flat back, dumbbell hanging straight down.',
      'Row the bell to your hip, driving the elbow up and back.',
      'Lower to a full stretch; keep your torso still.',
    ],
    watchFor: ['Rotating the torso to throw the weight up', 'Shrugging the shoulder', 'Cutting the range short'],
  },
  'Chest-Supported Row': {
    howTo: [
      'Chest on the pad, let the weight hang at arm\'s length.',
      'Row to your ribs, squeezing the shoulder blades together.',
      'Lower to a full stretch under control.',
    ],
    watchFor: ['Peeling the chest off the pad to cheat', 'Shrugging', 'Half-repping the stretch'],
  },
  'Cable Row': {
    howTo: [
      'Sit tall, slight knee bend, chest up, arms extended.',
      'Pull the handle to your belly, driving the elbows back and squeezing the blades.',
      'Return to a full stretch without slumping.',
    ],
    watchFor: ['Rowing with the lower back (big rock back and forth)', 'Shrugging', 'Letting the shoulders round forward at the stretch'],
  },
  'Inverted Row': {
    howTo: [
      'Under a bar, body straight, heels on the floor, hands shoulder-width.',
      'Pull your chest to the bar, keeping your body rigid as one plank.',
      'Lower to straight arms under control.',
    ],
    watchFor: ['Hips sagging', 'Not touching / reaching the chest to the bar', 'Jerking up with momentum'],
  },
  'Face Pull': {
    howTo: [
      'Cable or band at face height, palms in.',
      'Pull toward your forehead, splitting your hands apart and rotating so your knuckles finish facing back.',
      'Squeeze the rear delts, then return slow.',
    ],
    watchFor: ['Using too much weight and turning it into a row', 'Shrugging the traps', 'Rushing the reps — these want control'],
  },
  'Band Pull-Apart': {
    howTo: [
      'Hold a band at shoulder height, arms straight out front.',
      'Pull the band apart to your chest, squeezing the shoulder blades.',
      'Return slowly with control.',
    ],
    watchFor: ['Bending the elbows', 'Shrugging the shoulders up', 'Letting it snap back'],
  },

  // ── Arms & delts ─────────────────────────────────────────────────────────
  'Bicep Curl': {
    howTo: [
      'Stand tall, elbows pinned to your sides.',
      'Curl the weight up by bending only at the elbow.',
      'Lower all the way down under control.',
    ],
    watchFor: ['Swinging the body / elbows drifting forward', 'Using momentum', 'Cutting the bottom range short'],
  },
  'Tricep Extension': {
    howTo: [
      'Keep your upper arm still, elbow pointing forward (or up for overhead).',
      'Extend at the elbow to straight, squeezing the triceps.',
      'Lower under control to a stretch.',
    ],
    watchFor: ['The whole arm swinging instead of just the forearm', 'Flaring the elbows out', 'Going too heavy and losing the elbow position'],
  },
  'Lateral Raise': {
    howTo: [
      'Slight forward lean, soft elbows, dumbbells at your sides.',
      'Raise out to the sides to about shoulder height, leading with the elbows.',
      'Lower slowly — this is a small muscle, control beats weight.',
    ],
    watchFor: ['Heaving with momentum / shrugging', 'Raising above shoulder height', 'Going too heavy'],
  },
  'Rear Delt Fly': {
    howTo: [
      'Hinge forward, soft elbows, dumbbells hanging down.',
      'Raise out to the sides, leading with the elbows and squeezing the rear delts.',
      'Lower slow and controlled.',
    ],
    watchFor: ['Turning it into a row (pulling to the hips)', 'Using momentum', 'Shrugging the traps'],
  },
  'DB External Rotation': {
    howTo: [
      'Elbow pinned to your side at 90°, forearm across your body.',
      'Rotate the forearm outward, keeping the elbow glued to your side.',
      'Return slow — light weight only.',
    ],
    watchFor: ['Letting the elbow drift off your side', 'Using too much weight', 'Rushing — this is a control drill, not a strength lift'],
  },

  // ── Core / trunk ─────────────────────────────────────────────────────────
  'Plank': {
    howTo: [
      'Forearms under your shoulders, body a straight line from head to heels.',
      'Squeeze your glutes and brace your abs, tuck the ribs down.',
      'Breathe normally and hold the line.',
    ],
    watchFor: ['Hips sagging', 'Butt piking up', 'Holding your breath / letting the lower back arch'],
  },
  'Side Plank': {
    howTo: [
      'On your side, forearm under your shoulder, body in a straight line.',
      'Lift the hips so you\'re supported on the forearm and the side of the foot.',
      'Hold tall, hips stacked, then switch sides.',
    ],
    watchFor: ['Hips dropping toward the floor', 'Rotating the torso', 'Shoulder shrugging into the ear'],
  },
  'Copenhagen Plank': {
    howTo: [
      'Side plank with the top leg resting on a bench, ankle or knee supported.',
      'Lift your hips and the bottom leg up toward the bench.',
      'Hold a straight line; start with the knee bent on the bench to scale it.',
    ],
    watchFor: ['Hips sagging', 'Going to a full-length version too soon', 'Rotating forward or back'],
  },
  'Dead Bug': {
    howTo: [
      'On your back, arms straight up, knees bent over your hips.',
      'Press your lower back flat into the floor and brace.',
      'Slowly lower the opposite arm and leg, then return without letting the back arch.',
    ],
    watchFor: ['Lower back lifting off the floor', 'Rushing the reps', 'Holding your breath'],
  },
  'Bird Dog': {
    howTo: [
      'On hands and knees, flat back, braced trunk.',
      'Reach the opposite arm and leg out long until they\'re in line with your torso.',
      'Hold a beat, return with control, keeping your hips level the whole time.',
    ],
    watchFor: ['Hips rotating / tilting', 'Arching the lower back', 'Rushing instead of controlling each rep'],
  },
  'Pallof Press': {
    howTo: [
      'Stand side-on to a cable or band at chest height, hands at your sternum.',
      'Press your hands straight out and resist the pull trying to rotate you.',
      'Hold, then return to your chest — keep your hips and shoulders square.',
    ],
    watchFor: ['Letting your torso rotate toward the anchor', 'Holding your breath', 'Using the arms instead of bracing the trunk'],
  },
  'Hollow Body Hold': {
    howTo: [
      'On your back, press your lower back flat into the floor.',
      'Lift your shoulders and legs off the floor into a shallow banana shape.',
      'Reach arms overhead to make it harder; tuck the knees to make it easier.',
    ],
    watchFor: ['Lower back arching off the floor', 'Holding your breath', 'Going to the hardest version before you can keep the back flat'],
  },
  'Hanging Leg Raise': {
    howTo: [
      'Hang from a bar, shoulders active (not a dead hang).',
      'Raise your legs by curling the pelvis up, not just lifting the thighs.',
      'Lower slowly without swinging.',
    ],
    watchFor: ['Swinging for momentum', 'Only lifting from the hips with no pelvic curl', 'Dropping fast at the bottom'],
  },
  'Ab Wheel': {
    howTo: [
      'Kneel holding the wheel, brace your abs and tuck your ribs.',
      'Roll out as far as you can keep a flat, braced trunk.',
      'Pull back with your abs — start with a short range and build.',
    ],
    watchFor: ['Lower back sagging / arching as you roll out', 'Rolling out further than you can control', 'Pulling with the hips instead of the abs'],
  },

  // ── Carries / conditioning ───────────────────────────────────────────────
  'Farmer Carry': {
    howTo: [
      'Pick up a heavy weight in each hand with a flat back.',
      'Stand tall, shoulders back, ribs down, and walk with controlled steps.',
      'Keep the weights from swinging and breathe.',
    ],
    watchFor: ['Leaning to one side', 'Shrugging or letting the shoulders round forward', 'Rushing / short choppy steps'],
  },
}

// Build the lookup once, normalizing keys so render-time lookups are O(1).
const NOTE_LOOKUP = new Map<string, CoachingNote>()
for (const [name, note] of Object.entries(NOTES)) {
  NOTE_LOOKUP.set(normalizeName(name), note)
}

/**
 * Resolve the how-to note for an exercise. Goes through the library first so
 * aliases ("db rdl", "sumo deadlift") collapse onto the canonical entry. Returns
 * null when we have no note yet — the caller falls back to the program cue.
 */
export function getCoachingNote(name: string): CoachingNote | null {
  const lib = findLibraryExercise(name)
  if (!lib) return NOTE_LOOKUP.get(normalizeName(name)) ?? null
  // A split-off variant (Hammer Curl, DB RDL) borrows its parent's note until it
  // has one of its own.
  return NOTE_LOOKUP.get(normalizeName(lib.name))
    ?? (lib.noteAs ? NOTE_LOOKUP.get(normalizeName(lib.noteAs)) : undefined)
    ?? null
}
