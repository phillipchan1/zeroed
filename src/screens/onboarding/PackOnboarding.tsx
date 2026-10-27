import { useState, type ReactNode } from 'react'
import { Button, Input } from '../../components/ui'
import { FunnelFrame } from '../../components/layout/FunnelFrame'
import { AuthSheet } from './AuthSheet'
import {
  visibleStarterPacks,
  resolveStarterPack,
  type PackSettings,
  type Season,
  type StarterPackCard,
  type StarterPackId,
} from '../../engine/starterPacks'
import { stashFromResolved, writeStarterPack } from './starterPackStorage'

const SPORT_CHIPS = ['Basketball', 'Soccer', 'Tennis', 'Combat', 'Other']
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SPORT_DAYS = [2, 3, 4] as const

type Sub = 'picker' | 'settings' | 'context'

/**
 * Flag-on onboarding entry. Pack picker → pack settings → name / training age
 * → existing AuthSheet (pre-auth) or the authed advance (DebugReset / hook).
 * Does not touch sign-in code.
 */
export function PackOnboarding({
  authed,
  onSkip,
  onAuthedComplete,
}: {
  authed: boolean
  onSkip: () => void
  onAuthedComplete: () => void
}) {
  const packs = visibleStarterPacks()
  const [sub, setSub] = useState<Sub>('picker')
  const [packId, setPackId] = useState<StarterPackId | null>(null)
  const [sport, setSport] = useState('')
  const [season, setSeason] = useState<Season>('off')
  const [gameDays, setGameDays] = useState<string[]>([])
  const [sessionsPick, setSessionsPick] = useState<2 | 3 | 4>(3)
  const [squat, setSquat] = useState('')
  const [bench, setBench] = useState('')
  const [deadlift, setDeadlift] = useState('')
  const [runDays, setRunDays] = useState(2)
  const [name, setName] = useState('')
  const [trainingAge, setTrainingAge] = useState(2)
  const [showAuth, setShowAuth] = useState(false)

  const card = packs.find((p) => p.id === packId) ?? null

  function settingsFromForm(): PackSettings {
    return {
      sport: sport.trim(),
      season,
      game_days: gameDays,
      squat: squat.trim(),
      bench: bench.trim(),
      deadlift: deadlift.trim(),
      run_days: runDays,
    }
  }

  function commit() {
    if (!packId) return
    const resolved = resolveStarterPack({
      id: packId,
      trainingAge,
      sessionsPick: packId === 'sport_sc' ? sessionsPick : undefined,
      settings: settingsFromForm(),
    })
    writeStarterPack(stashFromResolved(resolved, name))
    if (authed) onAuthedComplete()
    else setShowAuth(true)
  }

  return (
    <>
      <FunnelFrame>
        {sub === 'picker' && (
          <Picker
            packs={packs}
            selected={packId}
            onSelect={(id) => { setPackId(id); setSub('settings') }}
            onSkip={onSkip}
          />
        )}
        {sub === 'settings' && card && (
          <Settings
            card={card}
            sport={sport}
            season={season}
            gameDays={gameDays}
            sessionsPick={sessionsPick}
            squat={squat}
            bench={bench}
            deadlift={deadlift}
            runDays={runDays}
            onSport={setSport}
            onSeason={setSeason}
            onGameDays={setGameDays}
            onSessionsPick={setSessionsPick}
            onSquat={setSquat}
            onBench={setBench}
            onDeadlift={setDeadlift}
            onRunDays={setRunDays}
            onBack={() => setSub('picker')}
            onNext={() => setSub('context')}
          />
        )}
        {sub === 'context' && card && (
          <Context
            card={card}
            name={name}
            trainingAge={trainingAge}
            onName={setName}
            onTrainingAge={setTrainingAge}
            onBack={() => setSub('settings')}
            onNext={commit}
          />
        )}
      </FunnelFrame>
      {showAuth && <AuthSheet onClose={() => setShowAuth(false)} />}
    </>
  )
}

function Picker({
  packs,
  selected,
  onSelect,
  onSkip,
}: {
  packs: StarterPackCard[]
  selected: StarterPackId | null
  onSelect: (id: StarterPackId) => void
  onSkip: () => void
}) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <p className="eyebrow" style={{ marginBottom: 10 }}>Starter pack</p>
          <h1 className="hero-headline" style={{ marginBottom: 10 }}>
            How do you want to start?
          </h1>
          <p className="text-sm text-dim" style={{ marginBottom: 28 }}>
            A pack seeds days and the first-session prior. The engine still clamps every load.
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {packs.map((pack) => {
            const isSel = selected === pack.id
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => onSelect(pack.id)}
                style={{
                  textAlign: 'left',
                  padding: '16px 16px',
                  borderRadius: 12,
                  background: isSel ? 'rgba(232,204,10,0.06)' : 'var(--surface)',
                  border: `1px solid ${isSel ? 'var(--signal)' : 'var(--line)'}`,
                  cursor: 'pointer',
                }}
              >
                <div style={{
                  fontSize: 'var(--fs-lg)',
                  fontWeight: 700,
                  color: isSel ? 'var(--signal)' : 'var(--text)',
                  marginBottom: 6,
                }}>
                  {pack.title}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.45, marginBottom: 10 }}>
                  {pack.who}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-micro)',
                  letterSpacing: '0.04em',
                  color: 'var(--text-dim)',
                  lineHeight: 1.6,
                }}>
                  {pack.days} · {pack.length}
                </div>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-dim"
          style={{
            marginTop: 28,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            width: '100%',
            textAlign: 'center',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Skip — use the classic setup
        </button>
      </div>
    </div>
  )
}

function ChipRow({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string | null
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((opt) => {
        const on = value === opt
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              minHeight: 36,
              padding: '6px 12px',
              borderRadius: 999,
              border: `1px solid ${on ? 'var(--signal)' : 'var(--line)'}`,
              background: on ? 'rgba(232,204,10,0.08)' : 'transparent',
              color: on ? 'var(--signal)' : 'var(--text)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function Settings({
  card,
  sport,
  season,
  gameDays,
  sessionsPick,
  squat,
  bench,
  deadlift,
  runDays,
  onSport,
  onSeason,
  onGameDays,
  onSessionsPick,
  onSquat,
  onBench,
  onDeadlift,
  onRunDays,
  onBack,
  onNext,
}: {
  card: StarterPackCard
  sport: string
  season: Season
  gameDays: string[]
  sessionsPick: 2 | 3 | 4
  squat: string
  bench: string
  deadlift: string
  runDays: number
  onSport: (v: string) => void
  onSeason: (v: Season) => void
  onGameDays: (v: string[]) => void
  onSessionsPick: (v: 2 | 3 | 4) => void
  onSquat: (v: string) => void
  onBench: (v: string) => void
  onDeadlift: (v: string) => void
  onRunDays: (v: number) => void
  onBack: () => void
  onNext: () => void
}) {
  const sportReady = card.id !== 'sport_sc' || sport.trim().length > 0

  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <p className="eyebrow" style={{ marginBottom: 10 }}>Starter pack</p>
          <h1 className="hero-headline" style={{ marginBottom: 8 }}>{card.title}</h1>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              letterSpacing: '0.04em',
              color: 'var(--text-dim)',
              marginBottom: 28,
              lineHeight: 1.6,
            }}
          >
            {card.days} · {card.length}
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {card.id === 'sport_sc' && (
            <>
              <Field label="Days / week">
                <ChipRow
                  options={SPORT_DAYS.map(String)}
                  value={String(sessionsPick)}
                  onChange={(v) => onSessionsPick(Number(v) as 2 | 3 | 4)}
                />
              </Field>
              <Field label="Sport">
                <ChipRow
                  options={SPORT_CHIPS}
                  value={SPORT_CHIPS.includes(sport) ? sport : sport ? 'Other' : null}
                  onChange={(v) => onSport(v === 'Other' ? '' : v)}
                />
                <Input
                  type="text"
                  placeholder="Basketball, soccer, tennis…"
                  value={sport}
                  onChange={(e) => onSport(e.target.value)}
                  style={{ marginTop: 10 }}
                />
              </Field>
              <Field label="Season">
                <ChipRow
                  options={['In-season', 'Off-season']}
                  value={season === 'in' ? 'In-season' : 'Off-season'}
                  onChange={(v) => onSeason(v === 'In-season' ? 'in' : 'off')}
                />
              </Field>
              <Field label="Game / practice days">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {DOW.map((d) => {
                    const on = gameDays.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => onGameDays(on ? gameDays.filter((x) => x !== d) : [...gameDays, d])}
                        style={{
                          minHeight: 36,
                          padding: '6px 12px',
                          borderRadius: 999,
                          border: `1px solid ${on ? 'var(--signal)' : 'var(--line)'}`,
                          background: on ? 'rgba(232,204,10,0.08)' : 'transparent',
                          color: on ? 'var(--signal)' : 'var(--text)',
                          fontSize: 'var(--fs-sm)',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
                <p className="text-sm text-dim" style={{ marginTop: 8 }}>
                  Noted only — we do not pin sessions to game days.
                </p>
              </Field>
            </>
          )}

          {card.id === 'chase_total' && (
            <Field label="Recent lifts (optional)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Input mono placeholder="Squat" value={squat} onChange={(e) => onSquat(e.target.value)} />
                <Input mono placeholder="Bench" value={bench} onChange={(e) => onBench(e.target.value)} />
                <Input mono placeholder="Deadlift" value={deadlift} onChange={(e) => onDeadlift(e.target.value)} />
              </div>
            </Field>
          )}

          {card.id === 'hybrid' && (
            <Field label="Run days / week">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <span className="text-sm text-dim">Stored as a setting. Lift days stay 3.</span>
                <span className="num text-signal" style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>{runDays}</span>
              </div>
              <input
                type="range"
                className="mono-slider"
                min={0}
                max={7}
                value={runDays}
                onChange={(e) => onRunDays(parseInt(e.target.value, 10))}
              />
            </Field>
          )}

          {card.id !== 'sport_sc' && card.id !== 'chase_total' && card.id !== 'hybrid' && (
            <p className="text-sm text-dim" style={{ lineHeight: 1.5 }}>{card.who}</p>
          )}
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 40, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onNext} disabled={!sportReady} style={{ flex: 2 }}>Continue →</Button>
        </div>
      </div>
    </div>
  )
}

function Context({
  card,
  name,
  trainingAge,
  onName,
  onTrainingAge,
  onBack,
  onNext,
}: {
  card: StarterPackCard
  name: string
  trainingAge: number
  onName: (v: string) => void
  onTrainingAge: (v: number) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <p className="eyebrow" style={{ marginBottom: 10 }}>Calibrating your session</p>
          <h1 className="hero-headline" style={{ marginBottom: 10 }}>
            What should I call you?
          </h1>
          <p className="text-sm text-dim" style={{ marginBottom: 28 }}>Optional — skip the name if you'd rather.</p>
        </div>

        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          <Input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            autoCapitalize="words"
            autoFocus
          />
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span className="section-header">Training age</span>
              <span className="num text-signal" style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>
                {trainingAge} {trainingAge === 1 ? 'year' : 'years'}
              </span>
            </div>
            <input
              type="range"
              className="mono-slider"
              min={0}
              max={25}
              value={trainingAge}
              onChange={(e) => onTrainingAge(parseInt(e.target.value, 10))}
            />
          </div>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              letterSpacing: '0.04em',
              color: 'var(--text-dim)',
            }}
          >
            {card.title} · {card.days} · {card.length}
          </p>
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 40, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onNext} style={{ flex: 2 }}>
            {name.trim() ? 'Continue →' : 'Skip →'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="section-header" style={{ display: 'block', marginBottom: 10 }}>{label}</span>
      {children}
    </div>
  )
}

export default PackOnboarding
