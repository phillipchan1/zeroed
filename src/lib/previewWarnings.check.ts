// Validator warnings in the app (tracks_v1, G5): the Worker's list read
// defensively, refusals first; flag off renders nothing whatever the payload;
// targets read plainly; and the cards only show them under tracksOn().
// Synthetic exercises only.
// Run: node --experimental-strip-types src/lib/previewWarnings.check.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proposalWarnings, readWarnings, refusalTitle, RULE_LABEL, targetParts, warningsView } from './previewWarnings.ts'

const fails: string[] = []
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}

const u8 = { rule: 'U8', message: 'Box Jump comes after Back Squat; speed work goes first.', target: 'Lower · Box Jump' }
const u9 = { rule: 'U9', message: 'HIIT the day before heavy legs.', target: 'Engine → Lower' }
const u7 = { rule: 'U7', message: 'Red flag: knee is blocked until a clinician clears it.', target: 'Lower · Split Squat', blocking: true }
const u13 = { rule: 'U13', message: 'This edit changes 4 of the week\'s 10 exercises.', target: 'week', blocking: true }

// ---- reading ----------------------------------------------------------------------------------
ok(readWarnings(null).length === 0 && readWarnings({}).length === 0 && readWarnings('x').length === 0, 'read: not a list → none')
ok(readWarnings([u8, { rule: 'U2', message: 'x', target: 'y' }, { rule: 'U8' }, { rule: 'U9', message: '   ' }, 7]).length === 1, 'read: unknown rules, missing and blank messages dropped')
const mixed = readWarnings([u8, u7, u9])
ok(mixed[0].rule === 'U7' && mixed.map((w) => w.rule).join() === 'U7,U8,U9', 'read: refusal first, then the Worker\'s order')
ok(readWarnings([{ ...u8, blocking: 'yes' }])[0].blocking === undefined, 'read: only blocking === true blocks')
ok(readWarnings([{ rule: 'U10', message: 'x' }])[0].target === '', 'read: a missing target reads as empty')

// ---- view -------------------------------------------------------------------------------------
const off = warningsView([u8, u7], false)
ok(off.refusal == null && off.notes.length === 0, 'flag off: nothing to render')
const on = warningsView([u8, u7, u9], true)
ok(on.refusal?.rule === 'U7' && on.notes.map((w) => w.rule).join() === 'U8,U9', 'flag on: the refusal apart, the rest as notes')
ok(warningsView([u13, u7], true).notes.length === 1, 'flag on: one refusal shown as the refusal, a second as a note')
ok(proposalWarnings({ sessions: [], warnings: [u8] }, true).notes.length === 1, 'proposal: diff.warnings is read')
ok(proposalWarnings({ sessions: [] }, true).notes.length === 0 && proposalWarnings(null, true).notes.length === 0, 'proposal: no warnings key → nothing')
ok(proposalWarnings({ warnings: [u8] }, false).notes.length === 0, 'proposal: flag off → nothing')

// ---- wording ----------------------------------------------------------------------------------
ok(JSON.stringify(targetParts('Lower · Box Jump')) === JSON.stringify({ session: 'Lower', exercise: 'Box Jump', label: 'Box Jump (Lower)' }), 'target: session · exercise')
ok(targetParts('week').label === 'The whole week' && targetParts('').label === 'The whole week', 'target: the week')
ok(targetParts('Engine → Lower').label === 'Engine → Lower', 'target: a U9 pair reads as is')
ok(refusalTitle(readWarnings([u7])[0]) === 'Refused: red flag' && refusalTitle(readWarnings([u13])[0]).includes('small edit'), 'refusal: U7 and U13 titled plainly')
ok(Object.keys(RULE_LABEL).join() === 'U7,U8,U9,U10,U13', 'labels: every validated rule has one')

// ---- wiring: flag off unchanged -----------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const cardSrc = readFileSync(join(here, '../screens/loop/ProposalCard.tsx'), 'utf8')
const feedSrc = readFileSync(join(here, '../screens/loop/ChangesFeed.tsx'), 'utf8')
ok(/proposalWarnings\(proposal\.diff, tracksOn\(\)\)/.test(cardSrc), 'flag off: ProposalCard reads warnings only under tracksOn()')
ok(/\{phase === 'pending' && <PreviewWarnings view=\{warnings\} \/>\}/.test(cardSrc), 'ProposalCard: warnings show while the proposal is pending')
ok(/warningsView\(res\.warnings, tracksOn\(\)\)/.test(feedSrc), 'flag off: the Undo refusal reads warnings only under tracksOn()')
ok(/refusal\?\.refusal\s*\? <PreviewWarnings view=\{refusal\} \/>\s*: message && <p className="change__message">\{message\}<\/p>/.test(feedSrc), 'ChangesFeed: without a structured refusal, the message shows as before')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`)
  process.exit(1)
}
