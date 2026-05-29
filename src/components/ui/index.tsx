import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { X } from 'lucide-react'

// ---- Logo / Wordmark -------------------------------------------------------

export function Logo({ signal }: { signal?: boolean }) {
  return (
    <span className={`wordmark${signal ? ' wordmark--signal' : ''}`}>
      Zeroed
    </span>
  )
}

// ---- Buttons ---------------------------------------------------------------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline'
  full?: boolean
  children: ReactNode
}

export function Button({ variant = 'primary', full, children, className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`btn btn--${variant}${full ? ' btn--full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

// ---- Input -----------------------------------------------------------------

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
}

export function Input({ mono, className = '', ...props }: InputProps) {
  return (
    <input
      className={`input${mono ? ' input--mono' : ''} ${className}`}
      {...props}
    />
  )
}

// ---- Card ------------------------------------------------------------------

interface CardProps {
  children: ReactNode
  priority?: 'p1' | 'p2' | 'p3' | 'p4'
  data?: boolean
  className?: string
  style?: React.CSSProperties
}

export function Card({ children, priority, data, className = '', style }: CardProps) {
  const cls = [
    data ? 'card--data' : 'card',
    priority ? `card--${priority}` : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} style={style}>
      {children}
    </div>
  )
}

// ---- Priority badge --------------------------------------------------------

interface BadgeProps { priority: 'P1' | 'P2' | 'P3' | 'P4' }

export function PriorityBadge({ priority }: BadgeProps) {
  return (
    <span className={`badge badge--${priority.toLowerCase()}`}>{priority}</span>
  )
}

// ---- Status dot ------------------------------------------------------------

interface StatusDotProps {
  status: 'hypothesis' | 'likely' | 'confirmed' | 'resolved' | 'disproved'
}

export function StatusDot({ status }: StatusDotProps) {
  return <span className={`status-dot status-dot--${status}`} />
}

// ---- Section header --------------------------------------------------------

export function SectionHeader({ children }: { children: ReactNode }) {
  return <span className="section-header">{children}</span>
}

// ---- Divider ---------------------------------------------------------------

export function Divider() {
  return <div className="divider" />
}

// ---- Skeleton --------------------------------------------------------------

export function Skeleton({ height = 16, width }: { height?: number; width?: number | string }) {
  return (
    <div
      className="skeleton"
      style={{ height, width: width ?? '100%', borderRadius: 4 }}
    />
  )
}

// ---- Spinner ---------------------------------------------------------------

export function Spinner() {
  return <div className="spinner" />
}

// ---- Step indicator (funnel) -----------------------------------------------

interface StepIndicatorProps {
  total: number
  current: number  // 0-indexed
}

export function StepIndicator({ total, current }: StepIndicatorProps) {
  return (
    <div className="step-indicator">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={
            i === current
              ? 'step-dot step-dot--active'
              : i < current
              ? 'step-dot step-dot--done'
              : 'step-dot'
          }
        />
      ))}
    </div>
  )
}

// ---- Score picker (0–3) ----------------------------------------------------

interface ScorePickerProps {
  value: number | null
  onChange: (score: number) => void
}

export function ScorePicker({ value, onChange }: ScorePickerProps) {
  return (
    <div className="score-picker">
      {[0, 1, 2, 3].map((score) => (
        <button
          key={score}
          type="button"
          className={`score-btn${value === score ? ' score-btn--selected' : ''}`}
          onClick={() => onChange(score)}
        >
          {score}
        </button>
      ))}
    </div>
  )
}

// ---- Insight card ----------------------------------------------------------

import type { InsightRow } from '../../types/database'
import type { InsightMovement, StatusCount } from '../../engine'

interface InsightCardProps {
  insight: InsightRow
  pulse?: boolean
}

export function InsightCard({ insight, pulse }: InsightCardProps) {
  const priorityKey = insight.priority.toLowerCase() as 'p1' | 'p2' | 'p3' | 'p4'

  return (
    <Card
      priority={priorityKey}
      className={`fade-rise${pulse ? ' pulse' : ''}`}
      style={{ marginBottom: 8 }}
    >
      <div className="flex items-center gap-2 mb-2" style={{ gap: 8 }}>
        <PriorityBadge priority={insight.priority} />
        <span className="text-xs text-dim">{insight.category}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <StatusDot status={insight.status} />
          <span className="text-xs text-dim" style={{ textTransform: 'capitalize' }}>
            {insight.status}
          </span>
        </div>
      </div>
      <p className="text-sm" style={{ lineHeight: 1.5 }}>{insight.claim}</p>
      {insight.program_impact && (
        <p className="text-xs text-dim" style={{ marginTop: 6 }}>{insight.program_impact}</p>
      )}
    </Card>
  )
}

// ---- Insight movement row (Shift 4 — "Your zero this week") ----------------

interface InsightMovementRowProps {
  movement: InsightMovement
}

export function InsightMovementRow({ movement }: InsightMovementRowProps) {
  const { insight, kind, label } = movement
  // Transitions and new signals are the highlight; evidence is quieter.
  const accent = kind === 'evidence' ? 'var(--text-dim)' : 'var(--signal)'

  return (
    <div className="card insight-move-row" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <PriorityBadge priority={insight.priority} />
        <span className="text-xs text-dim">{insight.category}</span>
        <span
          className="num"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            letterSpacing: '0.02em',
            color: accent,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <StatusDot status={insight.status} />
          {label}
        </span>
      </div>
      <p className="text-sm" style={{ lineHeight: 1.5 }}>{insight.claim}</p>
    </div>
  )
}

// ---- Status counts (Shift 6 — ProfileScreen header) ------------------------

interface StatusCountsProps {
  counts: StatusCount[]
}

export function StatusCounts({ counts }: StatusCountsProps) {
  if (counts.length === 0) return null
  return (
    <div className="status-counts">
      {counts.map(({ status, count }, i) => (
        <span key={status} className="status-counts__item">
          {i > 0 && <span className="status-counts__sep">·</span>}
          <StatusDot status={status} />
          <span className="num">{count}</span>
          <span style={{ textTransform: 'capitalize' }}>{status}</span>
        </span>
      ))}
    </div>
  )
}

// ---- Exercise insight sheet (Shift 5 — the "why" surface) ------------------

interface ExerciseInsightSheetProps {
  insight: InsightRow
  onClose: () => void
}

export function ExerciseInsightSheet({ insight, onClose }: ExerciseInsightSheetProps) {
  return (
    <div className="obs-sheet" onClick={onClose}>
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PriorityBadge priority={insight.priority} />
            <span className="text-xs text-dim">{insight.category}</span>
            <StatusDot status={insight.status} />
            <span className="text-xs text-dim" style={{ textTransform: 'capitalize' }}>
              {insight.status}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: 0, height: 28, minWidth: 28, color: 'var(--text-dim)' }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <p className="text-sm" style={{ lineHeight: 1.5, marginBottom: 12 }}>{insight.claim}</p>

        {insight.program_impact && (
          <div className="card--data" style={{ marginBottom: 12 }}>
            <p className="text-xs text-dim" style={{ marginBottom: 4, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Program impact
            </p>
            <p className="text-sm" style={{ lineHeight: 1.5 }}>{insight.program_impact}</p>
          </div>
        )}

        <p className="text-xs text-dim" style={{ lineHeight: 1.5 }}>
          This exercise is in your program because of this.
        </p>
      </div>
    </div>
  )
}
