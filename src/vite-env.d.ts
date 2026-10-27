/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_RPE_HALF_STEPS?: string
  readonly VITE_ONBOARDING_AGENT_V1?: string
  readonly VITE_ARC_LOAD_V1?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
