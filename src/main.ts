import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { AppConfig } from "./config/AppConfig.ts"
import { RoutesLayer } from "./http/routes.ts"
import { BeadsCli } from "./services/BeadsCli.ts"
import { Git } from "./services/Git.ts"
import { ensureRepos } from "./startup/ensureRepos.ts"

/**
 * Application entrypoint. Composes the layer stack, runs the boot-time
 * repo sync, and launches the HTTP server.
 *
 * The HTTP server is wired as a Layer (via HttpServer.serve) so the runtime
 * keeps its scope alive for the lifetime of the process — using the
 * `serveEffect` form would let the scope release immediately after route
 * registration and the server would stop.
 *
 * Layer dependency chain:
 *   BunHttpServer.layer  ->  HttpServer + ChildProcessSpawner + FileSystem + ...
 *   AppConfig.layer      ->  AppConfig
 *   BeadsCli.layer       ->  BeadsCli   (needs ChildProcessSpawner)
 *   Git.layer            ->  Git        (needs ChildProcessSpawner)
 *   HttpRouter.layer     ->  HttpRouter
 *   RoutesLayer          ->  side-effects: registers routes on HttpRouter
 */
const HttpAppLayer = Layer.unwrap(
  Effect.gen(function*() {
    yield* ensureRepos
    const config = yield* AppConfig
    const httpApp = yield* HttpRouter.toHttpEffect(RoutesLayer)
    yield* Effect.log(`mattermost-taskbridge serving on :${config.port}`)
    return HttpServer.serve(httpApp)
  })
)

const ServicesLayer = Layer.mergeAll(
  AppConfig.layer,
  BeadsCli.layer,
  Git.layer
)

const ServerLayer = BunHttpServer.layer({ port: 3100 })

const MainLayer = HttpAppLayer.pipe(
  Layer.provide(ServicesLayer),
  Layer.provide(HttpRouter.layer),
  Layer.provide(ServerLayer)
)

BunRuntime.runMain(Layer.launch(MainLayer))
