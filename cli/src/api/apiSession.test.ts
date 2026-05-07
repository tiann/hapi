import { describe, expect, it } from 'vitest'
import { isExternalUserMessage, IncomingMessageFilter } from './apiSession'

describe('isExternalUserMessage', () => {
    const baseUserMsg = {
        type: 'user' as const,
        uuid: 'test-uuid',
        userType: 'external' as const,
        isSidechain: false,
        message: { role: 'user', content: 'hello' },
    }

    it('returns true for a real user text message', () => {
        expect(isExternalUserMessage(baseUserMsg)).toBe(true)
    })

    it('returns false when isMeta is true (skill injections)', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isMeta: true })).toBe(false)
    })

    it('returns false when isSidechain is true', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isSidechain: true })).toBe(false)
    })

    it('returns false when content is an array (tool results)', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
            } as never)
        ).toBe(false)
    })

    it('returns false for assistant messages', () => {
        expect(
            isExternalUserMessage({
                type: 'assistant',
                uuid: 'test-uuid',
                message: { role: 'assistant', content: 'hi' },
            } as never)
        ).toBe(false)
    })

    // System-injected content detection
    it('returns false for <task-notification> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })

    it('returns false for <command-name> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<command-name>/clear</command-name>' },
            })
        ).toBe(false)
    })

    it('returns false for <local-command-caveat> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
            })
        ).toBe(false)
    })

    it('returns false for <system-reminder> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<system-reminder>\nToday is 2026.\n</system-reminder>' },
            })
        ).toBe(false)
    })

    it('returns true for user text that mentions XML-like strings but is not injected', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: 'How do I use the <task-notification> tag?' },
            })
        ).toBe(true)
    })

    it('returns false for <task-notification> with leading whitespace', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '  \n<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })
})

describe('IncomingMessageFilter (HAPI Bot R3 finding #1)', () => {
    it('accepts a mature scheduled message whose seq is below the latest cursor', () => {
        // schedule seq=10, immediate seq=11 acks first → cursor=11.
        // seq=10 matures: seq-only dedup would drop it; id-based dedup must accept.
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ id: 'msg-imm', seq: 11 })).toBe(true)
        expect(filter.accept({ id: 'msg-sched', seq: 10 })).toBe(true)
    })

    it('rejects an exact id duplicate (re-emit on the next mature tick)', () => {
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ id: 'msg-1', seq: 1 })).toBe(true)
        expect(filter.accept({ id: 'msg-1', seq: 1 })).toBe(false)
    })

    it('falls back to seq-only dedup for messages without an id', () => {
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ seq: 5 })).toBe(true)
        // seq <= cursor and no id → drop (legacy behaviour preserved).
        expect(filter.accept({ seq: 4 })).toBe(false)
        expect(filter.accept({ seq: 5 })).toBe(false)
    })

    it('advances cursorSeq monotonically regardless of arrival order', () => {
        const filter = new IncomingMessageFilter()
        filter.accept({ id: 'a', seq: 11 })
        filter.accept({ id: 'b', seq: 10 })
        expect(filter.cursorSeq()).toBe(11)
    })

    it('bounds the seen-id set to the configured capacity (LRU eviction)', () => {
        const filter = new IncomingMessageFilter(3)
        filter.accept({ id: 'a', seq: 1 })
        filter.accept({ id: 'b', seq: 2 })
        filter.accept({ id: 'c', seq: 3 })
        filter.accept({ id: 'd', seq: 4 })
        // 'a' should have been evicted — re-presenting it is treated as new.
        expect(filter.accept({ id: 'a', seq: 5 })).toBe(true)
        // 'd' is still in the set.
        expect(filter.accept({ id: 'd', seq: 6 })).toBe(false)
    })

    it('refreshes recency on dedup hit so re-emits survive bursts of unrelated ids', () => {
        // Models the documented contract: the hub re-emits the same id every 5 s
        // until the CLI acks.  If the dedup were FIFO (insert-order only), a
        // burst of capacity-many unrelated ids between re-emits would evict the
        // pending id and the next re-emit would double-deliver.
        const filter = new IncomingMessageFilter(3)
        // Pre-fill so 'pending' is not at the head.
        filter.accept({ id: 'a', seq: 1 })
        filter.accept({ id: 'pending', seq: 2 })
        filter.accept({ id: 'b', seq: 3 })
        // Re-emit pending → recency refresh moves it to the tail.
        expect(filter.accept({ id: 'pending', seq: 4 })).toBe(false)
        // Burst that evicts oldest entries.  Without the refresh 'pending' would
        // be at insert position 2 and would be evicted; with the refresh it is
        // now the newest entry and survives.
        filter.accept({ id: 'c', seq: 5 })
        filter.accept({ id: 'd', seq: 6 })
        // 'a' (oldest) and then 'b' should have been evicted; 'pending' must
        // still dedup.
        expect(filter.accept({ id: 'pending', seq: 7 })).toBe(false)
        expect(filter.accept({ id: 'a', seq: 8 })).toBe(true)
        expect(filter.accept({ id: 'b', seq: 9 })).toBe(true)
    })
})
