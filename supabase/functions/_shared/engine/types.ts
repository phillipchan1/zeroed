export type TrackingType = 'weight_reps' | 'bodyweight_reps' | 'time' | 'distance'

export interface ExerciseTemplate {
  name: string
  sets: number
  reps: string
  load?: string
  cue?: string
  target_rpe?: number
  rpe_source?: 'coach'
  insight_id?: string
  tracking_type?: TrackingType
  reading?: boolean
  pattern_key?: string
  reading_why?: string
  swapped_from?: string   // a stand-in's programmed movement — see src/types/database.ts
  added?: boolean         // added mid-session, never on the program — see src/types/database.ts
  adjusted?: boolean      // an interval block re-dosed for one session — see src/types/database.ts
  track_id?: string
  superset_group?: string
  rest_s?: number
  contacts?: number
  kind?: ExerciseKind      // skill_blocks_v1 — see src/types/database.ts
  window_s?: number        // skill block's suggested window, display only
}

export type ExerciseKind = 'skill' | 'interval'

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
  track?: string | null
  track_id?: string | null
  superset_group?: string | null
  rest_s?: number | null
  contacts?: number | null
  kind?: ExerciseKind | null
  window_s?: number | null
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
  track?: string | null
  track_id?: string | null
  superset_group?: string | null
  rest_s?: number | null
  contacts?: number | null
  kind?: ExerciseKind | null
  window_s?: number | null
}
