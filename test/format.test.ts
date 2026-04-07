import { expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { ProjectConfig } from "../src/config/ProjectConfig.ts"
import { BeadTask } from "../src/domain/BeadTask.ts"
import { formatBoard, formatProjects, formatTaskDetail } from "../src/mattermost/format.ts"

const project = Schema.decodeUnknownSync(ProjectConfig)({
  key: "obsidian-mcp-server",
  repo: ".",
  display_name: "TaskBridge (self)",
  color: "#1D9E75"
})

const task = Schema.decodeUnknownSync(BeadTask)({
  id: "obsidian-mcp-server-oyd",
  title: "Phase 1 thin-slice MVP",
  description: "Read-only slash commands.",
  status: "open",
  priority: 1,
  issue_type: "feature",
  owner: "woodsondelhia@gmail.com",
  created_at: "2026-04-07T04:15:41Z",
  created_by: "Woodson Delhia",
  updated_at: "2026-04-07T04:26:21Z",
  dependency_count: 0,
  dependent_count: 1,
  comment_count: 0
})

test("formatProjects renders one card per project with counts", () => {
  const out = formatProjects([{ project, openCount: 2, readyCount: 1 }])
  expect(out.response_type).toBe("in_channel")
  expect(out.text).toContain("Configured projects")
  expect(out.props?.attachments?.[0]?.title).toContain("TaskBridge (self)")
  expect(out.props?.attachments?.[0]?.fields).toEqual([
    { short: true, title: "Open", value: "2" },
    { short: true, title: "Ready", value: "1" }
  ])
})

test("formatProjects shows ephemeral message when no projects configured", () => {
  const out = formatProjects([])
  expect(out.response_type).toBe("ephemeral")
  expect(out.text).toContain("No projects configured")
})

test("formatBoard renders one attachment per task", () => {
  const out = formatBoard(project, [task])
  expect(out.response_type).toBe("in_channel")
  expect(out.text).toContain("1 open task")
  expect(out.props?.attachments).toHaveLength(1)
  const attachment = out.props!.attachments![0]!
  expect(attachment.title).toBe("obsidian-mcp-server-oyd: Phase 1 thin-slice MVP")
  expect(attachment.fields).toContainEqual({ short: true, title: "Status", value: "open" })
  expect(attachment.fields).toContainEqual({ short: true, title: "Priority", value: "P1 (high)" })
  expect(attachment.fields).toContainEqual({ short: true, title: "Type", value: "feature" })
  // status=open should map to the open color, not the project color
  expect(attachment.color).toBe("#888780")
})

test("formatBoard shows ephemeral message when no tasks", () => {
  const out = formatBoard(project, [])
  expect(out.response_type).toBe("ephemeral")
  expect(out.text).toContain("no open tasks")
})

test("formatTaskDetail renders rich attachment with description and counts", () => {
  const out = formatTaskDetail(project, task)
  const attachment = out.props!.attachments![0]!
  expect(attachment.text).toBe("Read-only slash commands.")
  expect(attachment.fields).toContainEqual({ short: true, title: "Comments", value: "0" })
  expect(attachment.fields).toContainEqual({
    short: true,
    title: "Deps",
    value: "0 blockers, 1 dependents"
  })
})

test("formatTaskDetail handles bd show output without count fields", () => {
  // `bd show --json` omits dependency_count/dependent_count/comment_count
  // (it returns rich `dependents` arrays instead). Verify the formatter
  // falls back to 0 instead of crashing.
  const showShape = Schema.decodeUnknownSync(BeadTask)({
    id: "obsidian-mcp-server-xyz",
    title: "Bare task",
    description: "From bd show",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "test@example.com",
    created_at: "2026-04-07T00:00:00Z",
    created_by: "tester",
    updated_at: "2026-04-07T00:00:00Z"
  })
  const out = formatTaskDetail(project, showShape)
  expect(out.props?.attachments?.[0]?.fields).toContainEqual({
    short: true,
    title: "Deps",
    value: "0 blockers, 0 dependents"
  })
})
