import * as Schema from "effect/Schema"
import { ProjectKey } from "../domain/ProjectKey.ts"

/**
 * One entry in `config/projects.toml`. `repo` may be a git URL (cloned into
 * `REPOS_DIR/<key>`) or `"."` (use the local working tree directly — handy
 * for bootstrapping the MVP without setting up GitHub auth).
 */
export class ProjectConfig extends Schema.Class<ProjectConfig>("ProjectConfig")({
  key: ProjectKey,
  repo: Schema.String,
  branch: Schema.optional(Schema.String),
  display_name: Schema.String,
  color: Schema.String
}) {}

export const ProjectConfigArray = Schema.Array(ProjectConfig)
