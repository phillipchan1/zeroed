// Print the lift model for the signed-in athlete, straight from the live log —
// the same text get_lift_model returns, without going through Claude.
//
//   npm run lift-model              # all four main lifts
//   npm run lift-model -- ohp       # one
//
// Auth comes from mcp/.env exactly as the MCP server's does (see mcp/README.md).

import { MAIN_LIFTS, modelFromSources, parseLiftId, renderLiftModel, type MainLiftId } from '../../src/engine/liftModel.ts'
import { loadEnvFiles } from './env.ts'
import { connectStore, loadLiftModelSources, pingStore } from './store.ts'

loadEnvFiles()

const arg = process.argv[2]
const lifts: MainLiftId[] = !arg || arg === 'all' ? [...MAIN_LIFTS] : [parseLiftId(arg)].filter((l): l is MainLiftId => !!l)
if (!lifts.length) {
  console.error(`"${arg}" is not a main lift. Use squat, bench, deadlift, ohp, or all.`)
  process.exit(1)
}

const store = await connectStore()
console.log(await pingStore())
const src = await loadLiftModelSources(store)
console.log(`${src.workouts.length} logged sessions read · today ${src.today} · phase ${src.phaseName ?? 'none'}\n`)
console.log(lifts.map((l) => renderLiftModel(modelFromSources(l, src))).join('\n\n---\n\n'))
