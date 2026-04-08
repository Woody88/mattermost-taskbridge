import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { boardHandler } from "./handlers/board.ts"
import { mcpHandler } from "./handlers/mcp.ts"
import { projectsHandler } from "./handlers/projects.ts"
import { taskHandler } from "./handlers/task.ts"

/**
 * The complete route table for the MVP. Each `HttpRouter.add` returns a
 * Layer that requires `HttpRouter`; `Layer.mergeAll` composes them.
 *
 * Two endpoint families:
 * - `/slash/*` — Mattermost slash commands (read-only board / task / projects)
 * - `/mcp`     — MCP Streamable HTTP endpoint for the Mattermost Agents
 *                plugin (Clank). Read-only tools backed by the same BeadsCli
 *                service the slash commands use.
 *
 * Adding write-path routes later just means appending more `HttpRouter.add`
 * calls here.
 */
export const RoutesLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/slash/projects", projectsHandler),
  HttpRouter.add("POST", "/slash/board", boardHandler),
  HttpRouter.add("POST", "/slash/task", taskHandler),
  HttpRouter.add("POST", "/mcp", mcpHandler)
)
