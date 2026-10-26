export type TrackingType = 'weight_reps' | 'bodyweight_reps' | 'time' | 'distance'

export interface ExerciseTemplate {
  name: string
  sets: number
  reps: string
  load?: string
  cue?: string
  target_rpe?: number
  insight_id?: string
  tracking_type?: TrackingType
  reading?: boolean
  pattern_key?: string
  reading_why?: string
  swapped_from?: string   // a stand-in's programmed movement — see src/types/database.ts
}

export interface SetLog {
  set: number
  weight: number | null
  reps: number | null
  rpe: number | null
  done: boolean
  duration?: number | null
  distance?: number | null
  missed_reps?: number | null   // see src/types/database.ts
}

export interface ProgramEditExercise {
  name: string
  sets: number
  reps: string
  load: string
  cue: string
  target_rpe: number | null
}

export interface ProgramEdit {
  type:
    | 'add_exercise' | 'update_exercise' | 'remove_exercise'
    | 'add_session' | 'update_session' | 'set_sessions_per_week' | 'add_note'
  rationale: string
  session_name: string | null
  exercise_name: string | null
  after_exercise: string | null
  set_name: string | null
  set_intent: string | null
  set_session_type: string | null
  set_intended_dow: number | null
  sets: number | null
  reps: string | null
  load: string | null
  cue: string | null
  target_rpe: number | null
  sessions_per_week: number | null
  note: string | null
  exercises: ProgramEditExercise[]
}
