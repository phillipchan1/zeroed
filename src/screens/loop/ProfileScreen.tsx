import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Target, CalendarDays, Scale, Activity, LogOut, Link2, Bell, Volume2 } from 'lucide-react'
import { supabase, supabaseAnonKey, supabaseUrl } from '../../lib/supabaseClient'
import { signOutLocal } from '../../lib/authClient'
import { mcpUrl } from '../../lib/api'
import { useCachedLoader, mutateCache } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { getWeightUnit, setWeightUnit, type WeightUnit } from '../../lib/units'
import { restAlertEnabled, setRestAlertEnabled, setClickEnabled, setSetClickEnabled } from '../../lib/restAlert'
import {
  PageHeader, SectionHeader, Skeleton, Button, Input, Row, Sheet,
} from '../../components/ui'
import { TrainingMaxes } from './TrainingMaxes'
import { tracksOn } from '../../lib/tracksFlag'
import { fetchCoachAccess, readLabel, setCoachHealth, setCoachRole, type CoachRole } from '../../lib/readiness'
import { whenLabel } from '../../lib/changeLog'

interface McpTokenRow {
  id: string
  name: string
  last_four: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function mintToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function mcpEndpoint(): string {
  const cloud = mcpUrl()
  if (cloud) return cloud
  const url = new URL(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/mcp`)
  url.searchParams.set('apikey', supabaseAnonKey)
  return url.toString()
}

interface ProfileScreenProps {
  athleteId: string
  athleteName: string | null
}

interface ProfileMeta {
  sessions_per_week: number | null
  training_age: number | null
  goals: string | null
}

export async function fetchProfileMeta(athleteId: string): Promise<ProfileMeta | null> {
  const { data, error } = await supabase
    .from('athlete')
    .select('sessions_per_week, training_age, goals')
    .eq('id', athleteId)
    .maybeSingle()
  if (error) throw error
  return (data as ProfileMeta | null) ?? null
}

type EditField = 'target' | 'sessions' | 'trainingAge' | 'units'

const FIELD_TITLE: Record<EditField, string> = {
  target: 'What are you chasing?',
  sessions: 'Sessions per week',
  trainingAge: 'Training age',
  units: 'Weight units',
}

/**
 * YOU — identity, the durable target, and the settings that shape the program.
 *
 * This was a near-empty tab: a name, a sign-out button and one editable target,
 * with sessions/week and training age shown as an unexplained mono string and
 * not editable at all — even though both drive the program's shape. It's now a
 * settings list where every value is a row you can tap and change, and each
 * edit opens a focused sheet instead of expanding the page.
 */
export function ProfileScreen({ athleteId, athleteName }: ProfileScreenProps) {
  const navigate = useNavigate()
  const profileKey = cacheKeys.profile(athleteId)
  // Offline-first: paints from the held value on frame one, so returning to
  // Profile never shows a skeleton after the first visit.
  const { data: meta, loading } = useCachedLoader<ProfileMeta | null>(
    profileKey,
    () => fetchProfileMeta(athleteId),
  )
  const [unit, setUnit] = useState<WeightUnit>(() => getWeightUnit())
  // A beep at the end of rest is the default — a silent timer is a stopwatch,
  // and the point is knowing without looking. Off is a deliberate choice.
  const [restAlert, setRestAlert] = useState(() => restAlertEnabled())
  const [setClick, setSetClick] = useState(() => setClickEnabled())

  const [editing, setEditing] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const [mcpTokens, setMcpTokens] = useState<McpTokenRow[]>([])
  const [mcpLabel, setMcpLabel] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  // tracks_v1: what each coach may see (D3) and every read they made.
  const { data: coachAccess, refetch: refetchCoachAccess } = useCachedLoader(
    tracksOn() ? cacheKeys.coachAccess(athleteId) : null,
    fetchCoachAccess,
  )

  async function toggleHealth(id: string, on: boolean) {
    if (mcpBusy) return
    setMcpBusy(true)
    const res = await setCoachHealth(id, on)
    setMcpBusy(false)
    if (!res.ok) setMcpError(res.text)
    refetchCoachAccess()
  }

  // D3: read (sees what you share, can't propose) or propose (you approve each change).
  async function changeRole(id: string, role: CoachRole) {
    if (mcpBusy) return
    setMcpBusy(true)
    const res = await setCoachRole(id, role)
    setMcpBusy(false)
    if (!res.ok) setMcpError(res.text)
    refetchCoachAccess()
  }

  const reloadMcpTokens = useCallback(async () => {
    const { data, error } = await supabase
      .from('mcp_token')
      .select('id, name, last_four, created_at, last_used_at, revoked_at')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
    if (error) {
      setMcpError(error.message)
      return
    }
    setMcpTokens((data ?? []) as McpTokenRow[])
    setMcpError(null)
  }, [athleteId])

  useEffect(() => {
    void reloadMcpTokens()
  }, [reloadMcpTokens])

  async function createMcpToken() {
    const label = mcpLabel.trim() || 'Claude'
    if (mcpBusy) return
    setMcpBusy(true)
    setMcpError(null)
    try {
      const token = mintToken()
      const { error } = await supabase.from('mcp_token').insert({
        athlete_id: athleteId,
        name: label,
        token_hash: await sha256Hex(token),
        last_four: token.slice(-4),
      })
      if (error) throw error
      setFreshToken({ name: label, token })
      setMcpLabel('')
      await reloadMcpTokens()
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e))
    } finally {
      setMcpBusy(false)
    }
  }

  async function revokeMcpToken(id: string) {
    if (mcpBusy) return
    setMcpBusy(true)
    try {
      const { error } = await supabase
        .from('mcp_token')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      await reloadMcpTokens()
      if (tracksOn()) refetchCoachAccess()
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e))
    } finally {
      setMcpBusy(false)
    }
  }

  async function copyFresh() {
    if (!freshToken) return
    const blob = [
      `URL: ${mcpEndpoint()}`,
      `Authorization: Bearer ${freshToken.token}`,
      '',
      'Claude → Customize → Connectors → Add custom connector.',
      'Paste the URL. Skip any OAuth / login card — use the Bearer header above.',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(blob)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setMcpError('Could not copy — select the text and copy it by hand')
    }
  }

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    // Drop focus so iOS tears the keyboard down before the view swaps, instead
    // of leaving it hovering over the splash through the logout transition.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    try {
      // Local scope clears this device's session with no network round-trip, so
      // sign-out is instant even on the flaky signal you often have right after
      // a workout. Global scope used to hang here, leaving the button spinning.
      await signOutLocal()
      // SIGNED_OUT propagates through useAuth and swaps the app to onboarding.
    } catch {
      // Never strand the athlete on a dead button — force a clean reload.
      window.location.href = '/'
    }
  }

  function openEdit(field: EditField) {
    setDraft(
      field === 'target' ? (meta?.goals ?? '')
      : field === 'sessions' ? String(meta?.sessions_per_week ?? 3)
      : field === 'trainingAge' ? String(meta?.training_age ?? 0)
      : unit,
    )
    setEditing(field)
  }

  // Optimistic: the new value paints and the sheet closes on the same frame as
  // the tap. The write goes out behind it — and if it fails (offline), the next
  // revalidation restores the server's value rather than stranding a lie.
  function save() {
    if (!editing || saving) return

    if (editing === 'units') {
      const next: WeightUnit = draft === 'kg' ? 'kg' : 'lb'
      setWeightUnit(next)
      setUnit(next)
      setEditing(null)
      return
    }

    const patch: Partial<ProfileMeta> =
      editing === 'target' ? { goals: draft.trim() || null }
      : editing === 'sessions' ? { sessions_per_week: clampInt(draft, 1, 7) }
      : { training_age: clampInt(draft, 0, 60) }

    mutateCache<ProfileMeta | null>(profileKey, (m) => (m ? { ...m, ...patch } : m))
    setEditing(null)
    setSaving(true)
    void supabase
      .from('athlete')
      .update(patch)
      .eq('id', athleteId)
      .then(() => setSaving(false), () => setSaving(false))
  }

  const target = meta?.goals ?? null
  const sessions = meta?.sessions_per_week ?? null
  const trainingAge = meta?.training_age ?? null

  return (
    <div className="screen with-nav">
      <div className="page">
       <div className="page__main">
        <PageHeader title={athleteName ?? 'You'} />

        {/* The target — the one thing on this screen that's about ambition
            rather than configuration, so it gets the space. */}
        <div className="section">
          <SectionHeader>Chasing</SectionHeader>
          {loading && !meta ? (
            <div style={{ marginTop: 12 }}><Skeleton height={30} width={220} /></div>
          ) : (
            <button
              type="button"
              className="card card--tap"
              style={{ width: '100%', textAlign: 'left', marginTop: 10, color: 'var(--text)' }}
              onClick={() => openEdit('target')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Target size={22} strokeWidth={1.75} style={{ flexShrink: 0, color: 'var(--signal)' }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xl)', fontWeight: 700, lineHeight: 1.3 }}>
                  {target ?? <span className="text-dim" style={{ fontWeight: 400 }}>Set a target</span>}
                </span>
              </div>
            </button>
          )}
        </div>

        {/* Training context — these drive the program, so they're editable. */}
        <div className="section">
          <SectionHeader>Training</SectionHeader>
          <div style={{ marginTop: 4 }}>
            <Row
              leading={<CalendarDays size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
              title="Sessions per week"
              value={sessions != null ? String(sessions) : '—'}
              onClick={() => openEdit('sessions')}
            />
            <Row
              leading={<Activity size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
              title="Training age"
              value={trainingAge != null ? `${trainingAge}y` : '—'}
              onClick={() => openEdit('trainingAge')}
            />
            <Row
              leading={<Scale size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
              title="Weight units"
              value={unit}
              onClick={() => openEdit('units')}
            />
            <Row
              leading={<Bell size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
              title="Rest timer sound"
              sub="A beep and a buzz when the rest is up"
              value={restAlert ? 'On' : 'Off'}
              onClick={() => { const next = !restAlert; setRestAlert(next); setRestAlertEnabled(next) }}
              chevron={false}
            />
            <Row
              leading={<Volume2 size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
              title="Sound effects"
              sub="A click per set, a chime on a PR, a chord at the finish"
              value={setClick ? 'On' : 'Off'}
              onClick={() => { const next = !setClick; setSetClick(next); setSetClickEnabled(next) }}
              chevron={false}
            />
          </div>
        </div>

        <TrainingMaxes athleteId={athleteId} unit={unit} />

        <div className="section">
          <SectionHeader>Your data</SectionHeader>
          <div style={{ marginTop: 4 }}>
            <Row title="Training history" sub="Every session you've logged" onClick={() => navigate('/app/history')} />
            <Row title="Latest recap" sub="Last week's review" onClick={() => navigate('/app/recap')} />
            <Row title="Retest" sub="Re-read where you are" onClick={() => navigate('/app/retest')} />
          </div>
        </div>

        <div className="section">
          <SectionHeader>Claude connector</SectionHeader>
          <p className="text-dim" style={{ marginTop: 8, fontSize: 'var(--fs-sm)', lineHeight: 1.45 }}>
            A remote MCP key so Claude on the web or phone can read your log and
            preview program edits. Use as a <em>custom connector</em> (not Local
            dev). Skip any OAuth login card — Bearer only.
          </p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Input
              type="text"
              placeholder="e.g. Claude iPhone"
              value={mcpLabel}
              onChange={(e) => setMcpLabel(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button variant="outline" onClick={() => void createMcpToken()} disabled={mcpBusy}>
              Create
            </Button>
          </div>
          {mcpError && (
            <p style={{ marginTop: 8, color: 'var(--danger, #c44)', fontSize: 'var(--fs-sm)' }}>{mcpError}</p>
          )}
          <div style={{ marginTop: 8 }}>
            {mcpTokens.filter((t) => !t.revoked_at).map((t) => (
              <Row
                key={t.id}
                leading={<Link2 size={20} strokeWidth={1.75} style={{ color: 'var(--text-dim)' }} />}
                title={t.name}
                sub={`…${t.last_four}${t.last_used_at ? ` · used ${new Date(t.last_used_at).toLocaleDateString()}` : ' · unused'}`}
                value="Revoke"
                onClick={() => void revokeMcpToken(t.id)}
              />
            ))}
            {!mcpTokens.some((t) => !t.revoked_at) && (
              <p className="text-dim" style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>No active tokens yet.</p>
            )}
          </div>
          {tracksOn() && coachAccess && coachAccess.coaches.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <SectionHeader>Coach access</SectionHeader>
              <p className="text-dim" style={{ marginTop: 8, fontSize: 'var(--fs-sm)', lineHeight: 1.45 }}>
                Coaches read your log; a coach that can propose also suggests changes, and only you approve them. Read-only coaches can&rsquo;t preview or propose anything. Check-ins and pain are shared only while the switch is on.
              </p>
              {coachAccess.coaches.map((c) => (
                <div key={c.id}>
                  {c.role && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 'var(--fs-sm)' }}>
                      <span style={{ flex: 1 }}>{c.name} can</span>
                      <select
                        className="input"
                        value={c.role}
                        disabled={mcpBusy}
                        onChange={(e) => void changeRole(c.id, e.target.value === 'read' ? 'read' : 'propose')}
                        aria-label={`What ${c.name} can do`}
                      >
                        <option value="propose">Read and propose</option>
                        <option value="read">Read only</option>
                      </select>
                    </label>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 'var(--fs-sm)' }}>
                    <input
                      type="checkbox"
                      checked={c.share_health}
                      disabled={mcpBusy}
                      onChange={(e) => void toggleHealth(c.id, e.target.checked)}
                    />
                    <span>{c.name} sees check-ins and pain</span>
                  </label>
                </div>
              ))}
              {coachAccess.reads.length > 0 ? (
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                  {coachAccess.reads.map((r) => (
                    <li key={r.id} className="text-dim" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
                      {r.refused
                        ? <>{r.who} tried to {r.tool.replace(/_/g, ' ')} · refused (read only) · {whenLabel(r.created_at)}</>
                        : <>{r.who} read {readLabel(r.tool)} · {whenLabel(r.created_at)}</>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-dim" style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>No coach has read anything yet.</p>
              )}
            </div>
          )}
        </div>

        <Button variant="ghost" full onClick={handleSignOut} disabled={signingOut}>
          <LogOut size={18} strokeWidth={1.75} style={{ marginRight: 8 }} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
       </div>
      </div>

      {freshToken && (
        <Sheet
          title="Copy once — then it's gone"
          onClose={() => setFreshToken(null)}
          actions={
            <Button variant="primary" full onClick={() => void copyFresh()}>
              {copied ? 'Copied' : 'Copy URL + token'}
            </Button>
          }
        >
          <p className="text-dim" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.45, marginBottom: 12 }}>
            Token for <strong style={{ color: 'var(--text)' }}>{freshToken.name}</strong>. We only
            store a hash — you will not see this again.
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-sm)',
              padding: 12,
              borderRadius: 12,
              border: '1px solid var(--line)',
              background: 'var(--surface, transparent)',
              color: 'var(--text)',
              margin: 0,
            }}
          >
            {`URL:\n${mcpEndpoint()}\n\nAuthorization:\nBearer ${freshToken.token}`}
          </pre>
        </Sheet>
      )}

      {editing && (
        <Sheet
          title={FIELD_TITLE[editing]}
          onClose={() => setEditing(null)}
          actions={<Button variant="primary" full onClick={save}>Save</Button>}
        >
          {editing === 'units' ? (
            <div style={{ display: 'flex', gap: 10 }}>
              {(['lb', 'kg'] as WeightUnit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setDraft(u)}
                  style={{
                    flex: 1, height: 64, borderRadius: 12, cursor: 'pointer',
                    fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', fontWeight: 700,
                    border: `1px solid ${draft === u ? 'var(--signal)' : 'var(--line)'}`,
                    background: draft === u ? 'var(--signal-dim)' : 'transparent',
                    color: draft === u ? 'var(--signal)' : 'var(--text-dim)',
                  }}
                >
                  {u}
                </button>
              ))}
            </div>
          ) : editing === 'target' ? (
            <Input
              type="text"
              placeholder="e.g. 285 lb bench"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          ) : (
            <Input
              type="number"
              inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              mono
            />
          )}
        </Sheet>
      )}
    </div>
  )
}

function clampInt(v: string, min: number, max: number): number {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}
