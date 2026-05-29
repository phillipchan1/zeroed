import { useState } from 'react'
import { IdentityScreen } from './IdentityScreen'
import { TrainingContextScreen } from './TrainingContextScreen'
import { AcknowledgmentScreen } from './AcknowledgmentScreen'
import type { AthleteRow } from '../../types/database'

export interface OrientationFields {
  name: string
  trainingAge: number
  sessions: number
}

type OrientationSub = 'identity' | 'context' | 'acknowledgment'

/**
 * Orientation — calibrates the first session. Training age + sessions/week are
 * load-bearing (they drive the safety clamp + program shape); name is optional
 * warmth. No sport, no movement screen. The acknowledgment proves the system
 * read the inputs, then hands off to the provisional build.
 */
export function OrientationAct({
  athlete,
  obstacle,
  onComplete,
}: {
  athlete: AthleteRow
  obstacle: string
  onComplete: (fields: OrientationFields) => void
}) {
  const [sub, setSub] = useState<OrientationSub>('identity')
  const [fields, setFields] = useState<OrientationFields>({
    name: athlete.name ?? '',
    trainingAge: athlete.training_age ?? 6,
    sessions: athlete.sessions_per_week ?? 4,
  })

  return (
    <>
      {sub === 'identity' && (
        <IdentityScreen
          name={fields.name}
          onChange={(value) => setFields((f) => ({ ...f, name: value }))}
          onNext={() => setSub('context')}
        />
      )}

      {sub === 'context' && (
        <TrainingContextScreen
          trainingAge={fields.trainingAge}
          sessions={fields.sessions}
          onChange={(field, value) => setFields((f) => ({ ...f, [field]: value }))}
          onNext={() => setSub('acknowledgment')}
          onBack={() => setSub('identity')}
        />
      )}

      {sub === 'acknowledgment' && (
        <AcknowledgmentScreen
          name={fields.name}
          trainingAge={fields.trainingAge}
          sessions={fields.sessions}
          obstacle={obstacle}
          onRun={() => onComplete(fields)}
          onBack={() => setSub('context')}
        />
      )}
    </>
  )
}
