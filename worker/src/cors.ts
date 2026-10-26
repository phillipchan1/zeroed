export const AGENT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-zeroed-token, mcp-session-id, last-event-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
}

export const AUTH_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, cookie, x-zeroed-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
}

export function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  })
}
