/**
 * skill_blocks_v1 (spec §12) on the Worker: coaches can prescribe the skill
 * block exercise kind, so a station whose target is makes / possessions /
 * per side isn't forced back into interval syntax.
 *
 * Its own flag in athlete.flags, default off for everyone, independent of
 * tracks_v1 and coach_v1. No migration: `kind` and `window_s` live in the
 * routine's exercises JSON next to rest_s and contacts.
 *
 * With the flag off for an athlete, their coach's tool list is exactly as
 * before (no new properties), and `kind` / `window_s` sent anyway are dropped
 * at the door, as an unknown property always was. /api/session-rx is not
 * touched either way: the Worker computes the same prescription, and the app
 * decides which UI a station gets.
 *
 * Rollback: UPDATE athlete SET flags = flags - 'skill_blocks_v1';
 * Exercises already tagged keep the key in their JSON, and with the flag off
 * nothing reads it.
 */
import type { McpTool } from '../../supabase/functions/_shared/mcpProtocol.ts'
import type { ConnectedStore } from './store.ts'

export const SKILL_BLOCKS_FLAG = 'skill_blocks_v1'

export async function skillBlocksV1On(store: ConnectedStore): Promise<boolean> {
  const [row] = await store.sql<{ on: boolean | null }[]>`
    SELECT (flags->'skill_blocks_v1') = 'true'::jsonb AS on FROM athlete WHERE id = ${store.athleteId}
  `
  return row?.on === true
}

const SKILL_PROPS = {
  kind: {
    type: ['string', 'null'],
    enum: ['skill', 'interval', null],
    description: 'Exercise kind. "skill": a station whose target is quality — reps like "6 makes", "4/side", "8 possessions" — that the athlete advances with Done / Next; never put interval syntax on it. rest_s is then a suggested rest, shown as copy. "interval": conditioning on the interval timer (HIIT, Tabata, timed work/rest). Omit for straight sets.',
  },
  window_s: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 7200,
    description: 'Skill block only: a suggested window for the station in seconds (480 = ~8 min). Shown, never enforced.',
  },
} as const

const EDIT_TOOLS = new Set(['preview_program_edits', 'apply_program_edits'])

type Schema = { properties?: Record<string, unknown> } & Record<string, unknown>

function withProps(schema: Schema): Schema {
  return { ...schema, properties: { ...schema.properties, ...SKILL_PROPS } }
}

/** The edit tools as a skill_blocks_v1 athlete's coach sees them: kind and window_s on every exercise. */
export function withSkillArgs(tool: McpTool): McpTool {
  if (!EDIT_TOOLS.has(tool.name)) return tool
  const schema = tool.inputSchema as Schema
  const edits = schema.properties?.edits as { items?: Schema } & Record<string, unknown> | undefined
  if (!edits?.items) return tool
  const item = withProps(edits.items)
  const exercises = item.properties?.exercises as { items?: Schema } & Record<string, unknown> | undefined
  const nested = exercises?.items ? { ...exercises, items: withProps(exercises.items) } : exercises
  return {
    ...tool,
    description: `${tool.description} A skill or technique station (makes, possessions, per side) is kind "skill", not interval syntax.`,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        edits: { ...edits, items: { ...item, properties: { ...item.properties, ...(nested ? { exercises: nested } : {}) } } },
      },
    },
  }
}

function strip<T>(o: T): T {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o
  const { kind: _k, window_s: _w, ...rest } = o as Record<string, unknown>
  void _k
  void _w
  return rest as T
}

/**
 * The edits as this athlete's flag allows them. Off: `kind` and `window_s`
 * removed from every edit and every nested exercise, so the preview, the
 * stored proposal and the apply all see exactly what they did before. On:
 * unchanged.
 */
export function skillEditsFor<T>(edits: T[], on: boolean): T[] {
  if (on) return edits
  return edits.map((e) => {
    const out = strip(e) as T & { exercises?: unknown }
    if (out && typeof out === 'object' && Array.isArray(out.exercises)) {
      return { ...out, exercises: out.exercises.map(strip) }
    }
    return out
  })
}
