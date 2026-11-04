import { RULE_LABEL, refusalTitle, targetParts, type PreviewWarning, type WarningsView } from '../../lib/previewWarnings'

function WarningRow({ w }: { w: PreviewWarning }) {
  const t = targetParts(w.target)
  return (
    <li className={`pwarn__row${w.blocking ? ' pwarn__row--block' : ''}`}>
      <p className="pwarn__k">
        <span className="pwarn__rule num">{w.rule}</span>
        <span>{RULE_LABEL[w.rule]}</span>
        <span className="pwarn__target">{t.label}</span>
      </p>
      <p className="pwarn__msg">{w.message}</p>
    </li>
  )
}

/**
 * What the engine's validators said about a preview (tracks_v1, G5): a
 * refusal (U13, red flag) up top in the veto colour, then the warnings (U8–U10),
 * each with its rule, the session or exercise it is about, and the message in
 * plain words. Renders nothing when there is nothing to say.
 */
export function PreviewWarnings({ view }: { view: WarningsView }) {
  if (!view.refusal && !view.notes.length) return null
  return (
    <div className="pwarn">
      {view.refusal && (
        <div className="pwarn__refusal" role="alert">
          <p className="pwarn__title">{refusalTitle(view.refusal)}</p>
          <ul className="pwarn__list"><WarningRow w={view.refusal} /></ul>
        </div>
      )}
      {view.notes.length > 0 && (
        <>
          <p className="pwarn__title pwarn__title--note">
            {view.notes.length === 1 ? 'One thing to know' : `${view.notes.length} things to know`}
          </p>
          <ul className="pwarn__list">
            {view.notes.map((w, i) => <WarningRow key={`${w.rule}-${w.target}-${i}`} w={w} />)}
          </ul>
        </>
      )}
    </div>
  )
}
