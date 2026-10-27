/** Shared program-design shapes. Kept off `agentClient.ts` so Worker/MCP
 *  can import pack helpers without pulling the browser agent client. */

export interface ProgramExercise {
  name: string
  sets: number
  reps: string
  load: 'bodyweight' | 'light' | 'moderate'
  cue: string
}

export interface ProgramDesignResult {
  goal: string
  non_negotiables: string[]
  sessions: Array<{ name: string; intent: string; exercises: ProgramExercise[] }>
}
