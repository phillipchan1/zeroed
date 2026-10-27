import { admin } from './admin.ts'
import type { OnboardingIo, OnboardingSnapshot } from './onboardingTools.ts'
import type { InsightSnap, OnboardingAnswers } from '../../../src/engine/onboardingConnector.ts'
import type { PackSettings } from '../../../src/engine/starterPacks.ts'

function asObject<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T } catch { return null }
  }
  return typeof value === 'object' ? value as T : null
}

export function edgeOnboardingIo(athleteId: string): OnboardingIo {
  return {
    async loadSnapshot(): Promise<OnboardingSnapshot> {
      const { data, error } = await admin
        .from('athlete')
        .select('onboarding_step, starter_pack, starter_pack_settings, onboarding_answers, name, training_age, goals, sessions_per_week, obstacle, sport')
        .eq('id', athleteId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) throw new Error('Athlete row missing')
      return {
        onboarding_step: data.onboarding_step as string,
        starter_pack: (data.starter_pack as string | null) ?? null,
        starter_pack_settings: asObject<PackSettings>(data.starter_pack_settings),
        onboarding_answers: asObject<OnboardingAnswers>(data.onboarding_answers),
        name: (data.name as string | null) ?? null,
        training_age: (data.training_age as number | null) ?? null,
        goals: (data.goals as string | null) ?? null,
        sessions_per_week: (data.sessions_per_week as number | null) ?? null,
        obstacle: (data.obstacle as string | null) ?? null,
        sport: (data.sport as string | null) ?? null,
      }
    },

    async loadInsights(): Promise<InsightSnap[]> {
      const { data, error } = await admin
        .from('insight')
        .select('claim, category, confidence, status, priority')
        .eq('athlete_id', athleteId)
        .order('priority')
      if (error) throw new Error(error.message)
      return (data ?? []).map((r) => ({
        claim: r.claim as string,
        category: r.category as string,
        confidence: Number(r.confidence),
        status: r.status as string,
        priority: r.priority as string,
      }))
    },

    async hasLiveProgram(): Promise<boolean> {
      const { data, error } = await admin
        .from('program')
        .select('id')
        .eq('athlete_id', athleteId)
        .eq('status', 'active')
        .maybeSingle()
      if (error) throw new Error(error.message)
      return Boolean(data?.id)
    },

    async saveAnswers(answers: OnboardingAnswers): Promise<void> {
      const { error } = await admin
        .from('athlete')
        .update({ onboarding_answers: answers })
        .eq('id', athleteId)
      if (error) throw new Error(error.message)
    },

    async persistStart(input): Promise<{ programId: string }> {
      if (input.replace) {
        const { error: pauseErr } = await admin
          .from('program')
          .update({ status: 'paused' })
          .eq('athlete_id', athleteId)
          .eq('status', 'active')
        if (pauseErr) throw new Error(pauseErr.message)
      }
      const plan = input.plan
      const { data: prog, error: progErr } = await admin
        .from('program')
        .insert({
          athlete_id: athleteId,
          goal: plan.goal,
          start_date: plan.weekStart,
          retest_date: plan.retestDate,
          status: 'active',
        })
        .select('id')
        .single()
      if (progErr || !prog?.id) throw new Error(progErr?.message ?? 'Failed to insert program')
      const { data: phase, error: phaseErr } = await admin
        .from('phase')
        .insert({
          program_id: prog.id,
          name: plan.phaseName,
          week_start: plan.weekStart,
          week_end: plan.weekEnd,
          non_negotiables: plan.nonNegotiables,
          advancement_criteria: plan.advancementCriteria,
          status: 'active',
        })
        .select('id')
        .single()
      if (phaseErr) throw new Error(phaseErr.message)
      const { error: routineErr } = await admin.from('routine').insert(
        plan.sessions.map((s) => ({
          program_id: prog.id,
          phase_id: phase?.id ?? null,
          name: s.name,
          session_type: s.sessionType,
          exercises: s.exercises,
          intent: s.intent,
        })),
      )
      if (routineErr) throw new Error(routineErr.message)
      const { error: athErr } = await admin.from('athlete').update({
        starter_pack: input.packId,
        starter_pack_settings: input.settings,
        onboarding_answers: input.answers,
        onboarding_step: 'first_session_pending',
        name: input.athletePatch.name,
        training_age: input.athletePatch.training_age,
        goals: input.athletePatch.goals,
        sessions_per_week: input.athletePatch.sessions_per_week,
        obstacle: input.athletePatch.obstacle,
        sport: input.athletePatch.sport,
      }).eq('id', athleteId)
      if (athErr) throw new Error(athErr.message)
      const { error: profErr } = await admin.from('athlete_profile').upsert({
        athlete_id: athleteId,
        current_phase: plan.phaseName,
        retest_date: plan.retestDate,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'athlete_id' })
      if (profErr) throw new Error(profErr.message)
      return { programId: prog.id as string }
    },
  }
}
