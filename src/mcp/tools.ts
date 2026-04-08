import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as Effect from "effect/Effect"
import { z } from "zod"
import type { AppConfig } from "../config/AppConfig.ts"
import type { ProjectConfig } from "../config/ProjectConfig.ts"
import { parseFromBeadId, type ProjectKey } from "../domain/ProjectKey.ts"
import { resolveRepoPath } from "../http/handlers/shared.ts"
import { BeadNotFoundError, type BeadsCli, BeadsCliError } from "../services/BeadsCli.ts"

/**
 * Tool surface for the Mattermost agent ("Clank") — read-only, multi-project,
 * pluggable into the MCP SDK's Streamable HTTP transport via `registerAll`.
 *
 * Design notes:
 * - Each handler runs an Effect program against the same `BeadsCli`/`AppConfig`
 *   layer the slash-command handlers use, so there's a single source of truth
 *   for project routing and bd CLI shelling.
 * - Tools that take an optional `project` arg fan out across all configured
 *   projects when omitted, in parallel via `Effect.forEach`. Failures on one
 *   project don't poison the response for the others — the tool returns a
 *   per-project breakdown including any per-project error strings.
 * - Tool output is a single text content block containing pretty-printed JSON.
 *   The LLM consumes the JSON; the SDK auto-converts the Zod input schemas to
 *   JSON Schema for the wire format.
 * - This module DOES NOT depend on the MCP SDK at the type level for tool
 *   definitions (only the handler shape) so it stays unit-testable in
 *   isolation. The actual SDK registration happens in `server.ts`.
 *
 * Verified in subtask `obsidian-mcp-server-1mq` that `bd search --json` works
 * cleanly. `bd blocked` was deliberately dropped because it hits the bd
 * v1.0.0 `wisp_dependencies` bug from issue `obsidian-mcp-server-0hz`.
 */

export type ToolDeps = {
  readonly bd: BeadsCli["Service"]
  readonly config: AppConfig["Service"]
}

type Json = unknown

/**
 * Result of fanning out a single-project read across every configured project.
 * Per-project failures are recorded as `error` strings rather than thrown so
 * Clank gets a partial answer instead of nothing.
 */
type FanOutEntry =
  | { readonly project: string; readonly beads: ReadonlyArray<unknown> }
  | { readonly project: string; readonly error: string }

const errorToString = (e: BeadsCliError | BeadNotFoundError): string => {
  if (e instanceof BeadsCliError) return e.message
  return `bead not found: ${e.beadId}`
}

/**
 * Run `op` against either a single configured project (if `key` is provided)
 * or every configured project in parallel (otherwise). Returns a JSON-friendly
 * per-project breakdown.
 */
const fanOut = (
  deps: ToolDeps,
  key: string | undefined,
  op: (project: ProjectConfig, repoPath: string) => Effect.Effect<ReadonlyArray<unknown>, BeadsCliError>
): Effect.Effect<ReadonlyArray<FanOutEntry>, never> => {
  const projects = key === undefined
    ? deps.config.projects
    : deps.config.projects.filter((p) => p.key === key)

  if (projects.length === 0) {
    return Effect.succeed([
      {
        project: key ?? "(none)",
        error: `unknown project key '${key}' — call list_projects to see configured projects`
      }
    ])
  }

  return Effect.forEach(
    projects,
    (project) => {
      const repoPath = resolveRepoPath(project, deps.config.reposDir)
      return op(project, repoPath).pipe(
        Effect.map((beads): FanOutEntry => ({ project: project.key, beads })),
        Effect.catch((e) => Effect.succeed<FanOutEntry>({ project: project.key, error: errorToString(e) }))
      )
    },
    { concurrency: "unbounded" }
  )
}

const textContent = (payload: Json) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(payload, null, 2) }
  ]
})

/**
 * Build a runner that takes an Effect program, executes it via the calling
 * fiber's runtime, and converts the result into an MCP tool response. Tool
 * handlers in the SDK are async functions, not Effects, so we have to bridge.
 *
 * The handlers below already swallow per-project errors via `fanOut`, so the
 * top-level Effect.runPromise here will only reject for genuine programming
 * bugs in the tool definitions — those propagate as MCP tool errors.
 */
const runTool = <A>(eff: Effect.Effect<A, never>) => Effect.runPromise(eff)

/**
 * Register all v1 read-only tools on the supplied McpServer instance.
 *
 * The McpServer is constructed fresh per request (per the SDK's stateless
 * pattern — see `server.ts` for the rationale), so this function is called
 * once per HTTP request. Tool registration is cheap (one Map insert per tool).
 */
export function registerAll(mcp: McpServer, deps: ToolDeps): void {
  // 1. list_projects — no-arg discovery tool. Always cheap, no bd shellout.
  mcp.registerTool(
    "list_projects",
    {
      description:
        "Return the configured project keys and display names for the bd (beads) instance Clank can query. Call this first when the user asks 'what projects do I have' or before any other tool if you're unsure which project key to use.",
      inputSchema: {}
    },
    async () =>
      runTool(
        Effect.succeed(
          textContent({
            projects: deps.config.projects.map((p) => ({
              key: p.key,
              display_name: p.display_name,
              repo: p.repo
            }))
          })
        )
      )
  )

  // 2. bd_ready — what's unblocked and ready to work on.
  mcp.registerTool(
    "bd_ready",
    {
      description:
        "Return all bd issues that are open and have no unresolved blockers, optionally filtered to one project. Use this to answer 'what should I work on next' or 'what's ready'. If `project` is omitted, fans out across every configured project.",
      inputSchema: {
        project: z.string().optional()
          .describe("Optional project key (e.g. 'obsidian-mcp-server'). Omit to query all projects.")
      }
    },
    async ({ project }) =>
      runTool(
        Effect.map(
          fanOut(deps, project, (_project, repoPath) => deps.bd.ready(repoPath)),
          textContent
        )
      )
  )

  // 3. bd_list — broad listing with optional status filter.
  mcp.registerTool(
    "bd_list",
    {
      description:
        "List bd issues, optionally filtered by status and/or project. Use for breadth queries like 'what's in flight' (status=in_progress), 'what's left to do' (status=open), or 'what shipped recently' (status=closed). Fans out across all projects if `project` is omitted.",
      inputSchema: {
        project: z.string().optional()
          .describe("Optional project key. Omit to query all projects."),
        status: z.enum(["open", "closed", "in_progress"]).optional()
          .describe("Optional status filter. Defaults to 'open' if omitted.")
      }
    },
    async ({ project, status }) =>
      runTool(
        Effect.map(
          fanOut(deps, project, (_project, repoPath) => deps.bd.list(repoPath, { status })),
          textContent
        )
      )
  )

  // 4. bd_show — drill down to one issue.
  mcp.registerTool(
    "bd_show",
    {
      description:
        "Return the full details of a single bd issue (description, design field, notes, dependencies, etc.) given its bead ID. Use this when the user asks about a specific issue ID, or after `bd_ready`/`bd_list` returned a candidate that needs more context. The project is auto-resolved from the issue ID's prefix.",
      inputSchema: {
        id: z.string().describe("The full bead ID, e.g. 'obsidian-mcp-server-58x'.")
      }
    },
    async ({ id }) =>
      runTool(
        Effect.gen(function*() {
          const projectKeys: ReadonlyArray<ProjectKey> = deps.config.projects.map((p) => p.key)
          const parsed = parseFromBeadId(id, projectKeys)
          if (parsed === null) {
            return textContent({
              error: `Could not resolve a project from id '${id}'. Configured project keys: ${projectKeys.join(", ")}`
            })
          }
          const project = deps.config.projects.find((p) => p.key === parsed.projectKey)!
          const repoPath = resolveRepoPath(project, deps.config.reposDir)
          return yield* deps.bd.show(repoPath, id).pipe(
            Effect.map((bead) => textContent({ project: project.key, bead })),
            Effect.catch((e) => Effect.succeed(textContent({ error: errorToString(e) })))
          )
        })
      )
  )

  // 5. bd_search — title + ID prefix search.
  mcp.registerTool(
    "bd_search",
    {
      description:
        "Free-text search across bd issue titles and IDs. Use when the user describes an issue by topic ('the migration epic', 'auth bug') instead of by ID. Fans out across all projects if `project` is omitted.",
      inputSchema: {
        query: z.string().min(1).describe("The search query string."),
        project: z.string().optional().describe("Optional project key. Omit to search all projects.")
      }
    },
    async ({ query, project }) =>
      runTool(
        Effect.map(
          fanOut(deps, project, (_project, repoPath) => deps.bd.search(repoPath, query)),
          textContent
        )
      )
  )
}
