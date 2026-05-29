import { useState } from 'react'
import { IdentityScreen } from './IdentityScreen'
import { TrainingContextScreen } from './TrainingContextScreen'
import { AcknowledgmentScreen } from './AcknowledgmentScreen'
import type { AthleteRow } from '../../types/database'

export interface OrientationFields {
  name: string
  sport: string
  trainingAge: number
  sessions: number
}

type OrientationSub = 'identity' | 'context' | 'acknowledgment'

/**
 * Act 2 — Orientation (Screens 04–06). Collects identity + training context,
 * then proves the system read it on the acknowledgment screen. Fields are held
 * locally and persisted in one write when the athlete runs the screen.
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
    sport: athlete.sport ?? '',
    trainingAge: athlete.training_age ?? 6,
    sessions: athlete.sessions_per_week ?? 4,
  })

  return (
    <>
      {sub === 'identity' && (
        <IdentityScreen
          name={fields.name}
          sport={fields.sport}
          onChange={(field, value) => setFields((f) => ({ ...f, [field]: value }))}
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
          sport={fields.sport}
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
