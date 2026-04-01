import { describe, expect, it } from 'vitest'
import { reduceTimeline } from './reducerTimeline'
import type { TracedMessage } from './tracer'

function makeContext() {
    return {
        permissionsById: new Map(),
        groups: new Map(),
        consumedGroupIds: new Set<string>(),
        titleChangesByToolUseId: new Map(),
        emittedTitleChangeToolUseIds: new Set<string>()
    }
}

function makeUserMessage(text: string, overrides?: Partial<TracedMessage>): TracedMessage {
    return {
        id: 'msg-1',
        localId: null,
        createdAt: 1_700_000_000_000,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false,
        ...overrides
    } as TracedMessage
}

describe('reduceTimeline – system injection filtering', () => {
    it('converts <task-notification> with summary to agent-event', () => {
        const text = `<task-notification> <task-id>abc</task-id> <status>killed</status> <summary>Background command "Download benchmarks" was stopped</summary> </task-notification>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(1)
        expect(blocks[0].kind).toBe('agent-event')
        if (blocks[0].kind === 'agent-event') {
            expect(blocks[0].event).toEqual({
                type: 'message',
                message: 'Background command "Download benchmarks" was stopped'
            })
        }
    })

    it('silently drops <task-notification> without summary', () => {
        const text = `<task-notification> <task-id>abc</task-id> <status>killed</status> </task-notification>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(0)
    })

    it('silently drops <task-notification> with empty summary', () => {
        const text = `<task-notification> <summary></summary> <status>completed</status> </task-notification>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(0)
    })

    it('handles <task-notification> with leading whitespace', () => {
        const text = `  \n  <task-notification> <summary>Task done</summary> </task-notification>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(1)
        expect(blocks[0].kind).toBe('agent-event')
    })

    it('hides <system-reminder> messages', () => {
        const text = `<system-reminder>\nSome internal reminder\n</system-reminder>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(0)
    })

    it('hides <command-name> messages', () => {
        const text = `<command-name>commit</command-name>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(0)
    })

    it('hides <local-command-caveat> messages', () => {
        const text = `<local-command-caveat>some caveat</local-command-caveat>`
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(0)
    })

    it('passes through normal user text as user-text block', () => {
        const text = 'Hello, this is a normal message'
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(1)
        expect(blocks[0].kind).toBe('user-text')
    })
})
