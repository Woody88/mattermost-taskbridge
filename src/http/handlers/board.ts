import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AppConfig } from "../../config/AppConfig.ts"
import { formatBoard, unknownProject, usage } from "../../mattermost/format.ts"
import { SlashRequest } from "../../mattermost/SlashRequest.ts"
import { BeadsCli } from "../../services/BeadsCli.ts"
import { resolveRepoPath, verifyToken } from "./shared.ts"

/**
 * POST /slash/board
 *
 * Args (in `text` field): `<project> [ready|blocked]`
 * - `/board sitelink`         — all open tasks for sitelink
 * - `/board sitelink ready`   — only unblocked (ready) tasks
 *
 * No-arg form (`/board`) is reserved for a multi-project summary; for the
 * MVP we treat it as usage help.
 */
export const boardHandler = Effect.gen(function*() {
  const slash = yield* HttpServerRequest.schemaBodyUrlParams(SlashRequest)
  const config = yield* AppConfig
  yield* verifyToken(slash.token, config.slashCommandToken)
  const bd = yield* BeadsCli

  const parts = slash.text.trim().split(/\s+/).filter((s) => s.length > 0)
  if (parts.length === 0) {
    return yield* HttpServerResponse.json(
      usage("Usage: `/board <project> [ready]`. Try `/projects` to see configured projects.")
    )
  }

  const projectKey = parts[0]!
  const filter = parts[1]
  const project = config.projects.find((p) => p.key === projectKey)
  if (project === undefined) {
    return yield* HttpServerResponse.json(unknownProject(projectKey))
  }

  const repoPath = resolveRepoPath(project, config.reposDir)
  const tasks = filter === "ready"
    ? yield* bd.ready(repoPath)
    : yield* bd.list(repoPath, { status: "open" })

  return yield* HttpServerResponse.json(formatBoard(project, tasks))
})
