/**
 * Mattermost slash command response payloads. The shape is Slack-compatible
 * (https://developers.mattermost.com/integrate/slash-commands/custom/#response).
 *
 * The MVP only emits text + attachments (no `actions` array yet — that's
 * Phase 1's interactive button extension, deferred per the plan).
 */

export type ResponseType = "in_channel" | "ephemeral"

export interface AttachmentField {
  readonly short: boolean
  readonly title: string
  readonly value: string
}

export interface Attachment {
  readonly color?: string
  readonly title?: string
  readonly text?: string
  readonly fields?: ReadonlyArray<AttachmentField>
}

export interface SlashResponse {
  readonly response_type: ResponseType
  readonly text: string
  readonly username?: string
  readonly icon_url?: string
  readonly props?: { readonly attachments?: ReadonlyArray<Attachment> }
}

export const ephemeral = (text: string): SlashResponse => ({
  response_type: "ephemeral",
  text
})

export const inChannel = (
  text: string,
  attachments?: ReadonlyArray<Attachment>
): SlashResponse => ({
  response_type: "in_channel",
  text,
  ...(attachments ? { props: { attachments } } : {})
})
