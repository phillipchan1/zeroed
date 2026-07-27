import {
  type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes,
  useEffect, useRef, useState,
} from 'react'
import { X, ChevronRight, ChevronDown, ChevronLeft } from 'lucide-react'

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

// ============================================================================
// MOBILE PRIMITIVES
// The vocabulary the screens are built from. Each one exists so a screen can
// show something instead of explaining it — and so touch targets, type sizes
// and sheet behaviour are decided once, here, not re-invented per screen.
// ============================================================================

// ---- Bottom sheet — the sub-screen ------------------------------------------
// Detail that used to live inline on a page now lives in one of these: capped
// height, internal scroll, a grab handle, and a close target you can hit.

interface SheetProps {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  /** Rendered in a sticky footer so the action never scrolls out of reach. */
  actions?: ReactNode
  /** Set false for a sheet that must be dismissed via its own controls. */
  dismissOnBackdrop?: boolean
  /**
   * Hides the × and disables Escape. For a sheet whose only exits are explicit
   * choices — the debrief, where "dismiss" would silently mean "commit without
   * one" and an × next to a Skip button is just ambiguous.
   */
  hideClose?: boolean
}

export function Sheet({
  title, subtitle, onClose, children, actions,
  dismissOnBackdrop = true, hideClose = false,
}: SheetProps) {
  // Escape closes, and the page underneath stops scrolling while a sheet is up
  // (otherwise a flick past the sheet's end drags the page behind it on iOS).
  // #root is the scroll container on mobile, not body — locking body alone
  // leaves the page scrollable behind the sheet.
  //
  // onClose is read through a ref so an inline arrow from the parent doesn't
  // re-run this effect on every render, briefly unlocking scroll mid-commit.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hideClose) closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    const root = document.getElementById('root')
    const prevBody = document.body.style.overflow
    const prevRoot = root?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (root) root.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevBody
      if (root) root.style.overflow = prevRoot
    }
  }, [hideClose])

  return (
    <div
      className="obs-sheet"
      onClick={dismissOnBackdrop ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="obs-sheet__inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="sheet-head__title">{title}</h2>
            {subtitle && <p className="sheet-head__sub">{subtitle}</p>}
          </div>
          {!hideClose && (
            <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
              <X size={20} strokeWidth={2} />
            </button>
          )}
        </div>
        {children}
        {actions && <div className="sheet-actions">{actions}</div>}
      </div>
    </div>
  )
}

// ---- Page header — every screen opens the same way --------------------------

interface PageHeaderProps {
  eyebrow?: string
  title: string
  subtitle?: string
  action?: { label: string; onClick: () => void }
  onBack?: () => void
}

export function PageHeader({ eyebrow, title, subtitle, action, onBack }: PageHeaderProps) {
  return (
    <>
      {onBack && (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={24} strokeWidth={2} />
        </button>
      )}
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          {eyebrow && <p className="eyebrow" style={{ marginBottom: 6 }}>{eyebrow}</p>}
          <h1 className="screen-title">{title}</h1>
          {subtitle && <p className="page-head__sub">{subtitle}</p>}
        </div>
        {action && (
          <button type="button" className="page-head__action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </>
  )
}

// ---- Stat tiles — a number beats a sentence ---------------------------------

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="stat">
      <p className="stat__value" style={tone ? { color: tone } : undefined}>{value}</p>
      <p className="stat__label">{label}</p>
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>
}

// ---- Meter — a proportion, drawn ---------------------------------------------

export function Meter({ value, tone }: { value: number; tone?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="meter">
      <div className="meter__fill" style={{ width: `${pct}%`, background: tone }} />
    </div>
  )
}

// ---- Progress ring — "3 of 4" as one glyph ----------------------------------

interface RingProps {
  value: number          // 0–1
  size?: number
  stroke?: number
  tone?: string
  children?: ReactNode   // centred label
}

export function Ring({ value, size = 72, stroke = 6, tone, children }: RingProps) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg className="ring" width={size} height={size} aria-hidden>
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="ring__fill"
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke={tone}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
        />
      </svg>
      {children && <div className="ring-wrap__label">{children}</div>}
    </div>
  )
}

// ---- Status chip ------------------------------------------------------------

type ChipTone = 'todo' | 'doing' | 'done' | 'pending' | 'info'

export function Chip({ tone = 'todo', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}

// ---- Tappable row — the way into a sub-screen -------------------------------

interface RowProps {
  title: ReactNode
  sub?: ReactNode
  value?: ReactNode
  onClick?: () => void
  leading?: ReactNode
  chevron?: boolean
}

export function Row({ title, sub, value, onClick, leading, chevron = true }: RowProps) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      className="row"
      onClick={onClick}
      {...(onClick ? { type: 'button' as const } : {})}
    >
      {leading}
      <span className="row__body">
        <span className="row__title" style={{ display: 'block' }}>{title}</span>
        {sub && <span className="row__sub" style={{ display: 'block' }}>{sub}</span>}
      </span>
      {value != null && <span className="row__value">{value}</span>}
      {onClick && chevron && (
        <span className="row__chev"><ChevronRight size={20} strokeWidth={2} /></span>
      )}
    </Tag>
  )
}

// ---- Disclosure — detail that stays folded until asked for ------------------

interface DisclosureProps {
  label: string
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

export function Disclosure({ label, meta, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure__btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <span className="disclosure__meta">
          {meta}
          <span className={`disclosure__chev${open ? ' disclosure__chev--open' : ''}`}>
            <ChevronDown size={18} strokeWidth={2} />
          </span>
        </span>
      </button>
      {open && <div className="disclosure__body">{children}</div>}
    </div>
  )
}

// ---- Banner — the single attention slot ------------------------------------

interface BannerProps {
  title: string
  sub?: string
  tone?: 'signal' | 'good' | 'quiet'
  icon?: ReactNode
  onClick?: () => void
  trailing?: ReactNode
}

export function Banner({ title, sub, tone = 'signal', icon, onClick, trailing }: BannerProps) {
  const cls = `banner${tone === 'good' ? ' banner--good' : tone === 'quiet' ? ' banner--quiet' : ''}`
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={cls} onClick={onClick} {...(onClick ? { type: 'button' as const } : {})}>
      {icon}
      <span className="banner__body">
        <span className="banner__title" style={{ display: 'block' }}>{title}</span>
        {sub && <span className="banner__sub" style={{ display: 'block' }}>{sub}</span>}
      </span>
      {trailing ?? (onClick ? <ChevronRight size={20} strokeWidth={2} color="var(--text-dim)" /> : null)}
    </Tag>
  )
}

// ---- Ambient / telemetry primitives ----------------------------------------

export function PresenceDot() {
  return <span className="presence-dot" />
}

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date
}

function relativeFrom(anchor: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - anchor.getTime()) / 1000))
  if (secs < 60)    return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60)    return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24)   return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

interface LatencyTickProps {
  anchor: Date | string | null
}

export function LatencyTick({ anchor }: LatencyTickProps) {
  const date = toDate(anchor)
  const [, setNow] = useState(0)

  useEffect(() => {
    if (!date) return
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [date?.getTime()])

  if (!date) return null
  return <span>updated {relativeFrom(date)}</span>
}

interface TelemetryStripProps {
  items: Array<{ label: string; value: string | number; signal?: boolean }>
  presence?: boolean
  lastSignalAt?: Date | string | null
}

export function TelemetryStrip({ items, presence = true, lastSignalAt }: TelemetryStripProps) {
  const pills: ReactNode[] = []

  if (presence) {
    pills.push(
      <span key="presence" className="telemetry-strip__item">
        <PresenceDot />
      </span>,
    )
  }

  items.forEach((item, i) => {
    if (pills.length > 0) pills.push(<span key={`sep-${i}`} className="telemetry-strip__sep">·</span>)
    pills.push(
      <span
        key={`item-${i}`}
        className={`telemetry-strip__item${item.signal ? ' telemetry-strip__signal' : ''}`}
      >
        {item.label} {item.value}
      </span>,
    )
  })

  if (toDate(lastSignalAt)) {
    pills.push(<span key="sep-latency" className="telemetry-strip__sep">·</span>)
    pills.push(
      <span key="latency" className="telemetry-strip__item">
        <LatencyTick anchor={lastSignalAt!} />
      </span>,
    )
  }

  return <div className="telemetry-strip">{pills}</div>
}

// ---- TypeOn — one-shot type-on reveal --------------------------------------

interface TypeOnProps {
  text: string
  delay?: number
  className?: string
}

export function TypeOn({ text, delay = 60, className }: TypeOnProps) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    setCount(0)
    if (!text) return
    let i = 0
    const id = setInterval(() => {
      i += 1
      setCount(i)
      if (i >= text.length) clearInterval(id)
    }, delay)
    return () => clearInterval(id)
  }, [text, delay])

  return <span className={className}>{text.slice(0, count)}</span>
}

// ---- Markdown — lightweight renderer for coach copy ------------------------
// The coach speaks markdown (**bold**, *italic*, `code`, - bullets). The model
// output was rendering raw, asterisks and all. This is a small, safe subset —
// no HTML injection: every node is built as React, never dangerouslySetInnerHTML.

// Inline: **bold**, __bold__, *italic*, _italic_, `code`. Flat (no nesting) by
// design — coach copy never nests emphasis, and flat keeps the parser honest.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])|`([^`]+)`)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[2] !== undefined || m[3] !== undefined) {
      nodes.push(<strong key={key++}>{m[2] ?? m[3]}</strong>)
    } else if (m[4] !== undefined || m[5] !== undefined) {
      nodes.push(<em key={key++}>{m[4] ?? m[5]}</em>)
    } else if (m[6] !== undefined) {
      nodes.push(<code key={key++}>{m[6]}</code>)
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

interface MarkdownProps {
  text: string
  className?: string
  style?: React.CSSProperties
}

export function Markdown({ text, className, style }: MarkdownProps) {
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: string[] = []
  let ordered = false
  let key = 0

  const flushPara = () => {
    if (para.length) { blocks.push(<p key={key++}>{renderInline(para.join(' '))}</p>); para = [] }
  }
  const flushList = () => {
    if (!list.length) return
    const items = list.map((li, i) => <li key={i}>{renderInline(li)}</li>)
    blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>)
    list = []
  }

  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }
    const heading = line.match(/^(#{1,3})\s+(.*)/)
    const bullet = line.match(/^[-*]\s+(.*)/)
    const numbered = line.match(/^\d+[.)]\s+(.*)/)
    if (heading) {
      flushPara(); flushList()
      const Tag = (`h${heading[1].length}`) as 'h1' | 'h2' | 'h3'
      blocks.push(<Tag key={key++}>{renderInline(heading[2])}</Tag>)
    } else if (bullet) {
      flushPara(); if (ordered) flushList(); ordered = false; list.push(bullet[1])
    } else if (numbered) {
      flushPara(); if (!ordered && list.length) flushList(); ordered = true; list.push(numbered[1])
    } else {
      flushList(); para.push(line)
    }
  }
  flushPara(); flushList()

  return <div className={`md${className ? ` ${className}` : ''}`} style={style}>{blocks}</div>
}

// ---- TickingNumber — animates integer changes ------------------------------

interface TickingNumberProps {
  value: number
  duration?: number
  className?: string
  style?: React.CSSProperties
}

export function TickingNumber({ value, duration = 350, className, style }: TickingNumberProps) {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef(value)

  useEffect(() => {
    const from = prevRef.current
    const to = value
    prevRef.current = value
    if (from === to) return

    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)  // ease-out cubic
      setDisplay(Math.round(from + (to - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else setDisplay(to)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <span className={className} style={style}>{display}</span>
}

// ---- BracketFrame — subtle corner brackets ---------------------------------

export function BracketFrame({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`bracket-frame ${className}`} style={style}>
      <span className="bracket-frame__tr" />
      <span className="bracket-frame__bl" />
      {children}
    </div>
  )
}

// ---- Insight card ----------------------------------------------------------

import type { InsightRow, InsightStatus } from '../../types/database'
import type { InsightMovement, StatusCount } from '../../engine'

// Attribution helpers — mono, dim, telemetric.
const STATUS_ABBR: Record<InsightStatus, string> = {
  hypothesis: 'HYP',
  likely: 'LIKELY',
  confirmed: 'CONF',
  resolved: 'RSLV',
  disproved: 'DISP',
}

const SOURCE_LABEL: Record<string, string> = {
  diagnostic: 'DIAGNOSTIC',
  session_observation: 'SESSION',
}

function attrTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
}

function InsightAttribution({ insight }: { insight: InsightRow }) {
  const sourceLabel = insight.source
    ? SOURCE_LABEL[insight.source] ?? insight.source.toUpperCase()
    : '—'
  const wasUpdated = new Date(insight.updated_at).getTime() - new Date(insight.generated_at).getTime() > 1000
  return (
    <p className="insight-attr">
      generated {attrTime(insight.generated_at)} · {sourceLabel}
      {wasUpdated && ` · updated ${attrTime(insight.updated_at)}`}
    </p>
  )
}

interface InsightCardProps {
  insight: InsightRow
  pulse?: boolean
  typeOn?: boolean
}

export function InsightCard({ insight, pulse, typeOn }: InsightCardProps) {
  const priorityKey = insight.priority.toLowerCase() as 'p1' | 'p2' | 'p3' | 'p4'
  const transitioned = insight.prev_status != null && insight.prev_status !== insight.status

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
          {transitioned ? (
            <span className="transition-pill">
              {STATUS_ABBR[insight.prev_status!]} → {STATUS_ABBR[insight.status]}
            </span>
          ) : (
            <span className="text-xs text-dim" style={{ textTransform: 'capitalize' }}>
              {insight.status}
            </span>
          )}
        </div>
      </div>
      <p className="text-base" style={{ lineHeight: 1.5 }}>
        {typeOn ? <TypeOn text={insight.claim} delay={18} /> : insight.claim}
      </p>
      {insight.program_impact && (
        <p className="text-xs text-dim" style={{ marginTop: 8, lineHeight: 1.5 }}>{insight.program_impact}</p>
      )}
      <InsightAttribution insight={insight} />
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
            fontSize: 'var(--fs-micro)',
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
    <Sheet title="Why this exercise" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <PriorityBadge priority={insight.priority} />
        <span className="text-xs text-dim">{insight.category}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <StatusDot status={insight.status} />
          <span className="text-xs text-dim" style={{ textTransform: 'capitalize' }}>{insight.status}</span>
        </span>
      </div>

      <p className="text-lg" style={{ lineHeight: 1.45, marginBottom: 16 }}>{insight.claim}</p>

      {insight.program_impact && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="section-header" style={{ marginBottom: 6 }}>Program impact</p>
          <p className="text-sm" style={{ lineHeight: 1.55 }}>{insight.program_impact}</p>
        </div>
      )}
    </Sheet>
  )
}
