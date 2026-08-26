import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadEnvFiles } from './env.ts'
import { createZeroedServer } from './server.ts'

loadEnvFiles()

const server = createZeroedServer()
const transport = new StdioServerTransport()
await server.connect(transport)
console.error('zeroed MCP server running on stdio')
