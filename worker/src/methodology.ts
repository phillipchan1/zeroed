/**
 * Methodology as config (G3, tracks_v1): the global, versioned ruleset
 * (methodology/v1.ts) plus this athlete's overrides (methodology_override),
 * resolved per request. The pure rules live in methodology/resolve.ts; this
 * file reads the rows, stamps versions, and serves the MCP tools:
 *
 *   get_methodology              effective params, the version, the overrides
 *   preview_methodology_override a kept preview (change_preview) of one path
 *   apply_methodology_override   confirm=true + preview_id (< 24 h, diff still
 *                                matching) + the athlete's approval (G10),
 *                                written and logged in change_log in one
 *                                transaction. app_coach never applies.
 *
 * Table and columns are hand-applied on Neon (worker/schema/methodology.sql).
 * Until they exist every read here is "no overrides" and the
 * version is the global one. With the flag off nothing here is called.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import type { NoRpeE1rm } from '../../src/engine/liftModel.ts'
import { asJson, jsonParam } from './db.ts'
import { tracksV1On, type OverrideActor } from './sessionOverride.ts'
import { authorizeWrite, commitAuthorized, previewFooter, storeChangePreview, type ChangeActor } from './changeLog.ts'
import { ruleRefsFrom } from './changeSummary.ts'
import { CURRENT_METHODOLOGY } from './methodology/v1.ts'
import {
  blockedRegions, checkOverride, engineParams, OVERRIDE_PATHS, resolveParams,
  type OverrideRecord, type Resolved,
} from './methodology/resolve.ts'
import { athleteAge, overrideAgeOf } from './ageStatus.ts'
import { seesHealth } from './regionStatus.ts'
import type { ConnectedStore } from './store.ts'
import { McpUserError } from './userError.ts'

export { blockedRegions, engineParams }
export type { Resolved }

const TOOL = 'apply_methodology_override'

function missingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return code === '42P01' || code === '42703'
}

export const methodologyUnavailable = 'Methodology overrides are not set up on this database yet. Nothing was written.'

/** A write that named a G3 table or column before worker/schema/methodology.sql was applied. */
export function methodologyMissing(e: unknown): boolean {
  return missingSchema(e) && /methodology|created_by|birth_date|voided_at/.test(String((e as { message?: string })?.message ?? ''))
}

// ---- reads ------------------------------------------------------------------------------------

export interface OverrideRow extends OverrideRecord {
  track: string | null
  methodology_version: string
  rationale: string | null
  rule_refs: string[]
  created_by: string
  created_at: string
  change_id: string
}

/** This athlete's active overrides, oldest first. Empty before the table exists. */
export async function loadOverrides(store: ConnectedStore): Promise<OverrideRow[]> {
  // Checked, not caught: this runs inside write transactions, where a failed
  // statement would abort the whole write.
  const [ready] = await store.sql<{ ok: boolean }[]>`SELECT to_regclass('public.methodology_override') IS NOT NULL AS ok`
  if (!ready?.ok) return []
  try {
    const rows = await store.sql<{
      id: string; track_id: string | null; track: string | null; path: string; value: unknown; methodology_version: string
      rationale: string | null; rule_refs: unknown; actor_type: string; actor_id: string; created_at: string; change_id: string
    }[]>`
      SELECT o.id::text AS id, o.track_id::text AS track_id, t.name AS track, o.path, o.value, o.methodology_version,
             o.rationale, o.rule_refs, o.actor_type, o.actor_id, to_json(o.created_at) #>> '{}' AS created_at,
             o.change_id::text AS change_id
      FROM methodology_override o
      LEFT JOIN track t ON t.id = o.track_id
      WHERE o.athlete_id = ${store.athleteId} AND o.superseded_at IS NULL
      ORDER BY o.created_at, o.id
    `
    return rows.map((r) => ({
      id: r.id,
      track_id: r.track_id,
      track: r.track,
      path: r.path,
      value: asJson<unknown>(r.value, null),
      methodology_version: r.methodology_version,
      rationale: r.rationale,
      rule_refs: asJson<string[]>(r.rule_refs, []),
      created_by: `${r.actor_type}:${r.actor_id}`,
      created_at: r.created_at,
      change_id: r.change_id,
    }))
  } catch (e) {
    if (missingSchema(e)) return []
    throw e
  }
}

/** Effective methodology for this athlete (and optionally one track). */
export async function resolveMethodology(store: ConnectedStore, opts: { trackId?: string | null } = {}): Promise<Resolved> {
  const [overrides, age] = await Promise.all([loadOverrides(store), athleteAge(store)])
  return resolveParams(CURRENT_METHODOLOGY, overrides, { trackId: opts.trackId ?? null, minor: age.minorRules })
}

/**
 * U4 (tracks_v1): how this athlete's RPE-less sets are estimated, for the
 * lift-model reads (get_lift_model, search_lifts). Undefined with the flag
 * off: the chart at RPE 10 and no method recorded, exactly as before.
 */
export async function e1rmFallbackFor(store: ConnectedStore): Promise<NoRpeE1rm | undefined> {
  if (!(await tracksV1On(store))) return undefined
  return (await resolveMethodology(store)).params.U4.e1rm_without_rpe === 'epley' ? 'epley' : 'rpe10_floor'
}

/** The version a write or a prescription ran on, for this athlete. */
export async function methodologyVersionFor(store: ConnectedStore): Promise<string> {
  return (await resolveMethodology(store)).version
}

async function ownedTrack(store: ConnectedStore, ref: string): Promise<{ id: string; name: string } | null> {
  const want = ref.trim()
  if (!want) return null
  const rows = await store.sql<{ id: string; name: string }[]>`
    SELECT t.id::text AS id, t.name
    FROM track t JOIN program p ON p.id = t.program_id
    WHERE p.athlete_id = ${store.athleteId}
      AND (t.id::text = ${want} OR lower(t.name) = lower(${want}))
    ORDER BY (p.status = 'active') DESC, t.sort_order
    LIMIT 1
  `
  return rows[0] ?? null
}

// ---- plan (preview and apply share it) ---------------------------------------------------------

interface OverrideRequest {
  path: string
  value: unknown
  clear: boolean
  track_id: string | null
  rule_refs: string[]
}

interface OverrideState {
  request: OverrideRequest
  base_version: string
  before: unknown
  after: unknown
  /** The active row this supersedes, if any. */
  replaces: string | null
}

async function planOverride(
  store: ConnectedStore,
  req: OverrideRequest,
  author: ChangeActor['type'],
): Promise<{ ok: true; state: OverrideState; track: string | null } | { ok: false; text: string }> {
  const [overrides, age] = await Promise.all([loadOverrides(store), athleteAge(store)])
  const sameScope = (o: OverrideRecord) => o.path === req.path && (o.track_id ?? null) === req.track_id
  const existing = overrides.find(sameScope) ?? null
  const opts = { trackId: req.track_id, minor: age.minorRules }
  const now = resolveParams(CURRENT_METHODOLOGY, overrides, opts)
  const withoutThis = resolveParams(CURRENT_METHODOLOGY, overrides.filter((o) => !sameScope(o)), opts)
  const check = checkOverride({
    path: req.path,
    value: req.value,
    clear: req.clear,
    trackId: req.track_id,
    now,
    withoutThis,
    minor: overrideAgeOf(age.status),
    actorType: author,
    exists: existing != null,
  })
  if (!check.ok) return check
  return {
    ok: true,
    track: existing?.track ?? null,
    state: {
      request: req,
      base_version: CURRENT_METHODOLOGY.version,
      before: check.before,
      after: check.after,
      replaces: existing?.id ?? null,
    },
  }
}

// ---- MCP ----------------------------------------------------------------------------------------

export const METHODOLOGY_TOOLS: McpTool[] = [
  {
    name: 'get_methodology',
    description: 'The coaching rules this athlete runs on (U1–U15 and the under-18 rules) as numbers: the effective params, the methodology version every prescription records, the athlete\'s overrides (who set them, why, which rules), and the paths a coach may propose overriding. Pass track for a track\'s effective params. Cite the U# in every rationale.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track id or name: include that track\'s overrides.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_methodology_override',
    description: 'Preview changing ONE methodology param for this athlete (or one track): e.g. path "U5.top_single_rpe" value [8, 8.5], "U4.tm_fraction" 0.88, "U7.regions.knee.blocked" true, or clear=true to go back to the default. Unknown paths and out-of-range values are refused; under-18 rules only tighten; a raised pain cap (U7.regions.<region>.raised_cap) is never allowed for a minor (or an athlete whose age is not on file) and never on a red-flagged region. Writes nothing; returns preview_id + diff. Apply with apply_methodology_override after the athlete approves.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dotted path, e.g. "U10.main_lift_rest_s" (get_methodology lists them).' },
        value: { description: 'A number, [low, high], or true/false, per the path.' },
        clear: { type: 'boolean', description: 'Remove the override on this path (back to the version default).' },
        track: { type: 'string', description: 'Track id or name, for paths that can be set per track.' },
        rationale: { type: 'string', description: 'Why, in the athlete\'s terms. Cite the rule (U#).' },
        rule_refs: { type: 'array', items: { type: 'string' }, description: 'Rules this rests on, e.g. ["U5"].' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_methodology_override',
    description: 'Write a previewed methodology override. Requires confirm=true, the preview_id (under 24 h old, diff unchanged) and approval_ref = the athlete\'s approval of that preview in the app (tap:<id> or msg:<id>; list_approvals(preview_id)). Applies once and is recorded in the change log. The in-app coach cannot apply.',
    inputSchema: {
      type: 'object',
      properties: {
        preview_id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        approval_ref: { type: 'string', description: 'tap:<approval id> or msg:<approval id> (from list_approvals).' },
      },
      required: ['preview_id', 'confirm', 'approval_ref'],
      additionalProperties: false,
    },
  },
]

export const METHODOLOGY_TOOL_NAMES = new Set(METHODOLOGY_TOOLS.map((t) => t.name))

function json(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

/** Per-region pain rules (U7.regions.<region>.*): which regions are capped or red-flagged is health data (D3). */
export function isHealthPath(path: string): boolean {
  return /^U7\.regions\./.test(path.trim())
}

/** What a coach without health access is told about a per-region pain rule, at preview and at apply. */
export const HEALTH_PATH_HIDDEN = 'Refused: per-region pain caps and red flags (U7.regions) are health data the athlete hasn\'t shared with you. This edit touches a region the athlete may have held for health reasons; ask the athlete.'

async function getMethodology(store: ConnectedStore, args: Record<string, unknown>, health: boolean): Promise<string> {
  let trackId: string | null = null
  if (typeof args.track === 'string' && args.track.trim()) {
    const t = await ownedTrack(store, args.track)
    if (!t) return `No track "${args.track}" on this athlete.`
    trackId = t.id
  }
  const [resolved, overrides, age] = await Promise.all([resolveMethodology(store, { trackId }), loadOverrides(store), athleteAge(store)])
  // D3: without health access, no per-region pain rules and no red-flagged regions.
  const params = health ? resolved.params : { ...resolved.params, U7: { ...resolved.params.U7, regions: {} } }
  const shown = health ? overrides : overrides.filter((o) => !isHealthPath(o.path))
  return json({
    methodology_version: resolved.version,
    base_version: resolved.base_version,
    under_18: overrideAgeOf(age.status),
    // Section 11b: an unknown age gets every under-18 rule until a birth date or an 18+ confirmation is on file.
    age_status: age.status,
    under_18_rules: resolved.minor,
    track_id: trackId,
    params,
    minors: resolved.minors,
    preview_ttl_hours: resolved.preview_ttl_hours,
    blocked_regions: health ? blockedRegions(resolved) : null,
    ...(health ? {} : { health_hidden: true }),
    overrides: shown.map((o) => ({
      id: o.id, path: o.path, value: o.value, track_id: o.track_id, track: o.track, set_against: o.methodology_version,
      rationale: o.rationale, rule_refs: o.rule_refs, created_by: o.created_by, created_at: o.created_at, change_id: o.change_id,
    })),
    overridable_paths: OVERRIDE_PATHS,
  })
}

async function previewOverride(store: ConnectedStore, args: Record<string, unknown>, actor: ChangeActor, health: boolean): Promise<string> {
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (!path) throw new McpUserError('path is required')
  // D3: the refusals and the before value would say whether that region is
  // capped or red-flagged. Refused the same way whatever its state.
  if (!health && isHealthPath(path)) return HEALTH_PATH_HIDDEN
  const clear = args.clear === true
  if (!clear && args.value === undefined) throw new McpUserError('value is required (or clear=true)')
  let trackId: string | null = null
  if (typeof args.track === 'string' && args.track.trim()) {
    const t = await ownedTrack(store, args.track)
    if (!t) return `Refused: no track "${args.track}" on this athlete.`
    trackId = t.id
  }
  const rationale = typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim().slice(0, 500) : null
  const request: OverrideRequest = {
    path,
    value: clear ? null : args.value,
    clear,
    track_id: trackId,
    rule_refs: ruleRefsFrom(rationale, args.rule_refs),
  }
  const plan = await planOverride(store, request, actor.type)
  if (!plan.ok) return plan.text
  const previewId = await storeChangePreview(store, actor, TOOL, plan.state, { rationale, targetId: path })
  return [
    '# Preview: methodology override',
    `${path}${trackId ? ` (track ${trackId})` : ''}: ${JSON.stringify(plan.state.before)} → ${JSON.stringify(plan.state.after)}${clear ? ' (back to the default)' : ''}`,
    'Nothing was written. Prescriptions keep running on the current methodology until this is applied.',
    '',
    json({ preview_id: previewId, diff: plan.state }),
    '',
    previewFooter(previewId),
  ].join('\n')
}

async function applyOverride(store: ConnectedStore, args: Record<string, unknown>, actor: ChangeActor, health: boolean): Promise<string> {
  if (args.confirm !== true) return 'Refused: apply_methodology_override requires confirm=true. Preview first, show the athlete, then apply.'
  const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
  if (!previewId) return 'Refused: preview_id is required. Call preview_methodology_override first.'
  const [p] = await store.sql<{ diff: unknown; actor_type: ChangeActor['type']; rationale: string | null }[]>`
    SELECT diff, actor_type, rationale FROM change_preview
    WHERE preview_id = ${previewId} AND athlete_id = ${store.athleteId} AND tool = ${TOOL}
    LIMIT 1
  `
  if (!p) return `Refused: no ${TOOL} preview with that id on this athlete. Preview again.`
  const stored = asJson<OverrideState | null>(p.diff, null)
  if (!stored?.request) return 'Refused: that preview is unreadable. Preview again.'
  // The toggle may have gone off since the preview: the same generic refusal, nothing written.
  if (!health && isHealthPath(stored.request.path)) return HEALTH_PATH_HIDDEN
  // Every guard again, against the athlete as they are now, as the preview's author.
  const plan = await planOverride(store, stored.request, p.actor_type)
  if (!plan.ok) return `${plan.text} Preview again.`
  const auth = await authorizeWrite(store, actor, TOOL, args, plan.state)
  if (!auth.ok) return auth.text
  const req = plan.state.request
  const changeId = crypto.randomUUID()
  const newId = req.clear ? null : crypto.randomUUID()
  try {
    return await commitAuthorized(store, actor, TOOL, auth, p.rationale, req.rule_refs, async () => {
      if (plan.state.replaces) {
        const done = await store.sql<{ id: string }[]>`
          UPDATE methodology_override SET superseded_at = NOW(), superseded_by = ${newId}
          WHERE id = ${plan.state.replaces} AND athlete_id = ${store.athleteId} AND superseded_at IS NULL
          RETURNING id
        `
        if (!done.length) throw new McpUserError('Refused: that override changed since the preview. Preview again.')
      }
      if (newId) {
        await store.sql`
          INSERT INTO methodology_override (
            id, athlete_id, track_id, methodology_version, path, value, rationale, rule_refs,
            actor_type, actor_id, approval_ref, approval_id, preview_id, change_id
          ) VALUES (
            ${newId}, ${store.athleteId}, ${req.track_id}, ${plan.state.base_version}, ${req.path},
            ${jsonParam(store.sql, req.value)}, ${p.rationale}, ${jsonParam(store.sql, req.rule_refs)},
            ${actor.type}, ${actor.id}, ${auth.approvalRef}, ${auth.approvalId}, ${auth.previewId}, ${changeId}
          )
        `
      }
      const version = await methodologyVersionFor(store)
      return {
        result: [
          `${req.clear ? 'Cleared' : 'Set'} ${req.path}${req.track_id ? ` for track ${req.track_id}` : ''}: ${JSON.stringify(plan.state.before)} → ${JSON.stringify(plan.state.after)}.`,
          `Prescriptions now run on methodology ${version}.`,
          `change_id: ${changeId}`,
        ].join('\n'),
        entry: {
          id: changeId,
          targetType: 'methodology',
          targetId: req.path,
          diff: {
            path: req.path,
            track_id: req.track_id,
            before: plan.state.before,
            after: plan.state.after,
            override_id: newId,
            superseded: plan.state.replaces,
            base_version: plan.state.base_version,
            methodology_version_after: version,
          },
          rationale: p.rationale,
        },
      }
    })
  } catch (e) {
    if (e instanceof McpUserError) return e.message
    throw e
  }
}

export async function runMethodologyTool(store: ConnectedStore, name: string, args: Record<string, unknown>, actor: OverrideActor): Promise<string> {
  if (!(await tracksV1On(store))) throw new McpUserError(`Unknown tool: ${name}`)
  const health = await seesHealth(store, actor)
  switch (name) {
    case 'get_methodology':
      return getMethodology(store, args, health)
    case 'preview_methodology_override':
      return previewOverride(store, args, actor, health)
    case 'apply_methodology_override':
      return applyOverride(store, args, actor, health)
    default:
      throw new McpUserError(`Unknown tool: ${name}`)
  }
}

