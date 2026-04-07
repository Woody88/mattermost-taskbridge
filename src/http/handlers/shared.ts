import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Path from "node:path"
import type { ProjectConfig } from "../../config/ProjectConfig.ts"
import { ephemeral } from "../../mattermost/Response.ts"

/**
 * Resolve a project's on-disk path. `repo = "."` means the local working
 * tree (handy for bootstrapping); anything else is treated as a clone target
 * under `reposDir/<key>`.
 */
export const resolveRepoPath = (project: ProjectConfig, reposDir: string): string => {
  if (project.repo === ".") {
    return process.cwd()
  }
  return Path.join(reposDir, project.key)
}

/**
 * Verify the per-command token Mattermost includes in the request body.
 *
 * Empty `expected` (the default in dev) skips verification so the local
 * smoke test loop works without the token round-trip. Production must set
 * SLASH_COMMAND_TOKEN to the value Mattermost generated.
 */
export const verifyToken = (provided: string, expected: string) => {
  if (expected === "") return Effect.void
  if (provided === expected) return Effect.void
  return HttpServerResponse.json(ephemeral("Invalid token."), { status: 401 }).pipe(
    Effect.flatMap((response) => Effect.fail(response))
  )
}
