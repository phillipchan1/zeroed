// Run: node --experimental-strip-types src/engine/tracks.check.ts
import {
  daysHitByTrack, formatSuperset, groupByTrack, suggestTrackName, wantsGeneralTrack,
} from './tracks.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

ok(suggestTrackName('Deadlift') === 'Lifting', 'deadlift → Lifting')
ok(suggestTrackName('Back Squat') === 'Lifting', 'squat → Lifting')
ok(suggestTrackName('Bench Press') === 'Lifting', 'bench → Lifting')
ok(suggestTrackName('Strict OHP') === 'Lifting', 'OHP → Lifting')
ok(suggestTrackName('Speed Bench') === 'Lifting', 'speed bench → Lifting')
ok(suggestTrackName('ATG Split Squat') === 'Mobility', 'split squat → Mobility, not Lifting')
ok(suggestTrackName('DB Bench') === 'Hypertrophy', 'DB bench → Hypertrophy')
ok(suggestTrackName('Landmine Press') === 'Hypertrophy', 'landmine → Hypertrophy')
ok(suggestTrackName('Barbell Row') === 'Hypertrophy', 'row → Hypertrophy')
ok(suggestTrackName('Assault Bike') === 'Conditioning', 'bike → Conditioning')
ok(suggestTrackName('Broad Jump') === 'Conditioning', 'jump → Conditioning')
ok(suggestTrackName('Lateral Bound') === 'Conditioning', 'bound → Conditioning')
ok(suggestTrackName('Sprint') === 'Conditioning', 'sprint → Conditioning')
ok(suggestTrackName('90/90') === 'Mobility', '90/90 → Mobility')
ok(suggestTrackName('Tib Raise') === 'Mobility', 'tib → Mobility')
ok(suggestTrackName('Reverse Nordic') === 'Mobility', 'nordic → Mobility')
ok(suggestTrackName('Band Walk', 'Basketball') === 'Basketball', 'session named basketball wins')
ok(suggestTrackName('Face Pull') === 'Hypertrophy', 'face pull → Hypertrophy')
ok(wantsGeneralTrack('active') && wantsGeneralTrack('draft') && wantsGeneralTrack('paused'), 'planned programs get General')
ok(!wantsGeneralTrack('external'), 'external / outside-plan programs do not get General')
ok(!wantsGeneralTrack(null) && !wantsGeneralTrack(undefined), 'missing status does not invent a program')

const lifting = { id: 't-lift', name: 'Lifting', color: '#5A8FB8', icon: 'dumbbell', order: 1 }
const cond = { id: 't-cond', name: 'Conditioning', color: '#D4A848', icon: 'zap', order: 2 }
const hyp = { id: 't-hyp', name: 'Hypertrophy', color: '#C4A882', icon: 'layers', order: 4 }
const friday = [
  { name: 'Broad Jump', track_id: 't-cond' },
  { name: 'Lateral Bound', track_id: 't-cond' },
  { name: 'Sprint', track_id: 't-cond' },
  { name: 'Strict OHP', track_id: 't-lift' },
  { name: 'Speed Bench', track_id: 't-lift' },
  { name: 'DB Bench', track_id: 't-hyp' },
]
const groups = groupByTrack(friday, [lifting, cond, hyp])
ok(groups.length === 3, `Friday groups into 3 tracks, got ${groups.length}`)
ok(groups[0].track?.name === 'Lifting' && groups[0].exercises.length === 2, 'Lifting first (order 1) with OHP + speed bench')
ok(groups[1].track?.name === 'Conditioning' && groups[1].exercises.length === 3, 'Conditioning keeps jump/bound/sprint')
ok(groups[2].track?.name === 'Hypertrophy', 'Hypertrophy last')
ok(formatSuperset('a1') === 'A1' && formatSuperset('nope') === null, 'superset A1/A2')

const days = daysHitByTrack(
  [
    { intendedDow: 1, exercises: [{ name: 'Deadlift', track_id: 't-lift' }, { name: 'Assault Bike', track_id: 't-cond' }] },
    { intendedDow: 4, exercises: friday },
  ],
  [lifting, cond, hyp],
)
ok(days['t-lift'].includes(1) && days['t-lift'].includes(4), 'Lifting hits Tue + Fri')
ok(days['t-cond'].includes(1) && days['t-cond'].includes(4), 'Conditioning hits Tue + Fri')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('tracks: ok')
