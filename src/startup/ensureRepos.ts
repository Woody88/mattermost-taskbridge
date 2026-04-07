import * as Effect from "effect/Effect"
import { AppConfig } from "../config/AppConfig.ts"
import { Git } from "../services/Git.ts"

/**
 * Boot-time task: ensure every configured project is cloned/pulled. Runs
 * once at startup before the HTTP server begins accepting requests. Errors
 * for individual projects are logged but don't take the boot down — the
 * service still serves the projects that came up cleanly.
 */
export const ensureRepos = Effect.gen(function*() {
  const config = yield* AppConfig
  const git = yield* Git
  yield* Effect.forEach(
    config.projects,
    (project) =>
      git.ensureRepo(project, config.reposDir).pipe(
        Effect.tap((path) => Effect.log(`ensured repo: ${project.key} -> ${path}`)),
        Effect.catchTag("GitError", (error) =>
          Effect.logWarning(`failed to ensure repo ${project.key}: ${error.message}`))
      ),
    { concurrency: 4, discard: true }
  )
})
