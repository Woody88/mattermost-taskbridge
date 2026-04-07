import type { ProjectConfig } from "../config/ProjectConfig.ts"
import type { BeadStatus, BeadTask } from "../domain/BeadTask.ts"
import type { Attachment, SlashResponse } from "./Response.ts"
import { ephemeral, inChannel } from "./Response.ts"

const PRIORITY_LABELS = ["P0 (critical)", "P1 (high)", "P2 (medium)", "P3 (low)", "P4 (backlog)"] as const

const STATUS_COLORS: Record<BeadStatus, string> = {
  open: "#888780",
  in_progress: "#1D9E75",
  closed: "#639922"
}

const priorityLabel = (priority: number): string => PRIORITY_LABELS[priority] ?? `P${priority}`

const taskAttachment = (project: ProjectConfig, task: BeadTask): Attachment => ({
  color: STATUS_COLORS[task.status] ?? project.color,
  title: `${task.id}: ${task.title}`,
  fields: [
    { short: true, title: "Status", value: task.status },
    { short: true, title: "Priority", value: priorityLabel(task.priority) },
    { short: true, title: "Type", value: task.issue_type },
    { short: true, title: "Assignee", value: task.assignee ?? "—" }
  ]
})

/**
 * Format the response for `/board <project>`. Lists each task as a separate
 * attachment so Mattermost renders them as a stacked card view.
 */
export const formatBoard = (
  project: ProjectConfig,
  tasks: ReadonlyArray<BeadTask>
): SlashResponse => {
  if (tasks.length === 0) {
    return ephemeral(`**${project.display_name}** — no open tasks.`)
  }
  const summary = `**${project.display_name}** — ${tasks.length} open task${tasks.length === 1 ? "" : "s"}`
  return inChannel(summary, tasks.map((task) => taskAttachment(project, task)))
}

/**
 * Format `/projects` — one attachment per configured project with its
 * task counts.
 */
export const formatProjects = (
  entries: ReadonlyArray<{
    readonly project: ProjectConfig
    readonly openCount: number
    readonly readyCount: number
  }>
): SlashResponse => {
  if (entries.length === 0) {
    return ephemeral("No projects configured. Edit `config/projects.toml` and restart the service.")
  }
  const attachments: ReadonlyArray<Attachment> = entries.map(({ project, openCount, readyCount }) => ({
    color: project.color,
    title: `${project.display_name} (${project.key})`,
    fields: [
      { short: true, title: "Open", value: String(openCount) },
      { short: true, title: "Ready", value: String(readyCount) }
    ]
  }))
  return inChannel("**Configured projects**", attachments)
}

/**
 * Format `/task show <bead-id>`. Single rich attachment with the full
 * description and metadata.
 */
export const formatTaskDetail = (project: ProjectConfig, task: BeadTask): SlashResponse => {
  const attachment: Attachment = {
    color: STATUS_COLORS[task.status] ?? project.color,
    title: `${task.id}: ${task.title}`,
    text: task.description,
    fields: [
      { short: true, title: "Status", value: task.status },
      { short: true, title: "Priority", value: priorityLabel(task.priority) },
      { short: true, title: "Type", value: task.issue_type },
      { short: true, title: "Assignee", value: task.assignee ?? "—" },
      { short: true, title: "Created", value: task.created_at },
      { short: true, title: "Updated", value: task.updated_at },
      { short: true, title: "Comments", value: String(task.comment_count ?? 0) },
      {
        short: true,
        title: "Deps",
        value: `${task.dependency_count ?? 0} blockers, ${task.dependent_count ?? 0} dependents`
      }
    ]
  }
  return inChannel(`**${project.display_name}**`, [attachment])
}

export const notFound = (beadId: string): SlashResponse => ephemeral(`Bead \`${beadId}\` not found.`)

export const unknownProject = (key: string): SlashResponse =>
  ephemeral(`Unknown project \`${key}\`. Try \`/projects\` to see configured projects.`)

export const usage = (text: string): SlashResponse => ephemeral(text)
