export interface HyperdriveBinding {
  connectionString: string
}

export interface Env {
  ASSETS?: Fetcher
  HYPERDRIVE?: HyperdriveBinding
  DATABASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_MODEL_HEAVY?: string
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  /** wrangler / tests: `development` | `dev` | `local` allow a localhost auth fallback. */
  ENVIRONMENT?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
}

export function databaseUrl(env: Env): string | null {
  const fromHyperdrive = env.HYPERDRIVE?.connectionString?.trim() ?? ''
  if (fromHyperdrive && !fromHyperdrive.includes('00000000000000000000000000000000')) {
    return fromHyperdrive
  }
  const fallback = env.DATABASE_URL?.trim() ?? ''
  return fallback || fromHyperdrive || null
}
