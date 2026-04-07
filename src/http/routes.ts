import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { boardHandler } from "./handlers/board.ts"
import { projectsHandler } from "./handlers/projects.ts"
import { taskHandler } from "./handlers/task.ts"

/**
 * The complete route table for the MVP. Each `HttpRouter.add` returns a
 * Layer that requires `HttpRouter`; `Layer.mergeAll` composes them.
 *
 * Adding write-path routes later just means appending more `HttpRouter.add`
 * calls here.
 */
export const RoutesLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/slash/projects", projectsHandler),
  HttpRouter.add("POST", "/slash/board", boardHandler),
  HttpRouter.add("POST", "/slash/task", taskHandler)
)
