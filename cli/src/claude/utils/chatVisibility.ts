import type { RawJSONLines } from '@/claude/types'
import { isClaudeChatVisibleMessage as isSharedClaudeChatVisibleMessage } from '@hapi/protocol/messages'

export function isClaudeChatVisibleMessage(message: Pick<RawJSONLines, 'type'> & { subtype?: string }): boolean {
    return isSharedClaudeChatVisibleMessage(message)
}

/** Hidden from chat, but the hub reads it to track running background tasks. */
export function isClaudeBackgroundTasksSnapshot(message: Pick<RawJSONLines, 'type'> & { subtype?: string }): boolean {
    return message.type === 'system' && message.subtype === 'background_tasks_changed'
}
