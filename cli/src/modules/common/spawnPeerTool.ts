import { z } from 'zod'
import { ChatCreationOverridesSchema } from '@hapi/protocol'

export const SpawnPeerInputSchema = ChatCreationOverridesSchema.extend({
    message: z.string().min(1).refine(value => value.trim().length > 0).describe('Initial work message for the independent chat.'),
    waitActiveSecs: z.number().positive().max(300).optional()
}).strict()
export type SpawnPeerInput = z.infer<typeof SpawnPeerInputSchema>
export const SPAWN_PEER_DESCRIPTION = 'Create an independent HAPI chat through the normal runner lifecycle and deliver its first work message. Any supported agent can create another provider (for example Claude to Codex or Codex to Claude). Omitted options inherit your shared, last-used New Chat settings for the selected machine and agent. Null explicitly clears a saved option to its normal/native default. Returns the chat ID and /sessions link for inspect_peer and ping_peer. The parent is bound to this MCP session, not supplied by the agent. Never retry an uncertain creation automatically: inspect the reported child first. A delivery failure leaves the child running.'
