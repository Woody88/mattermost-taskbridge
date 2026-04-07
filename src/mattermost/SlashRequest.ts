import * as Schema from "effect/Schema"

/**
 * The application/x-www-form-urlencoded body Mattermost POSTs to a custom
 * slash command's Request URL. Verified field set per
 * https://developers.mattermost.com/integrate/slash-commands/custom/
 *
 * `token` matches the `Authorization: Token <token>` header and is the
 * per-command secret stored in env. We verify it on every request.
 */
export class SlashRequest extends Schema.Class<SlashRequest>("SlashRequest")({
  channel_id: Schema.String,
  channel_name: Schema.String,
  command: Schema.String,
  response_url: Schema.String,
  team_domain: Schema.String,
  team_id: Schema.String,
  text: Schema.String,
  token: Schema.String,
  trigger_id: Schema.String,
  user_id: Schema.String,
  user_name: Schema.String
}) {}
