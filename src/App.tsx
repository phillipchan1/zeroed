import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'

export default function App() {
  const [connected, setConnected] = useState<boolean | null>(null)

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(() => setConnected(true))
      .catch(() => setConnected(false))
  }, [])

  const status =
    connected === null
      ? 'checking…'
      : connected
        ? '✓ connected'
        : '✗ not connected (add keys to .env.local)'

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1>Zeroed — skeleton running</h1>
      <p>Supabase: {status}</p>
    </div>
  )
}
