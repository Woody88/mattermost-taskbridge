import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { registerAll, type ToolDeps } from "./tools.ts"

/**
 * Build a fresh `McpServer` with all v1 read-only tools registered, then
 * connect it to a fresh `WebStandardStreamableHTTPServerTransport` and hand
 * the request off.
 *
 * Why fresh-per-request: the SDK's stateless mode forbids reusing a
 * `WebStandardStreamableHTTPServerTransport` across requests (it tracks
 * `_hasHandledRequest` and throws on the second call), and an `McpServer`
 * can only be `.connect()`-ed to one transport at a time. Since stateless
 * sessions are exactly the right model for our read-only tool surface, we
 * just rebuild both per request — tool registration is a handful of Map
 * inserts so the cost is negligible compared to the bd shellouts the
 * handlers themselves do.
 *
 * Verified end-to-end against the SDK in subtask `obsidian-mcp-server-ht7`.
 */
export const handleMcpRequest = async (req: Request, deps: ToolDeps): Promise<Response> => {
  const mcp = new McpServer({
    name: "taskbridge",
    version: "0.3.0-mcp"
  })

  registerAll(mcp, deps)

  // Stateless mode: omit `sessionIdGenerator` entirely (rather than passing
  // `undefined`, which trips `exactOptionalPropertyTypes`).
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true // single JSON response, no SSE stream
  })

  await mcp.connect(transport)

  return transport.handleRequest(req)
}
