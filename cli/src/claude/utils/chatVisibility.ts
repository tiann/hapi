import type { RawJSONLines } from '@/claude/types'
import { isClaudeChatVisibleMessage as isSharedClaudeChatVisibleMessage } from '@hapi/protocol/messages'

export function isClaudeChatVisibleMessage(message: Pick<RawJSONLines, 'type'> & { subtype?: string }): boolean {
    return isSharedClaudeChatVisibleMessage(message)
}
