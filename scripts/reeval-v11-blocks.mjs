#!/usr/bin/env node
/**
 * One-time re-check of the U7 region blocks stored under methodology v1.1,
 * under v1.2 (spec section 11b). The job is worker/src/reevalV11Blocks.ts;
 * this is its operator runner. Production is reachable only over Neon's HTTP
 * SQL endpoint, so every query goes through that (POST https://<host>/sql).
 *
 *   DATABASE_URL=postgresql://… node scripts/reeval-v11-blocks.mjs           # dry run (default): reads, writes nothing
 *   DATABASE_URL=postgresql://… node scripts/reeval-v11-blocks.mjs --apply   # writes, all in ONE transaction (one batch)
 *
 * Order at deploy: worker/schema/ops/confirm-adult.sql first. Section 11b
 * gives an athlete with no age on file the under-18 rules, and this job never
 * lifts a block for one, so a known adult not yet confirmed would keep their
 * v1.1 blocks. Run the dry run, read the counts, then --apply once.
 *
 * Output is aggregate only: counts by region and totals. It never prints the
 * connection string, an athlete id, a rating, a note, a date or any other
 * health detail. Errors print the HTTP status / SQLSTATE only.
 *
 * Safe to run twice: each athlete it re-checks gets a marker row
 * (change_log apply_block_reeval_run) and is skipped from then on.
 * Rollback: every lifted block has its own change_log row (actor system); the
 * athlete's undo in Program → Changes makes it persistent again. Nothing is
 * deleted or edited, so there is nothing else to restore.
 */
import { fileURLToPath } from 'node:url'
import { applyReeval, formatSummary, neonHttpExecutor, planReeval } from '../worker/src/reevalV11Blocks.ts'

const USAGE = 'Usage: DATABASE_URL=… node scripts/reeval-v11-blocks.mjs [--apply]'

function redact(text, url) {
  let out = String(text ?? '')
  if (url) out = out.split(url).join('[redacted]')
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

/**
 * Run the job. `executor` is injectable (tests pass one over PGlite); by
 * default it is Neon's HTTP endpoint for DATABASE_URL. Returns the exit code.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line))
  const err = deps.error ?? ((line) => console.error(line))
  const unknown = argv.filter((a) => a !== '--apply')
  if (unknown.length) {
    err(USAGE)
    return 2
  }
  const apply = argv.includes('--apply')
  const url = String(env.DATABASE_URL ?? '').trim()
  if (!deps.executor && !url) {
    err(`Set DATABASE_URL. ${USAGE}`)
    return 2
  }
  try {
    const exec = deps.executor ?? neonHttpExecutor(url, deps.fetch)
    const plan = await planReeval(exec, deps.now ? { now: deps.now } : {})
    if (!apply) {
      log(formatSummary(plan, 'dry-run'))
      return 0
    }
    const applied = await applyReeval(exec, plan)
    log(formatSummary(plan, 'apply', applied))
    return 0
  } catch (e) {
    // The writes are one transaction: all of it landed or none of it. A dry run shows which.
    err(`reeval-v11-blocks: failed (${apply ? 'the batch is one transaction: all or nothing; dry-run again to see' : 'nothing written'}). ${redact(e instanceof Error ? e.message : e, url)}`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}
