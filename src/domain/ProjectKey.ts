import * as Schema from "effect/Schema"

/**
 * Identifier for a configured project. Matches the prefix Beads uses on
 * issue IDs (e.g. `obsidian-mcp-server` is the project key for issue
 * `obsidian-mcp-server-2pv`).
 */
export const ProjectKey = Schema.String.pipe(Schema.brand("ProjectKey"))
export type ProjectKey = typeof ProjectKey.Type

/**
 * Parse a bead ID into its `{ projectKey, suffix }` parts using the longest
 * configured project key as the prefix.
 *
 * Returns `null` if no configured key is a prefix of the bead ID. Longest-
 * prefix matching is required because two project keys could share a prefix
 * (e.g. "foo" and "foo-bar").
 */
export const parseFromBeadId = (
  beadId: string,
  configuredKeys: ReadonlyArray<ProjectKey>
): { readonly projectKey: ProjectKey; readonly suffix: string } | null => {
  const sorted = [...configuredKeys].sort((a, b) => b.length - a.length)
  for (const key of sorted) {
    const prefix = `${key}-`
    if (beadId.startsWith(prefix)) {
      return { projectKey: key, suffix: beadId.slice(prefix.length) }
    }
  }
  return null
}
