import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Path from "node:path"
import type { ProjectConfig } from "../config/ProjectConfig.ts"

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  message: Schema.String
}) {}

/**
 * Minimal git wrapper. The MVP only needs `ensureRepo` — clone the project
 * if it isn't on disk yet, otherwise pull. Write paths (commit/push) come
 * with the interactive-action phase.
 */
export class Git extends ServiceMap.Service<Git, {
  readonly ensureRepo: (project: ProjectConfig, reposDir: string) => Effect.Effect<string, GitError>
}>()("@taskbridge/Git") {
  static readonly layer: Layer.Layer<Git, never, ChildProcessSpawner> = Layer.effect(Git)(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner

      // Spawn `git <args>` and fail with a GitError carrying captured stderr if
      // the process exits non-zero. We use spawn() + handle.exitCode rather than
      // spawner.string() because string() reads stdout only and never consults
      // the exit code, so a failing git clone would silently resolve as success
      // (see obsidian-mcp-server-ktp). stderr and exitCode are awaited
      // concurrently to avoid pipe-buffer deadlocks on chatty git output.
      const run = (args: ReadonlyArray<string>, cwd?: string) => {
        const command = cwd === undefined
          ? ChildProcess.make`git ${args}`
          : ChildProcess.make({ cwd })`git ${args}`
        return Effect.scoped(
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(command)
            const [stderr, exit] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode
              ],
              { concurrency: 2 }
            )
            if ((exit as number) !== 0) {
              return yield* new GitError({
                message: `git ${args.join(" ")} exited with ${exit}: ${stderr.trim() || "<no stderr>"}`
              })
            }
          })
        ).pipe(
          Effect.mapError((cause) =>
            cause._tag === "GitError"
              ? cause
              : new GitError({ message: `git ${args.join(" ")} failed: ${String(cause)}` })
          )
        )
      }

      return Git.of({
        ensureRepo: (project, reposDir) =>
          Effect.gen(function*() {
            // The "." shortcut means use the local working tree directly.
            if (project.repo === ".") {
              return process.cwd()
            }
            const path = Path.join(reposDir, project.key)
            const gitDir = Path.join(path, ".git")
            const exists = yield* Effect.tryPromise({
              try: () => Bun.file(`${gitDir}/HEAD`).exists(),
              catch: (cause) => new GitError({ message: `Failed to stat ${gitDir}: ${String(cause)}` })
            })
            if (exists) {
              yield* run(["pull", "--rebase", "--ff-only", "origin", project.branch ?? "main"], path)
            } else {
              const branch = project.branch ?? "main"
              yield* run(["clone", "--branch", branch, "--single-branch", project.repo, path])
            }
            return path
          })
      })
    })
  )
}
