import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AppConfig } from "../../config/AppConfig.ts"
import { formatProjects } from "../../mattermost/format.ts"
import { SlashRequest } from "../../mattermost/SlashRequest.ts"
import { BeadsCli } from "../../services/BeadsCli.ts"
import { resolveRepoPath, verifyToken } from "./shared.ts"

/**
 * POST /slash/projects
 *
 * Returns one card per configured project with its open and ready task
 * counts. Mostly serves as the discovery surface — users type `/projects`
 * to see what they can `/board` against.
 */
export const projectsHandler = Effect.gen(function*() {
  const slash = yield* HttpServerRequest.schemaBodyUrlParams(SlashRequest)
  const config = yield* AppConfig
  yield* verifyToken(slash.token, config.slashCommandToken)
  const bd = yield* BeadsCli

  const entries = yield* Effect.forEach(
    config.projects,
    (project) =>
      Effect.gen(function*() {
        const path = resolveRepoPath(project, config.reposDir)
        // Swallow per-project errors so a single broken repo doesn't take
        // the whole projects listing down.
        const open = yield* bd.list(path, { status: "open" }).pipe(Effect.orElseSucceed(() => []))
        const ready = yield* bd.ready(path).pipe(Effect.orElseSucceed(() => []))
        return { project, openCount: open.length, readyCount: ready.length }
      }),
    { concurrency: 4 }
  )

  return yield* HttpServerResponse.json(formatProjects(entries))
})
