// Bridge mode: a stdio MCP server that forwards to the production Worker.
//
// Claude Desktop, Cursor and Claude Code keep launching `mcp/src/index.ts` over
// stdio as before; the tools, their schemas and their answers come from the
// same /functions/v1/mcp endpoint the hosted Claude connector uses, so local
// and remote can't drift. No database credentials on this machine, only the
// athlete's own revocable connector token.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export async function createRemoteBridge(remote: { url: string; token: string }): Promise<Server> {
  const client = new Client({ name: 'zeroed-local-bridge', version: '0.1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(remote.url), {
      requestInit: { headers: { Authorization: `Bearer ${remote.token}` } },
    }),
  )

  const server = new Server(
    { name: 'zeroed', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  )
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params))
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params))
  return server
}
