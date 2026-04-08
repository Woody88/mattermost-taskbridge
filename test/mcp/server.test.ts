import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AppConfig } from "../../src/config/AppConfig.ts"
import { ProjectConfig } from "../../src/config/ProjectConfig.ts"
import { BeadTask } from "../../src/domain/BeadTask.ts"
import { handleMcpRequest } from "../../src/mcp/server.ts"
import type { ToolDeps } from "../../src/mcp/tools.ts"
import { type BeadsCli, BeadsCliError } from "../../src/services/BeadsCli.ts"

/**
 * End-to-end tests for the MCP server. We exercise `handleMcpRequest`
 * directly with a fake `BeadsCli` and a fake `AppConfig` so the HTTP layer,
 * MCP protocol layer, tool registration, and project fan-out are all
 * covered without needing to provide Effect layers — much simpler than
 * trying to plumb a test runtime through the Effect HTTP handler.
 *
 * The Effect HTTP handler in `src/http/handlers/mcp.ts` is a thin wrapper
 * around `handleMcpRequest` that just lifts the web Request/Response shape
 * in/out of Effect's HTTP types — no logic of its own.
 */

const projectA = Schema.decodeUnknownSync(ProjectConfig)({
  key: "obsidian-mcp-server",
  repo: ".",
  display_name: "TaskBridge",
  color: "#1D9E75"
})

const projectB = Schema.decodeUnknownSync(ProjectConfig)({
  key: "bd-a3-test",
  repo: "https://github.com/Woody88/bd-a3-test.git",
  display_name: "bd-a3-test (fixture)",
  color: "#888888"
})

const taskA = Schema.decodeUnknownSync(BeadTask)({
  id: "obsidian-mcp-server-aaa",
  title: "Task A",
  description: "From project A",
  status: "open",
  priority: 1,
  issue_type: "task",
  owner: "test@example.com",
  created_at: "2026-04-08T00:00:00Z",
  created_by: "tester",
  updated_at: "2026-04-08T00:00:00Z",
  dependency_count: 0,
  dependent_count: 0,
  comment_count: 0
})

const taskB = Schema.decodeUnknownSync(BeadTask)({
  id: "bd-a3-test-bbb",
  title: "Task B",
  description: "From project B",
  status: "open",
  priority: 2,
  issue_type: "feature",
  owner: "test@example.com",
  created_at: "2026-04-08T00:00:00Z",
  created_by: "tester",
  updated_at: "2026-04-08T00:00:00Z",
  dependency_count: 0,
  dependent_count: 0,
  comment_count: 0
})

const fakeBd: BeadsCli["Service"] = {
  ready: (repoPath) => Effect.succeed(repoPath.endsWith("bd-a3-test") ? [taskB] : [taskA]),
  list: (repoPath, _opts) => Effect.succeed(repoPath.endsWith("bd-a3-test") ? [taskB] : [taskA]),
  show: (_repoPath, beadId) => {
    if (beadId === taskA.id) return Effect.succeed(taskA)
    if (beadId === taskB.id) return Effect.succeed(taskB)
    return Effect.fail(new BeadsCliError({ message: `not found: ${beadId}` }))
  },
  search: (repoPath, query) => {
    const pool = repoPath.endsWith("bd-a3-test") ? [taskB] : [taskA]
    return Effect.succeed(pool.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())))
  }
}

const fakeConfig: AppConfig["Service"] = {
  mattermostUrl: "http://localhost",
  mattermostBotToken: "",
  slashCommandToken: "",
  githubToken: "",
  reposDir: "/tmp/repos",
  port: 3100,
  projects: [projectA, projectB]
}

const deps: ToolDeps = { bd: fakeBd, config: fakeConfig }

async function rpc(
  method: string,
  params: unknown = {},
  id: number = 1
): Promise<{ status: number; body: any }> {
  const req = new Request("http://test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  })
  const res = await handleMcpRequest(req, deps)
  const body = await res.json()
  return { status: res.status, body }
}

/**
 * Every MCP request must be preceded by an `initialize` call (the SDK
 * enforces this at the transport level). Helper that does both.
 */
async function callTool(name: string, args: unknown = {}): Promise<unknown> {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" }
  })
  const res = await rpc("tools/call", { name, arguments: args })
  expect(res.status).toBe(200)
  expect(res.body.error).toBeUndefined()
  // The SDK wraps tool output in result.content[0].text as a JSON string.
  const text = res.body.result.content[0].text
  return JSON.parse(text)
}

describe("mcp server", () => {
  test("initialize returns server info and tools capability", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    })
    expect(res.status).toBe(200)
    expect(res.body.result.serverInfo.name).toBe("taskbridge")
    expect(res.body.result.capabilities.tools).toBeDefined()
  })

  test("tools/list returns all 5 read-only tools with schemas", async () => {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    })
    const res = await rpc("tools/list")
    expect(res.status).toBe(200)
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(["bd_list", "bd_ready", "bd_search", "bd_show", "list_projects"])

    const bdShow = res.body.result.tools.find((t: { name: string }) => t.name === "bd_show")
    expect(bdShow.description).toContain("single bd issue")
    expect(bdShow.inputSchema.properties.id).toBeDefined()
    expect(bdShow.inputSchema.required).toContain("id")
  })

  describe("list_projects", () => {
    test("returns the configured projects", async () => {
      const out = await callTool("list_projects") as { projects: Array<{ key: string }> }
      expect(out.projects).toHaveLength(2)
      expect(out.projects.map((p) => p.key).sort()).toEqual(["bd-a3-test", "obsidian-mcp-server"])
    })
  })

  describe("bd_ready", () => {
    test("fans out across all projects when no project arg is given", async () => {
      const out = await callTool("bd_ready") as Array<{ project: string; beads?: any[]; error?: string }>
      expect(out).toHaveLength(2)
      const byProject = Object.fromEntries(out.map((e) => [e.project, e]))
      expect(byProject["obsidian-mcp-server"]?.beads?.[0]?.id).toBe("obsidian-mcp-server-aaa")
      expect(byProject["bd-a3-test"]?.beads?.[0]?.id).toBe("bd-a3-test-bbb")
    })

    test("filters to a single project when project arg is given", async () => {
      const out = await callTool("bd_ready", { project: "bd-a3-test" }) as Array<{ project: string }>
      expect(out).toHaveLength(1)
      expect(out[0]!.project).toBe("bd-a3-test")
    })

    test("returns a clear error entry for an unknown project key", async () => {
      const out = await callTool("bd_ready", { project: "no-such-project" }) as Array<
        { project: string; error?: string }
      >
      expect(out).toHaveLength(1)
      expect(out[0]!.error).toContain("unknown project key")
    })
  })

  describe("bd_list", () => {
    test("accepts a status filter and passes it through to BeadsCli", async () => {
      const out = await callTool("bd_list", { project: "obsidian-mcp-server", status: "open" }) as Array<
        { beads?: any[] }
      >
      expect(out).toHaveLength(1)
      expect(out[0]!.beads).toHaveLength(1)
    })
  })

  describe("bd_show", () => {
    test("resolves the project from the bead ID prefix and returns the bead", async () => {
      const out = await callTool("bd_show", { id: "obsidian-mcp-server-aaa" }) as {
        project: string
        bead: { id: string }
      }
      expect(out.project).toBe("obsidian-mcp-server")
      expect(out.bead.id).toBe("obsidian-mcp-server-aaa")
    })

    test("returns an error in the content for an unknown ID prefix", async () => {
      const out = await callTool("bd_show", { id: "garbage-prefix-xyz" }) as { error: string }
      expect(out.error).toContain("Could not resolve a project")
    })

    test("returns an error in the content when BeadsCli reports not found", async () => {
      const out = await callTool("bd_show", { id: "obsidian-mcp-server-zzz" }) as { error: string }
      expect(out.error).toContain("not found")
    })
  })

  describe("bd_search", () => {
    test("fans out across all projects when no project arg is given", async () => {
      const out = await callTool("bd_search", { query: "Task" }) as Array<{ project: string; beads?: any[] }>
      expect(out).toHaveLength(2)
      // Both fakes match "Task" in their title.
      expect(out.flatMap((e) => e.beads ?? [])).toHaveLength(2)
    })

    test("returns empty bead arrays for a query with no matches", async () => {
      const out = await callTool("bd_search", { query: "nothing-matches-this" }) as Array<
        { project: string; beads?: any[] }
      >
      expect(out.flatMap((e) => e.beads ?? [])).toHaveLength(0)
    })
  })
})
