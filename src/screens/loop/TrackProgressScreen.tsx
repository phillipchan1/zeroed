import { useParams, useNavigate } from 'react-router-dom'
import { PageHeader, Skeleton, Chip } from '../../components/ui'
import { useCachedLoader } from '../../lib/cache'
import { cacheKeys } from '../../lib/loopCache'
import { fetchGoalsView } from '../../lib/tracksData'
import { TrackLabel } from './tracksUi'
import { supabase } from '../../lib/supabaseClient'

interface TrackPage {
  name: string
  color: string
  purpose: string | null
  methodology: string | null
  engine: string | null
  deload: string | null
  retest: string | null
}

async function fetchTrackPage(athleteId: string, trackId: string): Promise<TrackPage | null> {
  const { data: program } = await supabase
    .from('program')
    .select('id, deload_week_start, retest_start, retest_end')
    .eq('athlete_id', athleteId)
    .eq('status', 'active')
    .maybeSingle()
  if (!program) return null
  const [{ data: track }, { data: rules }] = await Promise.all([
    supabase.from('track').select('id, name, color, purpose, methodology_text, deload_policy, retest_policy')
      .eq('id', trackId).eq('program_id', program.id).maybeSingle(),
    supabase.from('progression_rule').select('engine_type').eq('track_id', trackId).limit(1),
  ])
  if (!track) return null
  const t = track as { name: string; color: string | null; purpose: string | null; methodology_text: string | null }
  const engine = (rules?.[0] as { engine_type?: string } | undefined)?.engine_type ?? null
  const p = program as { deload_week_start?: string | null; retest_start?: string | null; retest_end?: string | null }
  return {
    name: t.name,
    color: t.color || '#9A9A9A',
    purpose: t.purpose,
    methodology: t.methodology_text,
    engine,
    deload: p.deload_week_start ?? null,
    retest: p.retest_start && p.retest_end ? `${p.retest_start} → ${p.retest_end}` : p.retest_start ?? null,
  }
}

export function TrackProgressScreen({ athleteId }: { athleteId: string }) {
  const { trackId } = useParams<{ trackId: string }>()
  const navigate = useNavigate()
  const { data, loading } = useCachedLoader<TrackPage | null>(
    `trackpage:${trackId}`,
    () => trackId ? fetchTrackPage(athleteId, trackId) : Promise.resolve(null),
  )
  const { data: goals } = useCachedLoader(cacheKeys.goals(athleteId), () => fetchGoalsView(athleteId))
  const mine = (goals ?? []).filter((g) => g.track_id === trackId)

  return (
    <div className="screen with-nav">
      <div className="page">
        <div className="page__main">
          <PageHeader eyebrow="Track" title={data?.name ?? 'Track'} />
          {loading && !data ? (
            <div className="card"><Skeleton height={24} width={180} /></div>
          ) : !data ? (
            <div className="card"><p className="text-base text-dim">That track isn’t on this program.</p></div>
          ) : (
            <>
              <div className="card fade-rise" style={{ marginBottom: 20 }}>
                <TrackLabel track={{ id: trackId ?? '', name: data.name, color: data.color, icon: 'circle', order: 0, purpose: data.purpose }} />
                {data.engine && <p className="num text-xs text-dim" style={{ marginTop: 10 }}>{data.engine}</p>}
                {data.purpose && <p className="text-sm" style={{ marginTop: 12, lineHeight: 1.55 }}>{data.purpose}</p>}
                {data.methodology && <p className="text-sm text-dim" style={{ marginTop: 10, lineHeight: 1.55 }}>{data.methodology}</p>}
                <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                  {data.deload && <Chip tone="pending">Deload {data.deload.slice(5)}</Chip>}
                  {data.retest && <Chip tone="info">Retest {data.retest}</Chip>}
                </div>
              </div>
              {mine.length > 0 && (
                <div className="card" style={{ marginBottom: 20 }}>
                  <p className="section-header" style={{ marginBottom: 12 }}>Goals on this track</p>
                  {mine.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="card--tap"
                      style={{ width: '100%', textAlign: 'left', padding: '10px 0', borderBottom: '1px solid var(--line)', background: 'none', color: 'var(--text)' }}
                      onClick={() => navigate('/app/goals')}
                    >
                      <span className="text-base" style={{ fontWeight: 600 }}>{g.name}</span>
                      <span className="num text-sm text-dim" style={{ display: 'block', marginTop: 4 }}>
                        {g.current ?? 'pending'} → {g.target ?? '—'} {g.unit ?? ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
