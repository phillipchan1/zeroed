// change_log's pure half: rule refs, who, and the one-line summary the feed shows.
// Run: node --experimental-strip-types worker/src/changeSummary.check.ts

import { actorLabel, ruleRefsFrom, summarizeChange } from './changeSummary.ts'

const fails: string[] = []
let checks = 0
function eq(actual: unknown, expected: unknown, msg: string) {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fails.push(`${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

eq(ruleRefsFrom('All sets ≤ RPE 7 two weeks running → +5 lb (U5). Keep U13 in mind; U5 again.'), ['U5', 'U13'], 'rule refs: from the rationale, deduped, in rule order')
eq(ruleRefsFrom(null, ['u2', 'U16', 'x', 'U11']), ['U2', 'U11'], 'rule refs: explicit, normalized, out-of-range dropped')
eq(ruleRefsFrom('BU5 and U50 are not rules'), [], 'rule refs: whole tokens only')

eq(actorLabel('athlete'), 'You', 'who: athlete')
eq(actorLabel('mcp'), 'Claude', 'who: a coach via MCP')
eq(actorLabel('mcp', 'Coach Sam'), 'Coach Sam', 'who: a named coach token')
eq(actorLabel('app_coach'), 'Coach', 'who: the in-app coach')
eq(actorLabel('system'), 'System', 'who: system')

eq(summarizeChange({ tool: 'set_training_max', target_type: 'training_max', diff: { lift: 'squat', before: { value: 300 }, after: { value: 315 } } }), 'Squat training max: 300 → 315', 'summary: TM')
eq(summarizeChange({ tool: 'set_training_max', target_type: 'training_max', diff: { lift: 'bench', before: null, after: { value: 200 } } }), 'Bench training max: auto → 200', 'summary: TM from the model')
eq(summarizeChange({
  tool: 'apply_program_edits', target_type: 'program',
  diff: { revision: { sessions: [{ name: 'Upper', changes: [{ kind: 'changed', name: 'Bench Press' }, { kind: 'added', name: 'Face Pull' }, { kind: 'kept', name: 'Row' }] }] } },
}), '~ Bench Press, + Face Pull (Upper)', 'summary: program edit lists what moved, not what stayed')
eq(summarizeChange({
  tool: 'apply_session_override', target_type: 'session_override',
  diff: { sessions: [{ label: 'Upper · Thu 5 Nov', changes: [{ kind: 'removed', name: 'Plank' }] }] },
}), 'This week only: − Plank (Upper · Thu 5 Nov)', 'summary: week-only override')
eq(summarizeChange({ tool: 'update_track', target_type: 'track', diff: { before: { name: 'Speed', purpose: 'a' }, after: { name: 'Speed', purpose: 'b' } } }), 'Updated the Speed track: purpose', 'summary: track fields that changed')
eq(summarizeChange({ tool: 'revert_change', target_type: 'track', diff: { undid: 'Updated the Speed track: purpose' } }), 'Undid: Updated the Speed track: purpose', 'summary: an undo names what it undid')
eq(summarizeChange({ tool: 'revert_change', target_type: 'track', diff: { undid: 'Updated the Speed track: purpose', direction: 'redo' } }), 'Redid: Updated the Speed track: purpose', 'summary: a redo names what it re-applied')
eq(summarizeChange({ tool: 'apply_block_reeval', target_type: 'region', diff: { region: 'low_back', after: { status: 'ok', block: 'temporary' } } }), 'Low back re-checked under v1.2: no clinician clear needed (off until next session)', 'summary: the v1.2 re-check, still temporary')
eq(summarizeChange({ tool: 'apply_block_reeval', target_type: 'region', diff: { region: 'knee', after: { status: 'ok', block: null } } }), 'Knee re-checked under v1.2: no clinician clear needed', 'summary: the v1.2 re-check, unblocked')
eq(summarizeChange({ tool: 'apply_block_reeval_run', target_type: 'region', diff: { kept: 2, lifted: 1 } }), 'Re-checked stored pain blocks under methodology v1.2: 2 kept, 1 lifted', 'summary: the re-check marker')
eq(summarizeChange({ tool: 'add_workout_note', target_type: 'workout_note', diff: { text: 'x'.repeat(200) } }).length, 90, 'summary: clipped to one line')

console.log(`${checks} checks, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.error('  FAIL', f)
  process.exit(1)
}
console.log('change summary: ok')
