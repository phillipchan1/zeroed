import { asJson, jsonParam, type Sql } from './db.ts'
import type {
  OnboardingIo,
  OnboardingSnapshot,
  Session1Plan,
} from './onboardingTools.ts'
import {
  readStoredAnswers,
  wrapStoredAnswers,
  type InsightSnap,
  type OnboardingAnswers,
} from '../../src/engine/onboardingConnector.ts'
import type { PackSettings } from '../../src/engine/starterPacks.ts'

function parseSettings(value: unknown): PackSettings | null {
  if (value == null) return null
  const obj = asJson<PackSettings>(value, {})
  return obj && typeof obj === 'object' ? obj : null
}

function parseAnswers(value: unknown): OnboardingAnswers | null {
  if (value == null) return null
  const parsed = readStoredAnswers(asJson<unknown>(value, null))
  return parsed.ok ? parsed.answers : null
}

export function workerOnboardingIo(sql: Sql, athleteId: string): OnboardingIo {
  return {
    async loadSnapshot(): Promise<OnboardingSnapshot> {
      const [row] = await sql<{
        onboarding_step: string
        starter_pack: string | null
        starter_pack_settings: unknown
        onboarding_answers: unknown
        name: string | null
        training_age: number | null
        goals: string | null
        sessions_per_week: number | null
        obstacle: string | null
        sport: string | null
      }[]>`
        SELECT onboarding_step, starter_pack, starter_pack_settings, onboarding_answers,
               name, training_age, goals, sessions_per_week, obstacle, sport
        FROM athlete
        WHERE id = ${athleteId}
        LIMIT 1
      `
      if (!row) throw new Error('Athlete row missing')
      return {
        onboarding_step: row.onboarding_step,
        starter_pack: row.starter_pack,
        starter_pack_settings: parseSettings(row.starter_pack_settings),
        onboarding_answers: parseAnswers(row.onboarding_answers),
        name: row.name,
        training_age: row.training_age,
        goals: row.goals,
        sessions_per_week: row.sessions_per_week,
        obstacle: row.obstacle,
        sport: row.sport,
      }
    },

    async loadInsights(): Promise<InsightSnap[]> {
      const rows = await sql<InsightSnap[]>`
        SELECT claim, category, confidence, status, priority
        FROM insight
        WHERE athlete_id = ${athleteId}
        ORDER BY priority
      `
      return rows.map((r) => ({
        claim: r.claim,
        category: r.category,
        confidence: Number(r.confidence),
        status: r.status,
        priority: r.priority,
      }))
    },

    async hasLiveProgram(): Promise<boolean> {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM program
        WHERE athlete_id = ${athleteId} AND status = 'active'
        LIMIT 1
      `
      return Boolean(row?.id)
    },

    async saveAnswers(answers: OnboardingAnswers): Promise<void> {
      await sql`
        UPDATE athlete
        SET onboarding_answers = ${jsonParam(sql, wrapStoredAnswers(answers))}
        WHERE id = ${athleteId}
      `
    },

    async persistStart(input): Promise<{ programId: string }> {
      if (input.replace) {
        await sql`
          UPDATE program SET status = 'paused'
          WHERE athlete_id = ${athleteId} AND status = 'active'
        `
      }
      const plan: Session1Plan = input.plan
      const [prog] = await sql<{ id: string }[]>`
        INSERT INTO program (athlete_id, goal, start_date, retest_date, status)
        VALUES (
          ${athleteId}, ${plan.goal}, ${plan.weekStart}::date, ${plan.retestDate}::date, 'active'
        )
        RETURNING id
      `
      if (!prog?.id) throw new Error('Failed to insert program')
      const [phase] = await sql<{ id: string }[]>`
        INSERT INTO phase (
          program_id, name, week_start, week_end, non_negotiables, advancement_criteria, status
        ) VALUES (
          ${prog.id}, ${plan.phaseName}, ${plan.weekStart}::date, ${plan.weekEnd}::date,
          ${jsonParam(sql, plan.nonNegotiables)}, ${jsonParam(sql, plan.advancementCriteria)}, 'active'
        )
        RETURNING id
      `
      for (const session of plan.sessions) {
        await sql`
          INSERT INTO routine (program_id, phase_id, name, session_type, exercises, intent)
          VALUES (
            ${prog.id}, ${phase?.id ?? null}, ${session.name}, ${session.sessionType},
            ${jsonParam(sql, session.exercises)}, ${session.intent}
          )
        `
      }
      await sql`
        UPDATE athlete SET
          starter_pack = ${input.packId},
          starter_pack_settings = ${jsonParam(sql, input.settings)},
          onboarding_answers = ${jsonParam(sql, wrapStoredAnswers(input.answers))},
          onboarding_step = 'first_session_pending',
          name = ${input.athletePatch.name},
          training_age = ${input.athletePatch.training_age},
          goals = ${input.athletePatch.goals},
          sessions_per_week = ${input.athletePatch.sessions_per_week},
          obstacle = ${input.athletePatch.obstacle},
          sport = ${input.athletePatch.sport}
        WHERE id = ${athleteId}
      `
      await sql`
        INSERT INTO athlete_profile (athlete_id, current_phase, retest_date, last_updated)
        VALUES (${athleteId}, ${plan.phaseName}, ${plan.retestDate}::date, NOW())
        ON CONFLICT (athlete_id) DO UPDATE SET
          current_phase = EXCLUDED.current_phase,
          retest_date = EXCLUDED.retest_date,
          last_updated = EXCLUDED.last_updated
      `
      return { programId: prog.id }
    },
  }
}
