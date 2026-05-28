import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'

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
