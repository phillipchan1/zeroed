import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadEnvFiles, readRemoteEnv } from './env.ts'
import { createRemoteBridge } from './remote.ts'
import { createZeroedServer } from './server.ts'

loadEnvFiles()

// ZEROED_MCP_URL set → forward to production (the Worker on Neon). Unset → the
// original Supabase server, which after the cutover reads the rollback copy.
const remote = readRemoteEnv()
const server = remote ? await createRemoteBridge(remote) : createZeroedServer()
const transport = new StdioServerTransport()
await server.connect(transport)
console.error(remote ? `zeroed MCP bridge running on stdio → ${new URL(remote.url).host}` : 'zeroed MCP server running on stdio (Supabase)')
