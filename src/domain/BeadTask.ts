import * as Schema from "effect/Schema"

/**
 * The status enum returned by `bd list --json` / `bd ready --json`.
 *
 * Verified values are "open" and "closed". `in_progress` is documented in
 * the bd CLI but not seen in this repo's data yet — accepting it loudly so
 * a real claim doesn't blow up the decoder.
 */
export const BeadStatus = Schema.Literals(["open", "in_progress", "closed"])
export type BeadStatus = typeof BeadStatus.Type

export const BeadIssueType = Schema.Literals(["task", "bug", "feature", "chore", "epic", "decision"])
export type BeadIssueType = typeof BeadIssueType.Type

/**
 * The shape returned by `bd list --json`. Field names mirror the CLI output
 * exactly — note `issue_type` (not `type`) and `owner` (always present, an
 * email). `assignee` is only set when the issue has been claimed.
 */
export class BeadTask extends Schema.Class<BeadTask>("BeadTask")({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: BeadStatus,
  priority: Schema.Int,
  issue_type: BeadIssueType,
  owner: Schema.String,
  assignee: Schema.optional(Schema.String),
  created_at: Schema.String,
  created_by: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.String),
  close_reason: Schema.optional(Schema.String),
  // Present on `bd list` / `bd ready` output but not on `bd show` (which
  // returns rich `dependents` / `dependencies` arrays instead).
  dependency_count: Schema.optional(Schema.Int),
  dependent_count: Schema.optional(Schema.Int),
  comment_count: Schema.optional(Schema.Int)
}) {}

export const BeadTaskArray = Schema.Array(BeadTask)
