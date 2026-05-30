import { useState } from 'react'
import { TargetScreen } from './TargetScreen'
import { IdentityScreen } from './IdentityScreen'
import { TrainingContextScreen } from './TrainingContextScreen'
import { AcknowledgmentScreen } from './AcknowledgmentScreen'
import { FunnelFrame } from '../../components/layout/FunnelFrame'
import type { AthleteRow } from '../../types/database'

export interface OrientationFields {
  target: string
  name: string
  trainingAge: number
  sessions: number
}

type OrientationSub = 'target' | 'identity' | 'context' | 'acknowledgment'

/**
 * Orientation — calibrates the first session. Leads with the TARGET (the durable
 * anchor: "what are you chasing?", agent-tailored from the obstacle). Then
 * training age + sessions/week (load-bearing for the safety clamp + program
 * shape); name is optional warmth. No sport, no movement screen.
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
  const [sub, setSub] = useState<OrientationSub>('target')
  const [fields, setFields] = useState<OrientationFields>({
    target: athlete.goals ?? '',
    name: athlete.name ?? '',
    trainingAge: athlete.training_age ?? 6,
    sessions: athlete.sessions_per_week ?? 4,
  })

  return (
    <FunnelFrame>
      {sub === 'target' && (
        <TargetScreen
          obstacle={obstacle}
          initial={fields.target}
          onNext={(target) => { setFields((f) => ({ ...f, target })); setSub('identity') }}
        />
      )}

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
    </FunnelFrame>
  )
}
