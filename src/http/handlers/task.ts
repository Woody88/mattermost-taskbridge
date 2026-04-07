import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AppConfig } from "../../config/AppConfig.ts"
import { parseFromBeadId, type ProjectKey } from "../../domain/ProjectKey.ts"
import { formatTaskDetail, notFound, unknownProject, usage } from "../../mattermost/format.ts"
import { SlashRequest } from "../../mattermost/SlashRequest.ts"
import { BeadNotFoundError, BeadsCli } from "../../services/BeadsCli.ts"
import { resolveRepoPath, verifyToken } from "./shared.ts"

/**
 * POST /slash/task
 *
 * Args (in `text` field): `show <bead-id>`
 *
 * Routes the lookup to the right project by parsing the bead ID's prefix
 * against the configured project keys (longest-prefix match). Other
 * subcommands (`create`, `assign`) are reserved for the write-path phase.
 */
export const taskHandler = Effect.gen(function*() {
  const slash = yield* HttpServerRequest.schemaBodyUrlParams(SlashRequest)
  const config = yield* AppConfig
  yield* verifyToken(slash.token, config.slashCommandToken)
  const bd = yield* BeadsCli

  const parts = slash.text.trim().split(/\s+/).filter((s) => s.length > 0)
  if (parts.length < 2 || parts[0] !== "show") {
    return yield* HttpServerResponse.json(
      usage("Usage: `/task show <bead-id>`. Other subcommands are not yet implemented.")
    )
  }

  const beadId = parts[1]!
  const projectKeys: ReadonlyArray<ProjectKey> = config.projects.map((p) => p.key)
  const parsed = parseFromBeadId(beadId, projectKeys)
  if (parsed === null) {
    return yield* HttpServerResponse.json(unknownProject(beadId))
  }

  const project = config.projects.find((p) => p.key === parsed.projectKey)!
  const repoPath = resolveRepoPath(project, config.reposDir)

  const result = yield* bd.show(repoPath, beadId).pipe(
    Effect.map((task) => formatTaskDetail(project, task)),
    Effect.catchTag("BeadNotFoundError", (_: BeadNotFoundError) => Effect.succeed(notFound(beadId)))
  )

  return yield* HttpServerResponse.json(result)
})
