/* The weekly review, the app's side (tracks_v1, G8 / U15).
 *
 * The Worker computes it (GET /api/weekly-review?week=): compliance against the
 * 80% target, each priority lift's e1RM trend (and how each e1RM was
 * estimated, U4 v1.1), whether maintenance lifts held, the pain trend,
 * check-in averages, session load, and the call — progress, hold or deload —
 * with its rules and one line of why. The athlete's own session sees all of
 * it. This words it (pure, checked in weeklyReview.check.ts); the fetch is
 * weeklyReviewClient.ts. With the flag off the screen never asks.
 */

export type WeeklyCall = 'progress' | 'hold' | 'deload'
export type E1rmMethod = 'rpe_chart' | 'epley'

export interface LiftTrend {
  lift: string
  e1rm_week: number | null
  e1rm_prior: number | null
  e1rm_week_method: E1rmMethod | null
  e1rm_prior_method: E1rmMethod | null
  change_pct: number | null
  trend: 'up' | 'flat' | 'down' | 'no_data'
  down_sessions: number
}

export interface MaintenanceHeld {
  exercise: string
  held: boolean | null
  why: string
}

export interface PainTrend {
  region: string
  avg: number
  max: number
  prior_avg: number | null
  trend: 'better' | 'same' | 'worse' | 'new'
}

export interface SessionLoad {
  rated: number
  with_duration: number
  rating_avg: number | null
  load_au: number
  usual_au: number | null
  vs_usual: number | null
}

export interface WeeklyReview {
  week_start: string
  week_end: string
  methodology_version: string
  compliance: { planned: number; logged: number; ratio: number | null; target: number; met: boolean | null }
  priority_lifts: LiftTrend[]
  maintenance: MaintenanceHeld[]
  pain: { regions: PainTrend[]; blocked: string[]; cap: number } | null
  checkins: { days: number; sleep_avg: number | null; stress_avg: number | null; soreness_avg: number | null; flag_days: number } | null
  session_load: SessionLoad | null
  health_hidden?: true
  call: WeeklyCall
  rule_refs: string[]
  why: string
}

export type ReviewResult =
  | { status: 'ok'; review: WeeklyReview }
  | { status: 'off' }
  | { status: 'error'; text: string }

// ---- wording (pure) --------------------------------------------------------------------------

export const CALL_LABEL: Record<WeeklyCall, string> = { progress: 'Progress', hold: 'Hold', deload: 'Deload' }
export const CALL_TONE: Record<WeeklyCall, 'done' | 'pending' | 'info'> = { progress: 'done', hold: 'pending', deload: 'info' }

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The picker: this week (no param, the athlete's own today on the Worker) and the one before. */
export function weekChoices(thisWeekStart: string): Array<{ key: 'this' | 'previous'; label: string; week: string | undefined }> {
  return [
    { key: 'this', label: 'This week', week: undefined },
    { key: 'previous', label: 'Last week', week: addDays(thisWeekStart, -7) },
  ]
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTH[Number(d.slice(5, 7)) - 1]}`

/** "3–9 Nov", "27 Oct – 2 Nov". */
export function weekRangeLabel(start: string, end: string): string {
  return start.slice(5, 7) === end.slice(5, 7)
    ? `${Number(start.slice(8, 10))}–${dayLabel(end)}`
    : `${dayLabel(start)} – ${dayLabel(end)}`
}

const pct = (r: number) => `${Math.round(r * 100)}%`

/** "3 of 4 sessions · 75%", against "target 80%". */
export function complianceLine(c: WeeklyReview['compliance']): { main: string; target: string } {
  const target = `target ${pct(c.target)}`
  if (c.ratio == null) return { main: c.logged ? `${c.logged} logged, none planned` : 'No sessions planned', target }
  return { main: `${c.logged} of ${c.planned} session${c.planned === 1 ? '' : 's'} · ${pct(c.ratio)}`, target }
}

export const METHOD_LABEL: Record<E1rmMethod, string> = { rpe_chart: 'RPE chart', epley: 'Epley' }

const LIFT_NAME: Record<string, string> = {
  squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'Overhead press', press: 'Overhead press',
}

/** "back_squat" / "bench" → a readable name. */
export function liftName(id: string): string {
  if (LIFT_NAME[id]) return LIFT_NAME[id]
  const s = id.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : id
}

/** One priority lift: "e1RM 262 lb (RPE chart), was 255 (Epley) · +2.7%". fmt shows a stored weight. */
export function liftLine(l: LiftTrend, fmt: (stored: number) => string, unit: string): { value: string; change: string } {
  const m = (x: E1rmMethod | null) => (x ? ` (${METHOD_LABEL[x]})` : '')
  if (l.e1rm_week == null) {
    return { value: l.e1rm_prior == null ? 'No top sets logged' : `Not trained this week · was ${fmt(l.e1rm_prior)} ${unit}${m(l.e1rm_prior_method)}`, change: '' }
  }
  const now = `e1RM ${fmt(l.e1rm_week)} ${unit}${m(l.e1rm_week_method)}`
  if (l.e1rm_prior == null) return { value: now, change: 'first week on record' }
  const ch = l.change_pct == null ? '' : `${l.change_pct > 0 ? '+' : l.change_pct < 0 ? '−' : '±'}${Math.abs(l.change_pct)}%`
  const down = l.down_sessions >= 2 ? ` · down ${l.down_sessions} sessions running` : ''
  return { value: `${now}, was ${fmt(l.e1rm_prior)}${m(l.e1rm_prior_method)}`, change: `${ch}${down}` }
}

export const TREND_MARK: Record<LiftTrend['trend'], string> = { up: '↑', flat: '→', down: '↓', no_data: '·' }
export const PAIN_TREND_LABEL: Record<PainTrend['trend'], string> = { better: 'better', same: 'about the same', worse: 'worse', new: 'new this week' }

export const regionLabel = (r: string) => r.replace(/_/g, ' ')

/** "avg 2.5, max 4 / 10 · better (was 3.5)". */
export function painLine(p: PainTrend): string {
  return `avg ${p.avg}, max ${p.max} / 10 · ${PAIN_TREND_LABEL[p.trend]}${p.prior_avg != null ? ` (was ${p.prior_avg})` : ''}`
}

/** "Lighter than usual" etc. from load ÷ the 4-week mean. Not a risk score. */
export function sessionLoadLine(s: SessionLoad): string {
  if (!s.rated) return 'No sessions rated'
  const au = `${s.load_au.toLocaleString('en-US')} AU`
  const rated = `${s.rated} rated${s.rating_avg != null ? `, avg ${s.rating_avg}/10` : ''}`
  if (s.vs_usual == null) return `${au} · ${rated}`
  const vs = s.vs_usual < 0.85 ? 'lighter than usual' : s.vs_usual > 1.15 ? 'heavier than usual' : 'about usual'
  return `${au} · ${vs} (${s.vs_usual}×) · ${rated}`
}

/** "Sleep 7.2 h · stress 2.4 · soreness 3 /5 · 2 flag days". */
export function checkinLine(c: NonNullable<WeeklyReview['checkins']>): string {
  if (!c.days) return 'No check-ins'
  const parts = [
    c.sleep_avg != null ? `sleep ${c.sleep_avg} h` : null,
    c.stress_avg != null ? `stress ${c.stress_avg}/5` : null,
    c.soreness_avg != null ? `soreness ${c.soreness_avg}/5` : null,
  ].filter(Boolean)
  const flags = c.flag_days ? ` · ${c.flag_days} flag day${c.flag_days === 1 ? '' : 's'}` : ''
  return `${c.days} day${c.days === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(', ')}` : ''}${flags}`
}

/** Nothing logged at all: no sessions, top sets, check-ins, pain or ratings. The call still shows. */
export function isEmptyWeek(r: WeeklyReview): boolean {
  return r.compliance.logged === 0
    && r.priority_lifts.every((l) => l.e1rm_week == null)
    && r.maintenance.every((m) => m.held == null)
    && (r.checkins?.days ?? 0) === 0
    && (r.pain?.regions.length ?? 0) === 0
    && (r.session_load?.rated ?? 0) === 0
}

/** The why line without the call's own "Progress: " prefix, which the chip already says. */
export function whyLine(r: WeeklyReview): string {
  const prefix = `${CALL_LABEL[r.call]}: `
  const rest = r.why.startsWith(prefix) ? r.why.slice(prefix.length) : r.why
  return rest ? rest[0].toUpperCase() + rest.slice(1) : rest
}
