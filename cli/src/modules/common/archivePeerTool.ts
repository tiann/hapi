import { z } from 'zod'

export const ARCHIVE_PEER_TOOL_DESCRIPTION =
    'Archive this HAPI chat or another chat on the same hub and namespace, preserving its history for reopening. ' +
    'Omit sessionIdPrefix for this chat, or pass a full session ID or unique prefix for another chat. ' +
    'Uses the same stop-and-archive operation as the user interface. No additional confirmation is required. ' +
    'Finish and save your work before self-archiving: this stops your agent and the connection may close before you receive the result. ' +
    'A missing response does not prove failure; inspect the chat from another session before retrying. Never deletes chats.'

export const archivePeerInputSchema = z.object({
    sessionIdPrefix: z.string().trim().min(1).optional()
        .describe('Target session ID or unique prefix. Omit to archive this chat. Full IDs avoid ambiguity.')
})
