import { createClient } from '@supabase/supabase-js'

// NOTE: VITE_* values are inlined at BUILD time (not runtime). Whatever these
// were when Vercel last built is what ships in the bundle — so a change to the
// env vars requires a REDEPLOY to take effect.
//
// Be forgiving about the common paste mistakes that otherwise hard-crash the app
// at startup ("Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL"):
// surrounding quotes, stray whitespace/newlines, or a missing https:// scheme.
function clean(v: string | undefined): string {
  return (v ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim()
}

function normalizeUrl(v: string | undefined): string {
  const url = clean(v)
  if (!url) return ''
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`
  return withScheme.replace(/\/+$/, '') // drop trailing slash(es)
}

// Exported so the connectivity probe (useOnline.ts) can ask the API we actually
// depend on whether it's reachable, rather than trusting `navigator.onLine`.
export const supabaseUrl = normalizeUrl(import.meta.env.VITE_SUPABASE_URL) || 'https://placeholder.supabase.co'
export const supabaseAnonKey = clean(import.meta.env.VITE_SUPABASE_ANON_KEY) || 'placeholder'

if (supabaseUrl.includes('placeholder') || supabaseAnonKey === 'placeholder') {
  // Visible, non-fatal: the app still mounts, but Supabase calls will fail until
  // the env vars are set in Vercel AND the project is redeployed.
  console.error(
    '[zeroed] Supabase env missing/empty at build time. Set VITE_SUPABASE_URL and ' +
    'VITE_SUPABASE_ANON_KEY in Vercel (Production), then redeploy.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
