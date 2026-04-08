import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BeadTask, BeadTaskArray } from "../domain/BeadTask.ts"

/**
 * Errors raised by the BeadsCli wrapper.
 *
 * `BeadsCliError` covers spawn / exit-code / JSON-parse / schema-decode
 * failures. `BeadNotFoundError` is the specific case where `bd show <id>`
 * returned an empty result so handlers can map it to a 404-style response.
 */
export class BeadsCliError extends Schema.TaggedErrorClass<BeadsCliError>()("BeadsCliError", {
  message: Schema.String
}) {}

export class BeadNotFoundError extends Schema.TaggedErrorClass<BeadNotFoundError>()("BeadNotFoundError", {
  beadId: Schema.String
}) {}

const decodeArray = Schema.decodeUnknownEffect(BeadTaskArray)
const decodeOne = Schema.decodeUnknownEffect(BeadTask)

/**
 * Thin wrapper around the `bd` CLI. Each method shells out via the
 * platform `ChildProcessSpawner`, parses stdout as JSON, and decodes
 * through the BeadTask Schema.
 *
 * The MVP only needs read paths (ready/list/show); write paths (close,
 * update, create) come in later phases.
 */
export class BeadsCli extends ServiceMap.Service<BeadsCli, {
  readonly ready: (repoPath: string) => Effect.Effect<ReadonlyArray<BeadTask>, BeadsCliError>
  readonly list: (
    repoPath: string,
    options?: { readonly status?: "open" | "closed" | "in_progress" | undefined }
  ) => Effect.Effect<ReadonlyArray<BeadTask>, BeadsCliError>
  readonly show: (repoPath: string, beadId: string) => Effect.Effect<BeadTask, BeadsCliError | BeadNotFoundError>
  readonly search: (repoPath: string, query: string) => Effect.Effect<ReadonlyArray<BeadTask>, BeadsCliError>
}>()("@taskbridge/BeadsCli") {
  static readonly layer: Layer.Layer<BeadsCli, never, ChildProcessSpawner> = Layer.effect(BeadsCli)(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner

      const runJson = (args: ReadonlyArray<string>, repoPath: string) =>
        Effect.gen(function*() {
          const command = ChildProcess.make({ cwd: repoPath })`bd ${args}`
          const stdout = yield* spawner.string(command).pipe(
            Effect.mapError((cause) =>
              new BeadsCliError({
                message: `bd ${args.join(" ")} failed in ${repoPath}: ${String(cause)}`
              })
            )
          )
          return yield* Effect.try({
            try: () => JSON.parse(stdout) as unknown,
            catch: (cause) =>
              new BeadsCliError({
                message: `bd ${args.join(" ")} returned non-JSON: ${String(cause)}`
              })
          })
        })

      const decodeArrayE = (raw: unknown) =>
        decodeArray(raw).pipe(
          Effect.mapError((cause) => new BeadsCliError({ message: `Failed to decode bd output: ${String(cause)}` }))
        )

      return BeadsCli.of({
        ready: (repoPath) => Effect.flatMap(runJson(["ready", "--json"], repoPath), decodeArrayE),

        list: (repoPath, options) => {
          const args: Array<string> = ["list", "--json"]
          if (options?.status !== undefined) {
            args.push("--status", options.status)
          }
          return Effect.flatMap(runJson(args, repoPath), decodeArrayE)
        },

        show: (repoPath, beadId) =>
          Effect.gen(function*() {
            const raw = yield* runJson(["show", beadId, "--json"], repoPath)
            // `bd show` returns either a single object or a one-element array
            // depending on the version. Normalise both shapes.
            const candidate = Array.isArray(raw) ? raw[0] : raw
            if (candidate === undefined || candidate === null) {
              return yield* new BeadNotFoundError({ beadId })
            }
            return yield* decodeOne(candidate).pipe(
              Effect.mapError((cause) => new BeadsCliError({ message: `Failed to decode bd show: ${String(cause)}` }))
            )
          }),

        // Title-substring + ID-prefix search via `bd search`. Verified in
        // subtask 1mq that `bd search --json` works cleanly and is NOT
        // affected by the `wisp_dependencies` bug from issue 0hz (unlike
        // `bd blocked --json`, which is). Status filter is "open" by default
        // upstream — we don't pass --status here so the agent gets the same
        // shape as `bd list` for consistency.
        search: (repoPath, query) => Effect.flatMap(runJson(["search", query, "--json"], repoPath), decodeArrayE)
      })
    })
  )
}
