import { Logo, Button, SectionHeader } from '../../components/ui'

/**
 * Screen 05 · Training Context
 * Two sliders — faster on mobile, more tactile, harder to overthink than number
 * fields. Mono number labels carry the telemetry aesthetic.
 */
export function TrainingContextScreen({
  trainingAge,
  sessions,
  onChange,
  onNext,
  onBack,
}: {
  trainingAge: number
  sessions: number
  onChange: (field: 'trainingAge' | 'sessions', value: number) => void
  onNext: () => void
  onBack: () => void
}) {
  return (
    <div className="screen" style={{ minHeight: '100dvh' }}>
      <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--line)' }}>
        <Logo />
      </div>

      <div style={{ flex: 1, padding: '32px 20px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
        <div className="fade-rise">
          <SectionHeader>ORIENTATION</SectionHeader>
          <h1 className="hero-headline" style={{ fontSize: 24, marginTop: 10, marginBottom: 32 }}>
            How you train now.
          </h1>
        </div>

        <div className="fade-rise fade-rise-delay-1" style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          <Slider
            label="TRAINING AGE"
            value={trainingAge}
            min={0}
            max={25}
            display={`${trainingAge} ${trainingAge === 1 ? 'year' : 'years'}`}
            onChange={(v) => onChange('trainingAge', v)}
          />
          <Slider
            label="SESSIONS / WEEK"
            value={sessions}
            min={1}
            max={7}
            display={`${sessions}`}
            onChange={(v) => onChange('sessions', v)}
          />
        </div>

        <div className="fade-rise fade-rise-delay-2" style={{ marginTop: 40, display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onBack} style={{ flex: 1 }}>← Back</Button>
          <Button variant="primary" onClick={onNext} style={{ flex: 2 }}>Continue →</Button>
        </div>
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  display: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <span
          className="num text-dim"
          style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {label}
        </span>
        <span className="num text-signal" style={{ fontSize: 18, fontWeight: 600 }}>
          {display}
        </span>
      </div>
      <input
        type="range"
        className="mono-slider"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
    </div>
  )
}
