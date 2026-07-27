import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Target, CalendarDays, Scale, Activity, LogOut } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useCachedLoader } from '../../lib/cache'
import { getWeightUnit, setWeightUnit, type WeightUnit } from '../../lib/units'
import {
  PageHeader, SectionHeader, Skeleton, Button, Input, Row, Sheet,
} from '../../components/ui'

interface ProfileScreenProps {
  athleteId: string
  athleteName: string | null
}

interface Meta {
  sessions_per_week: number | null
  training_age: number | null
  goals: string | null
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
async function fetchMeta(athleteId: string): Promise<Meta> {
  const { data, error } = await supabase
    .from('athlete')
    .select('sessions_per_week, training_age, goals')
    .eq('id', athleteId)
    .maybeSingle()
  if (error) throw error
  return (data as Meta | null) ?? { sessions_per_week: null, training_age: null, goals: null }
}

export function ProfileScreen({ athleteId, athleteName }: ProfileScreenProps) {
  const navigate = useNavigate()
  // Offline-first like every other loop screen: paint the last synced values
  // instantly, revalidate behind. Reading this straight off the network left
  // the whole screen on skeletons with no signal — which is exactly where a
  // phone-only athlete usually is.
  const { data: fetched, loading, refetch } = useCachedLoader(
    `profile:${athleteId}`,
    () => fetchMeta(athleteId),
  )
  // Local overlay so an edit shows immediately, before the refetch lands.
  const [override, setOverride] = useState<Partial<Meta>>({})
  const meta: Meta | null = fetched ? { ...fetched, ...override } : null
  const [unit, setUnit] = useState<WeightUnit>(() => getWeightUnit())

  const [editing, setEditing] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

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
      await supabase.auth.signOut({ scope: 'local' })
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

  async function save() {
    if (!editing) return
    if (editing === 'units') {
      const next = draft === 'kg' ? 'kg' : 'lb'
      setWeightUnit(next)
      setUnit(next)
      setEditing(null)
      return
    }
    setSaving(true)
    const patch =
      editing === 'target' ? { goals: draft.trim() || null }
      : editing === 'sessions' ? { sessions_per_week: clampInt(draft, 1, 7) }
      : { training_age: clampInt(draft, 0, 60) }
    setOverride((o) => ({ ...o, ...patch }))
    await supabase.from('athlete').update(patch).eq('id', athleteId)
    refetch()
    setSaving(false)
    setEditing(null)
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
                <Target size={22} strokeWidth={1.75} color="var(--signal)" style={{ flexShrink: 0 }} />
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
              leading={<CalendarDays size={20} strokeWidth={1.75} color="var(--text-dim)" />}
              title="Sessions per week"
              value={sessions != null ? String(sessions) : '—'}
              onClick={() => openEdit('sessions')}
            />
            <Row
              leading={<Activity size={20} strokeWidth={1.75} color="var(--text-dim)" />}
              title="Training age"
              value={trainingAge != null ? `${trainingAge}y` : '—'}
              onClick={() => openEdit('trainingAge')}
            />
            <Row
              leading={<Scale size={20} strokeWidth={1.75} color="var(--text-dim)" />}
              title="Weight units"
              value={unit}
              onClick={() => openEdit('units')}
            />
          </div>
        </div>

        <div className="section">
          <SectionHeader>Your data</SectionHeader>
          <div style={{ marginTop: 4 }}>
            <Row title="Training history" sub="Every session you've logged" onClick={() => navigate('/app/history')} />
            <Row title="Latest recap" sub="Last week's review" onClick={() => navigate('/app/recap')} />
            <Row title="Retest" sub="Re-read where you are" onClick={() => navigate('/app/retest')} />
          </div>
        </div>

        <Button variant="ghost" full onClick={handleSignOut} disabled={signingOut}>
          <LogOut size={18} strokeWidth={1.75} style={{ marginRight: 8 }} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
       </div>
      </div>

      {editing && (
        <Sheet
          title={FIELD_TITLE[editing]}
          onClose={() => setEditing(null)}
          actions={
            <Button variant="primary" full onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
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
