import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AppConfig } from "../../config/AppConfig.ts"
import { handleMcpRequest } from "../../mcp/server.ts"
import { BeadsCli } from "../../services/BeadsCli.ts"

/**
 * Tagged error wrapping any failure inside the MCP SDK. Tagged so it can
 * surface cleanly in the Effect failure channel without merging into the
 * untyped global `Error` bucket (effect-solutions error-handling guide).
 * Mirrors the `BeadsCliError` shape from `services/BeadsCli.ts`.
 */
export class McpHandlerError extends Schema.TaggedErrorClass<McpHandlerError>()(
  "McpHandlerError",
  { message: Schema.String }
) {}

/**
 * POST /mcp — MCP Streamable HTTP endpoint for the Mattermost Agents plugin
 * (Clank). Spec: https://modelcontextprotocol.io/specification
 *
 * The Effect handler grabs the existing `BeadsCli` and `AppConfig` services
 * (the same ones the slash-command handlers use), converts the Effect HTTP
 * request to a web-standard `Request` via `HttpServerRequest.toWeb`, then
 * hands it off to a fresh `McpServer` + transport (per the SDK's stateless
 * pattern) and wraps the resulting web `Response` back into Effect's HTTP
 * response type via `HttpServerResponse.fromWeb`.
 *
 * Auth: NONE in v1. The cluster network is the trust boundary — only the
 * Mattermost pod (which is on the AllowedUntrustedInternalConnections list
 * for taskbridge already) and other in-cluster pods can reach this endpoint.
 * If/when the surface area grows or we want defense-in-depth, add a bearer
 * token check here mirroring `verifyToken` from `shared.ts`.
 *
 * Note: GET /mcp (long-poll for unsolicited server messages) is not
 * registered because we run in stateless mode — the spec allows that and
 * the SDK handles a 405 cleanly. We register POST only and let bad methods
 * fall through to the router's default 404.
 */
export const mcpHandler = Effect.gen(function*() {
  const bd = yield* BeadsCli
  const config = yield* AppConfig
  const httpReq = yield* HttpServerRequest.HttpServerRequest
  const webReq = yield* HttpServerRequest.toWeb(httpReq).pipe(
    Effect.mapError((cause) => new McpHandlerError({ message: `Failed to read request: ${String(cause)}` }))
  )

  const webRes = yield* Effect.tryPromise({
    try: () => handleMcpRequest(webReq, { bd, config }),
    catch: (cause) => new McpHandlerError({ message: `MCP handler failed: ${String(cause)}` })
  })

  return HttpServerResponse.fromWeb(webRes)
})
