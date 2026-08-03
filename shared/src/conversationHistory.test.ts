import { describe, expect, it } from 'bun:test'
import {
    CLAUDE_CONVERSATION_HISTORY,
    markUnsupported,
    toConversationHistoryCapabilities
} from './conversationHistory'

describe('conversationHistory capabilities', () => {
    it('only exposes supported flags', () => {
        expect(toConversationHistoryCapabilities(CLAUDE_CONVERSATION_HISTORY)).toEqual({
            forkCurrent: true
        })
    })

    it('keeps unsupported sticky', () => {
        const next = markUnsupported(
            { forkCurrent: 'supported', forkAtMessage: 'supported', rewindToMessage: 'supported' },
            'rewindToMessage'
        )
        expect(toConversationHistoryCapabilities(next)).toEqual({
            forkCurrent: true,
            forkAtMessage: true
        })
    })
})
