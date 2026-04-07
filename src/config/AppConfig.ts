import * as Config from "effect/Config"
import type { ConfigError } from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import { ProjectConfig, ProjectConfigArray } from "./ProjectConfig.ts"

export class AppConfigError extends Schema.TaggedErrorClass<AppConfigError>()("AppConfigError", {
  message: Schema.String
}) {}

/**
 * Default location of the projects registry. Override at runtime by setting
 * `PROJECTS_CONFIG_PATH`. The k8s ConfigMap mount uses this to swap the
 * dev-baked file for the production registry without rebuilding the image.
 */
const DEFAULT_PROJECTS_PATH = "./config/projects.json"

/**
 * Application configuration assembled from environment variables and the
 * `config/projects.toml` registry. Loaded once at startup; injected as a
 * service so handlers don't reach for `process.env`.
 */
export class AppConfig extends ServiceMap.Service<AppConfig, {
  readonly mattermostUrl: string
  readonly mattermostBotToken: string
  readonly slashCommandToken: string
  readonly githubToken: string
  readonly reposDir: string
  readonly port: number
  readonly projects: ReadonlyArray<ProjectConfig>
}>()("@taskbridge/AppConfig") {
  static readonly layer: Layer.Layer<AppConfig, ConfigError | AppConfigError> = Layer.effect(AppConfig)(
    Effect.gen(function*() {
      const mattermostUrl = yield* Config.string("MATTERMOST_URL").pipe(
        Config.withDefault("http://mattermost-service.mattermost.svc.cluster.local")
      )
      const mattermostBotToken = yield* Config.string("MATTERMOST_BOT_TOKEN").pipe(
        Config.withDefault("")
      )
      const slashCommandToken = yield* Config.string("SLASH_COMMAND_TOKEN").pipe(
        Config.withDefault("")
      )
      const githubToken = yield* Config.string("GITHUB_TOKEN").pipe(
        Config.withDefault("")
      )
      const reposDir = yield* Config.string("REPOS_DIR").pipe(
        Config.withDefault("/data/repos")
      )
      const port = yield* Config.int("PORT").pipe(
        Config.withDefault(3100)
      )
      const projectsPath = yield* Config.string("PROJECTS_CONFIG_PATH").pipe(
        Config.withDefault(DEFAULT_PROJECTS_PATH)
      )

      // Read projects.json fresh at boot so a k8s ConfigMap remount picks up
      // on the next pod restart. We deliberately avoid `import` here because
      // `bun build --compile` would inline the file at build time, defeating
      // the override.
      const projectsJson = yield* Effect.tryPromise({
        try: () => Bun.file(projectsPath).json() as Promise<{ projects?: unknown }>,
        catch: (cause) =>
          new AppConfigError({
            message: `Failed to read ${projectsPath}: ${String(cause)}`
          })
      })
      const raw = projectsJson?.projects ?? []
      const projects = yield* Schema.decodeUnknownEffect(ProjectConfigArray)(raw).pipe(
        Effect.mapError((cause) =>
          new AppConfigError({
            message: `Failed to decode ${projectsPath}: ${String(cause)}`
          })
        )
      )

      return AppConfig.of({
        mattermostUrl,
        mattermostBotToken,
        slashCommandToken,
        githubToken,
        reposDir,
        port,
        projects
      })
    })
  )
}
