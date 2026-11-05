import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, PageHeader, SectionHeader, Spinner } from '../../components/ui'
import {
  fetchCoachState, submitIntake, TRAINING_AGE_OPTIONS,
  type CoachState, type IntakeResult, type ModuleKey, type TrainingAge,
} from '../../lib/coachV1'
import { BlockPreview } from './BlockPreview'

/**
 * Intake (coach_v1; spec section 5). Goals, activities, schedule, training
 * age, injuries and pain, screens, recovery. The Worker checks it, stops on a
 * red flag (and blocks that region), and composes one block preview the
 * athlete approves. Under 18: a parent or guardian consents first.
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface GoalDraft { name: string; test: string; current: string; target: string; unit: string; due_date: string; weight: 'priority' | 'maintenance' }
interface ActivityDraft { module: ModuleKey; name: string; sessions_per_week: number; season: 'in' | 'off'; days: number[] }
interface PainDraft { region: string; score: number; red_flags: string[] }

const emptyGoal = (): GoalDraft => ({ name: '', test: '', current: '', target: '', unit: '', due_date: '', weight: 'priority' })

function ageFrom(birth: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null
  const [y, m, d] = birth.split('-').map(Number)
  const now = new Date()
  return now.getFullYear() - y - (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d) ? 1 : 0)
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {DAYS.map((d, i) => (
        <Button
          key={d}
          type="button"
          variant={value.includes(i) ? 'primary' : 'outline'}
          onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())}
          style={{ padding: '6px 10px' }}
        >
          {d}
        </Button>
      ))}
    </div>
  )
}

function num(v: string): number | null {
  const n = Number(v)
  return v.trim() && Number.isFinite(n) ? n : null
}

export function IntakeScreen() {
  const navigate = useNavigate()
  const [state, setState] = useState<CoachState | null>(null)
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState<GoalDraft[]>([emptyGoal()])
  const [activities, setActivities] = useState<ActivityDraft[]>([])
  const [daysPerWeek, setDaysPerWeek] = useState(3)
  const [minutes, setMinutes] = useState(60)
  const [restDays, setRestDays] = useState<number[]>([])
  const [equipment, setEquipment] = useState('')
  const [trainingAge, setTrainingAge] = useState<TrainingAge>('1to3')
  const [birthDate, setBirthDate] = useState('')
  const [adultConfirmed, setAdultConfirmed] = useState(false)
  const [guardian, setGuardian] = useState('')
  const [consent, setConsent] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [pain, setPain] = useState<PainDraft[]>([])
  const [screens, setScreens] = useState<Record<string, string>>({})
  const [sleep, setSleep] = useState('')
  const [stress, setStress] = useState('')
  const [soreness, setSoreness] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<IntakeResult | null>(null)

  useEffect(() => {
    void fetchCoachState().then((s) => { setState(s); setLoading(false) })
  }, [])

  // A display hint only: the Worker decides age status (worker/src/ageStatus.ts)
  // and refuses an intake that needs consent without it. A birth date wins;
  // without one, "I'm 18 or older" makes an adult; with neither the age is
  // unknown and the under-18 rules apply (section 11b).
  const age = ageFrom(birthDate)
  const minor = state?.birth_date_on_file
    ? state.minor === true
    : age != null
      ? age < 18
      : !(adultConfirmed || state?.age_status === 'adult' || (state?.age_status == null && state?.minor === false))
  // Screens: the union across the chosen activities, from the server's modules.
  const screenList = useMemo(() => {
    const seen = new Map<string, { key: string; name: string; unit: string; sided: boolean }>()
    for (const a of activities) for (const s of state?.modules.find((m) => m.key === a.module)?.screens ?? []) seen.set(s.key, s)
    return [...seen.values()]
  }, [activities, state])

  if (loading) return <div className="screen with-nav"><div className="page"><Spinner /></div></div>
  if (!state) return <div className="screen with-nav"><div className="page"><p className="text-sm">The coach is not available right now.</p></div></div>

  async function submit() {
    setSending(true)
    const answers = {
      ...(state!.birth_date_on_file ? {} : { birth_date: birthDate || undefined }),
      ...(!state!.birth_date_on_file && !birthDate && adultConfirmed ? { adult_confirmed: true } : {}),
      ...(minor ? { parental_consent: { guardian_name: guardian, confirmed: consent } } : {}),
      goals: goals.filter((g) => g.name.trim()).map((g) => ({
        name: g.name, test: g.test || null, current: num(g.current), target: num(g.target), unit: g.unit || null,
        due_date: g.due_date || null, weight: g.weight,
      })),
      activities,
      schedule: { days_per_week: daysPerWeek, minutes_per_session: minutes, rest_days: restDays, equipment: equipment.split(',').map((e) => e.trim()).filter(Boolean) },
      training_age: trainingAge,
      injuries: { history: history.map((region) => ({ region })), pain },
      screens: screenList.flatMap((s) => (s.sided ? ['L', 'R'] : [null]).flatMap((side) => {
        const v = num(screens[`${s.key}:${side ?? ''}`] ?? '')
        return v == null ? [] : [{ key: s.key, value: v, side }]
      })),
      recovery: { sleep_hours: num(sleep), stress: num(stress), soreness: num(soreness) },
    }
    setResult(await submitIntake(answers))
    setSending(false)
  }

  if (result?.ok && result.stopped) {
    return (
      <div className="screen with-nav"><div className="page">
        <PageHeader eyebrow="Intake" title="Let's pause here" onBack={() => navigate('/app/coach')} />
        <div className="card" style={{ borderColor: 'var(--signal)' }}>
          <p className="text-sm" style={{ marginBottom: 8 }}>{(result.regions ?? []).map((r) => r.why).join('; ')}.</p>
          <p className="text-sm">{result.refer_out}</p>
          <p className="text-xs text-dim" style={{ marginTop: 8 }}>That area won't be loaded. Once a clinician clears it, mark it cleared on Today and run intake again.</p>
        </div>
      </div></div>
    )
  }
  if (result?.ok && result.preview_id && result.block) {
    return (
      <div className="screen with-nav"><div className="page">
        <PageHeader eyebrow="Intake" title="Your proposed block" onBack={() => setResult(null)} />
        <BlockPreview previewId={result.preview_id} block={result.block} onApplied={(r) => { if (r.applied) setTimeout(() => navigate('/app/program'), 1200) }} />
      </div></div>
    )
  }

  return (
    <div className="screen with-nav">
      <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <PageHeader eyebrow="Intake" title="Build your block" subtitle="Your goals, what else you do, and your week. The engine composes it; you approve it." onBack={() => navigate('/app/coach')} />

        {!state.birth_date_on_file && (
          <section>
            <SectionHeader>Birth date</SectionHeader>
            <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} aria-label="Birth date" />
            {!birthDate && state.can_confirm_adult === true && (
              <label className="text-sm" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input type="checkbox" checked={adultConfirmed} onChange={(e) => setAdultConfirmed(e.target.checked)} /> Or: I&rsquo;m 18 or older
              </label>
            )}
            {!birthDate && !adultConfirmed && state.age_status !== 'adult' && (
              <p className="text-xs text-dim" style={{ marginTop: 6 }}>With no age on file, the under-18 rules apply.</p>
            )}
          </section>
        )}
        {minor && (
          <section className="card">
            <SectionHeader>Parent or guardian</SectionHeader>
            <p className="text-xs text-dim" style={{ marginBottom: 8 }}>Under 18 (or no age on file): a parent or guardian agrees first. Plans stay conservative: no RPE above 8, fewer jumps, no max tests.</p>
            <Input placeholder="Their name" value={guardian} onChange={(e) => setGuardian(e.target.value)} />
            <label className="text-sm" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> They agree to this training plan.
            </label>
          </section>
        )}

        <section>
          <SectionHeader>Goals (1–3)</SectionHeader>
          {goals.map((g, i) => (
            <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              <Input placeholder="Goal, e.g. Back squat 315" value={g.name} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input placeholder="Test, e.g. Back Squat 1RM or Half marathon" value={g.test} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, test: e.target.value } : x)))} />
              <div style={{ display: 'flex', gap: 6 }}>
                <Input placeholder="Now" inputMode="decimal" value={g.current} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, current: e.target.value } : x)))} />
                <Input placeholder="Target" inputMode="decimal" value={g.target} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} />
                <Input placeholder="Unit" value={g.unit} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
              </div>
              <Input type="date" value={g.due_date} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))} aria-label="By when" />
              <div style={{ display: 'flex', gap: 6 }}>
                {(['priority', 'maintenance'] as const).map((w) => (
                  <Button key={w} type="button" variant={g.weight === w ? 'primary' : 'outline'} onClick={() => setGoals(goals.map((x, j) => (j === i ? { ...x, weight: w } : x)))}>
                    {w === 'priority' ? 'Priority' : 'Maintain'}
                  </Button>
                ))}
                {goals.length > 1 && <Button type="button" variant="ghost" onClick={() => setGoals(goals.filter((_, j) => j !== i))}>Remove</Button>}
              </div>
            </div>
          ))}
          {goals.length < 3 && <Button type="button" variant="ghost" onClick={() => setGoals([...goals, emptyGoal()])}>+ Add a goal</Button>}
        </section>

        <section>
          <SectionHeader>What else you do</SectionHeader>
          {activities.map((a, i) => (
            <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              <select className="input" value={a.module} onChange={(e) => setActivities(activities.map((x, j) => (j === i ? { ...x, module: e.target.value as ModuleKey } : x)))}>
                {state.modules.map((m) => <option key={m.key} value={m.key}>{m.label} ({m.examples.slice(0, 3).join(', ')})</option>)}
              </select>
              <Input placeholder="Name, e.g. Rec basketball" value={a.name} onChange={(e) => setActivities(activities.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input type="number" min={0} max={14} value={a.sessions_per_week} onChange={(e) => setActivities(activities.map((x, j) => (j === i ? { ...x, sessions_per_week: Number(e.target.value) } : x)))} aria-label="Sessions a week" />
                <span className="text-xs text-dim">a week</span>
                {(['in', 'off'] as const).map((s) => (
                  <Button key={s} type="button" variant={a.season === s ? 'primary' : 'outline'} onClick={() => setActivities(activities.map((x, j) => (j === i ? { ...x, season: s } : x)))}>
                    {s === 'in' ? 'In season' : 'Off season'}
                  </Button>
                ))}
              </div>
              <DayPicker value={a.days} onChange={(days) => setActivities(activities.map((x, j) => (j === i ? { ...x, days } : x)))} />
              <Button type="button" variant="ghost" onClick={() => setActivities(activities.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setActivities([...activities, { module: 'court', name: '', sessions_per_week: 1, season: 'in', days: [] }])}>+ Add a sport or activity</Button>
        </section>

        <section>
          <SectionHeader>Your week</SectionHeader>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <Input type="number" min={1} max={7} value={daysPerWeek} onChange={(e) => setDaysPerWeek(Number(e.target.value))} aria-label="Training days a week" />
            <span className="text-xs text-dim">training days max</span>
            <Input type="number" min={20} max={180} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Minutes a session" />
            <span className="text-xs text-dim">min a session</span>
          </div>
          <p className="text-xs text-dim" style={{ marginBottom: 4 }}>Rest days</p>
          <DayPicker value={restDays} onChange={setRestDays} />
          <Input placeholder="Equipment, comma separated" value={equipment} onChange={(e) => setEquipment(e.target.value)} style={{ marginTop: 6 }} />
        </section>

        <section>
          <SectionHeader>Training age</SectionHeader>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TRAINING_AGE_OPTIONS.map((t) => (
              <Button key={t.key} type="button" variant={trainingAge === t.key ? 'primary' : 'outline'} onClick={() => setTrainingAge(t.key)}>{t.label}</Button>
            ))}
          </div>
        </section>

        <section>
          <SectionHeader>Injuries and pain</SectionHeader>
          <p className="text-xs text-dim" style={{ marginBottom: 4 }}>Past injuries</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {state.regions.map((r) => (
              <Button key={r} type="button" variant={history.includes(r) ? 'primary' : 'outline'} onClick={() => setHistory(history.includes(r) ? history.filter((x) => x !== r) : [...history, r])} style={{ padding: '4px 8px' }}>
                {r.replace(/_/g, ' ')}
              </Button>
            ))}
          </div>
          {pain.map((p, i) => (
            <div key={i} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="input" value={p.region} onChange={(e) => setPain(pain.map((x, j) => (j === i ? { ...x, region: e.target.value } : x)))}>
                  {state.regions.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                </select>
                <Input type="number" min={0} max={10} value={p.score} onChange={(e) => setPain(pain.map((x, j) => (j === i ? { ...x, score: Number(e.target.value) } : x)))} aria-label="Pain 0–10" />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {state.red_flags.map((f) => (
                  <label key={f} className="text-xs" style={{ display: 'flex', gap: 4 }}>
                    <input type="checkbox" checked={p.red_flags.includes(f)} onChange={(e) => setPain(pain.map((x, j) => (j === i ? { ...x, red_flags: e.target.checked ? [...x.red_flags, f] : x.red_flags.filter((y) => y !== f) } : x)))} />
                    {f.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setPain([...pain, { region: state.regions[0], score: 0, red_flags: [] }])}>+ Something hurts now</Button>
        </section>

        {screenList.length > 0 && (
          <section>
            <SectionHeader>Screens (optional baselines)</SectionHeader>
            {screenList.map((s) => (
              <div key={s.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <span className="text-sm" style={{ flex: 2 }}>{s.name}{s.unit !== 'pass' ? ` (${s.unit})` : ' (1 pass, 0 fail)'}</span>
                {(s.sided ? ['L', 'R'] : ['']).map((side) => (
                  <Input key={side} inputMode="decimal" placeholder={side || 'value'} value={screens[`${s.key}:${side}`] ?? ''} onChange={(e) => setScreens({ ...screens, [`${s.key}:${side}`]: e.target.value })} style={{ flex: 1 }} />
                ))}
              </div>
            ))}
          </section>
        )}

        <section>
          <SectionHeader>Recovery</SectionHeader>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input inputMode="decimal" placeholder="Sleep (h)" value={sleep} onChange={(e) => setSleep(e.target.value)} />
            <Input inputMode="numeric" placeholder="Stress 1–5" value={stress} onChange={(e) => setStress(e.target.value)} />
            <Input inputMode="numeric" placeholder="Soreness 1–5" value={soreness} onChange={(e) => setSoreness(e.target.value)} />
          </div>
        </section>

        {result && !result.ok && (
          <div className="card" style={{ borderColor: 'var(--signal)' }}>
            {(result.errors ?? [result.text ?? 'Something went wrong.']).map((e, i) => <p key={i} className="text-sm">{e}</p>)}
          </div>
        )}
        <Button variant="primary" full disabled={sending} onClick={() => void submit()}>{sending ? 'Composing…' : 'Compose my block'}</Button>
        <p className="text-xs text-dim">Nothing changes in your program until you approve the block.</p>
      </div>
    </div>
  )
}
