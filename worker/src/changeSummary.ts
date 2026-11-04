/**
 * change_log, the pure half: rule refs pulled from a rationale, who a row was
 * by in the athlete's words, and a one-line "what changed" from a row's diff.
 * The Worker computes these so the app only displays them.
 */

export type ChangeActorType = 'athlete' | 'mcp' | 'app_coach' | 'system'

const RULE_RE = /\bU(1[0-5]|[1-9])\b/g

/** U1–U15 named in the rationale or passed explicitly, deduped, in rule order. */
export function ruleRefsFrom(rationale: unknown, explicit?: unknown): string[] {
  const found = new Set<string>()
  if (typeof rationale === 'string') for (const m of rationale.matchAll(RULE_RE)) found.add(`U${m[1]}`)
  if (Array.isArray(explicit)) {
    for (const r of explicit) {
      if (typeof r !== 'string') continue
      const m = /^U(1[0-5]|[1-9])$/.exec(r.trim().toUpperCase())
      if (m) found.add(`U${m[1]}`)
    }
  }
  return [...found].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}

/** You / Claude / Coach / System, or the name the athlete gave a connected coach. */
export function actorLabel(type: string, tokenName?: string | null): string {
  switch (type) {
    case 'athlete': return 'You'
    case 'mcp': return tokenName?.trim() || 'Claude'
    case 'app_coach': return 'Coach'
    default: return 'System'
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function clip(text: string, n = 90): string {
  return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text
}

interface SessionChanges { name?: unknown; label?: unknown; changes?: unknown }

/** "+ Face Pull, − Plank (Upper)" from a revision- or override-shaped session list. */
function sessionLines(sessions: unknown): string | null {
  const parts: string[] = []
  for (const s of arr(sessions) as SessionChanges[]) {
    const changes = arr(s.changes).map(obj).filter((c) => c.kind !== 'kept')
    if (!changes.length) continue
    const what = changes.map((c) => {
      const sign = c.kind === 'added' || c.kind === 'moved_in' ? '+' : c.kind === 'removed' || c.kind === 'moved_out' ? '−' : '~'
      return `${sign} ${String(c.name ?? '')}`
    }).join(', ')
    parts.push(`${what} (${String(s.label ?? s.name ?? '')})`)
  }
  return parts.length ? parts.join('; ') : null
}

function changedKeys(before: unknown, after: unknown): string[] {
  const b = obj(before)
  const a = obj(after)
  return Object.keys(a).filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
}

function tmText(entry: unknown): string {
  if (entry == null) return 'auto'
  if (typeof entry === 'number') return String(entry)
  const v = obj(entry).value
  return v == null ? 'auto' : String(v)
}

/** One line a person reads: what this row changed. */
export function summarizeChange(row: { tool: string; target_type: string; diff: unknown }): string {
  const d = obj(row.diff)
  switch (row.tool) {
    case 'apply_session_override':
      return clip(`This week only: ${sessionLines(d.sessions) ?? 'a dated session'}`)
    case 'clear_session_override':
      return clip(`Back to the plan: ${arr(d.sessions).map((s) => String(obj(s).label ?? '')).filter(Boolean).join('; ') || 'a dated session'}`)
    case 'void_preview':
      return 'Voided a preview (that coach no longer has access)'
    case 'revoke_coach':
      return clip(`Ended ${str(d.coach) ?? 'a coach'}'s access${arr(d.voided_previews).length ? ` and voided ${arr(d.voided_previews).length} open preview${arr(d.voided_previews).length === 1 ? '' : 's'}` : ''}`)
    case 'apply_program_edits':
    case 'accept_proposal':
    case 'app_editor': {
      const rev = obj(d.revision)
      const lines = sessionLines(rev.sessions)
      const head = row.tool === 'accept_proposal' && str(d.title) ? `${str(d.title)} ` : ''
      const when = d.timing === 'next_week' ? ' — from next Monday' : ''
      return clip(`${head}${lines ?? str(d.summary) ?? 'Program changed'}${when}`)
    }
    case 'create_track':
      return clip(`Added the ${str(obj(d.after).name) ?? ''} track`)
    case 'update_track': {
      const keys = changedKeys(d.before, d.after)
      return clip(`Updated the ${str(obj(d.before).name) ?? 'a'} track${keys.length ? `: ${keys.join(', ').replace(/_/g, ' ')}` : ''}`)
    }
    case 'assign_exercise_to_track':
      return clip(`Moved ${arr(d.updated).map(String).join(', ') || 'exercises'}`)
    case 'set_track_progression_rule': {
      const a = obj(d.after)
      return clip(`${str(a.track) ?? 'Track'}${str(a.exercise) ? ` · ${str(a.exercise)}` : ''} progresses by ${String(a.engine_type ?? '').replace(/_/g, ' ')}`)
    }
    case 'upsert_autoreg_rule':
      return clip(`Rule: ${str(obj(d.after).message) ?? 'if-then rule'}`)
    case 'upsert_goal': {
      const a = obj(d.after)
      const b = d.before == null ? null : obj(d.before)
      const target = a.target != null ? `${String(a.target)}${str(a.unit) ? ` ${str(a.unit)}` : ''}` : null
      if (!b) return clip(`New goal ${str(a.name) ?? ''}${target ? `: ${target}` : ''}`)
      const keys = changedKeys(b, a)
      return clip(`Goal ${str(a.name) ?? ''}${keys.length ? `: ${keys.join(', ').replace(/_/g, ' ')}` : ''}${target && keys.includes('target') ? ` → ${target}` : ''}`)
    }
    case 'log_goal_measurement':
      return clip(`Logged ${str(d.goal) ?? 'a measurement'}: ${String(d.value ?? '')}${str(d.date) ? ` on ${str(d.date)}` : ''}`)
    case 'add_workout_note':
      return clip(`Note: ${str(d.text) ?? ''}`)
    case 'update_athlete_target':
      return clip(`Target: ${str(obj(d.after).goals) ?? ''}`)
    case 'update_program_meta': {
      const keys = changedKeys(d.before, d.after)
      return clip(`Block: ${keys.map((k) => `${k.replace(/_/g, ' ')} ${String(obj(d.after)[k] ?? '—')}`).join(', ') || 'details'}`)
    }
    case 'set_training_max':
      return `${String(d.lift ?? 'Lift').replace(/^\w/, (c) => c.toUpperCase())} training max: ${tmText(d.before)} → ${tmText(d.after)}`
    case 'revert_change':
      return clip(`Undid: ${str(d.undid) ?? 'a change'}`)
    case 'apply_methodology_override':
      return clip(`Rule ${String(d.path ?? '')}${str(d.track_id) ? ' (one track)' : ''}: ${JSON.stringify(d.before ?? null)} → ${d.override_id == null ? 'default' : JSON.stringify(d.after ?? null)}`)
    case 'log_checkin': {
      const c = obj(d.checkin)
      const bits = [
        c.sleep_hours != null ? `sleep ${String(c.sleep_hours)} h` : null,
        c.stress != null ? `stress ${String(c.stress)}/5` : null,
        c.soreness != null ? `soreness ${String(c.soreness)}/5` : null,
        ...arr(d.pain).map(obj).map((p) => `${String(p.region ?? '').replace(/_/g, ' ')} ${String(p.score ?? '')}/10${arr(p.red_flags).length ? ' (red flag)' : ''}`),
      ].filter(Boolean)
      const blocked = arr(d.regions).map(obj).filter((m) => m.to === 'blocked').map((m) => String(m.region ?? '').replace(/_/g, ' '))
      return clip(`Check-in${str(d.date) ? ` ${str(d.date)}` : ''}: ${bits.join(', ') || 'logged'}${blocked.length ? ` — ${blocked.join(', ')} blocked` : ''}`)
    }
    case 'clear_region':
      return clip(`${(str(d.region) ?? 'Region').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())} cleared by a clinician`)
    case 'set_coach_health_access': {
      const on = obj(d.share_health).after === true
      return clip(`${on ? 'Shared' : 'Stopped sharing'} check-ins and pain with ${str(d.coach) ?? 'a coach'}`)
    }
    default:
      return clip(`${row.tool.replace(/_/g, ' ')} (${row.target_type})`)
  }
}
