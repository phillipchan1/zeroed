// Service-role Supabase client for the edge MCP (token lookup + athlete-scoped tools).
import { createClient } from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

export const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})
