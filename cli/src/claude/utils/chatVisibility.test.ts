import { describe, expect, it } from 'vitest'
import { isClaudeChatVisibleMessage } from './chatVisibility'

describe('isClaudeChatVisibleMessage', () => {
    it('hides unsupported Claude system messages from chat delivery', () => {
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'stop_hook_summary' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'init' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'system' })).toBe(false)
    })

    it('keeps supported Claude system events visible', () => {
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'turn_duration' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'api_error' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'microcompact_boundary' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'compact_boundary' })).toBe(true)
    })

    it('keeps conversation messages visible', () => {
        expect(isClaudeChatVisibleMessage({ type: 'user' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'assistant' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'summary' })).toBe(true)
    })

    it('hides rate_limit_event messages from chat delivery', () => {
        expect(isClaudeChatVisibleMessage({ type: 'rate_limit_event' } as any)).toBe(false)
    })
})
