import { describe, expect, it } from 'vitest'
import { reduceTimeline } from './reducerTimeline'
import type { TracedMessage } from './tracer'

function makeContext() {
    return {
        permissionsById: new Map(),
        groups: new Map(),
        consumedGroupIds: new Set<string>(),
        titleChangesByToolUseId: new Map(),
        emittedTitleChangeToolUseIds: new Set<string>(),
        sendAttachmentToolUseIds: new Set<string>()
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

function makeAgentMessage(text: string, overrides?: Partial<TracedMessage>): TracedMessage {
    return {
        id: 'msg-agent-1',
        localId: null,
        createdAt: 1_700_000_000_000,
        role: 'agent',
        content: [{ type: 'text', text, uuid: 'u-1', parentUUID: null }],
        isSidechain: false,
        ...overrides
    } as TracedMessage
}

describe('reduceTimeline', () => {
    it('renders user text as user-text block', () => {
        const text = 'Hello, this is a normal message'
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(1)
        expect(blocks[0].kind).toBe('user-text')
    })

    it('does not filter XML-like user text (filtering is in normalize layer)', () => {
        const text = '<task-notification> <summary>Some task</summary> </task-notification>'
        const { blocks } = reduceTimeline([makeUserMessage(text)], makeContext())

        expect(blocks).toHaveLength(1)
        expect(blocks[0].kind).toBe('user-text')
    })

    it('suppresses "No response requested." when parentUUID points to an injected turn', () => {
        // Simulate: sidechain message with uuid 'injected-uuid', then sentinel reply pointing to it
        const injectedMsg: TracedMessage = {
            id: 'msg-injected',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'injected-uuid', prompt: '<task-notification>...</task-notification>' }],
            isSidechain: true
        } as TracedMessage

        const sentinelMsg: TracedMessage = {
            id: 'msg-sentinel',
            localId: null,
            createdAt: 1_700_000_001_000,
            role: 'agent',
            content: [{ type: 'text', text: 'No response requested.', uuid: 'u-1', parentUUID: 'injected-uuid' }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([injectedMsg, sentinelMsg], makeContext())
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(0)
    })

    it('keeps "No response requested." when parentUUID points to a normal turn (not injected)', () => {
        // parentUUID points to a normal assistant message, not an injected turn
        const normalMsg: TracedMessage = {
            id: 'msg-normal',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'text', text: 'Hello!', uuid: 'normal-uuid', parentUUID: null }],
            isSidechain: false
        } as TracedMessage

        const replyMsg: TracedMessage = {
            id: 'msg-reply',
            localId: null,
            createdAt: 1_700_000_001_000,
            role: 'agent',
            content: [{ type: 'text', text: 'No response requested.', uuid: 'u-2', parentUUID: 'normal-uuid' }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([normalMsg, replyMsg], makeContext())
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        // Should be 2: "Hello!" + "No response requested." (not filtered because parent is normal)
        expect(textBlocks).toHaveLength(2)
    })

    it('keeps "No response requested." when parentUUID is null (first message)', () => {
        const { blocks } = reduceTimeline([makeAgentMessage('No response requested.')], makeContext())
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(1)
    })

    it('keeps "No response requested." when message also has other blocks (e.g. tool calls)', () => {
        const injectedMsg: TracedMessage = {
            id: 'msg-injected',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'injected-uuid', prompt: 'system content' }],
            isSidechain: true
        } as TracedMessage

        const multiMsg: TracedMessage = {
            id: 'msg-multi',
            localId: null,
            createdAt: 1_700_000_001_000,
            role: 'agent',
            content: [
                { type: 'text', text: 'No response requested.', uuid: 'u-1', parentUUID: 'injected-uuid' },
                { type: 'tool-call', id: 'tc-1', name: 'Bash', input: { command: 'ls' }, description: null, uuid: 'u-1', parentUUID: 'injected-uuid' }
            ],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([injectedMsg, multiMsg], makeContext())
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(1)
    })

    it('keeps normal assistant text blocks', () => {
        const { blocks } = reduceTimeline([makeAgentMessage('Here is the answer.')], makeContext())

        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(1)
    })

    it('uses turn-duration event time as the display timestamp for the preceding assistant reply', () => {
        const startedAt = 1_700_000_000_000
        const completedAt = 1_700_000_125_000
        const agentMessage = makeAgentMessage('Done.', {
            id: 'msg-agent-completes',
            createdAt: startedAt
        })
        const durationEvent: TracedMessage = {
            id: 'msg-duration',
            localId: null,
            createdAt: completedAt,
            role: 'event',
            content: { type: 'turn-duration', durationMs: completedAt - startedAt },
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([agentMessage, durationEvent], makeContext())

        const textBlock = blocks.find(b => b.kind === 'agent-text')
        expect(textBlock).toMatchObject({
            kind: 'agent-text',
            createdAt: startedAt,
            displayTimestamp: completedAt
        })
    })

    it('uses ready event time as a fallback completion timestamp without rendering the ready event', () => {
        const startedAt = 1_700_000_000_000
        const completedAt = 1_700_000_045_000
        const agentMessage = makeAgentMessage('Done without duration.', {
            id: 'msg-agent-ready',
            createdAt: startedAt
        })
        const readyEvent: TracedMessage = {
            id: 'msg-ready',
            localId: null,
            createdAt: completedAt,
            role: 'event',
            content: { type: 'ready' },
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([agentMessage, readyEvent], makeContext())

        expect(blocks.some(b => b.kind === 'agent-event' && b.event.type === 'ready')).toBe(false)
        const textBlock = blocks.find(b => b.kind === 'agent-text')
        expect(textBlock).toMatchObject({
            kind: 'agent-text',
            createdAt: startedAt,
            displayTimestamp: completedAt
        })
    })

    it('extracts task-notification summary as event from sidechain block', () => {
        const msg: TracedMessage = {
            id: 'msg-notif',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'n-1', parentUUID: null, kind: 'background_notification', prompt: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }],
            isSidechain: true
        } as TracedMessage

        const { blocks } = reduceTimeline([msg], makeContext())
        const events = blocks.filter(b => b.kind === 'agent-event')
        expect(events).toHaveLength(1)
        expect((events[0] as any).event).toMatchObject({
            type: 'background-notification',
            message: 'Background command stopped',
            internalKind: 'background_notification'
        })
    })

    it('suppresses sentinel reply to task-notification (summary path)', () => {
        const notifMsg: TracedMessage = {
            id: 'msg-notif',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'notif-uuid', parentUUID: null, kind: 'background_notification', prompt: '<task-notification> <summary>Done</summary> </task-notification>' }],
            isSidechain: true
        } as TracedMessage

        const sentinelMsg: TracedMessage = {
            id: 'msg-sentinel',
            localId: null,
            createdAt: 1_700_000_001_000,
            role: 'agent',
            content: [{ type: 'text', text: 'No response requested.', uuid: 'u-1', parentUUID: 'notif-uuid' }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([notifMsg, sentinelMsg], makeContext())
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(0)
        // But the event should still be present
        const events = blocks.filter(b => b.kind === 'agent-event')
        expect(events).toHaveLength(1)
    })

    it('renders agent attachments as assistant attachment blocks', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-agent-inline://agent-att-1/chart.png',
            previewUrl: 'data:image/png;base64,AAAA'
        }
        const msg: TracedMessage = {
            id: 'msg-attachments',
            localId: null,
            createdAt: 1_700_000_000_123,
            role: 'agent',
            content: [{ type: 'attachments', attachments: [attachment], uuid: 'u-att', parentUUID: null }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([msg], makeContext())

        expect(blocks).toEqual([{
            kind: 'agent-attachments',
            id: 'msg-attachments:0',
            localId: null,
            createdAt: 1_700_000_000_123,
            attachments: [attachment],
            meta: undefined
        }])
    })

    it('does not render send_attachment tool cards when the attachment message is present', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-agent-inline://agent-att-1/chart.png',
            previewUrl: 'data:image/png;base64,AAAA'
        }
        const context = makeContext()
        context.sendAttachmentToolUseIds.add('tool-attach')
        const toolCall: TracedMessage = {
            id: 'msg-tool-call',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tool-attach',
                name: 'mcp__hapi__send_attachment',
                input: { files: [{ path: 'chart.png' }] },
                description: null,
                uuid: 'u-tool',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage
        const toolResult: TracedMessage = {
            id: 'msg-tool-result',
            localId: null,
            createdAt: 1_700_000_000_200,
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-attach',
                content: 'Sent 1 attachment to the user.',
                is_error: false,
                uuid: 'u-result',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage
        const attachmentMessage: TracedMessage = {
            id: 'msg-attachments',
            localId: null,
            createdAt: 1_700_000_000_300,
            role: 'agent',
            content: [{ type: 'attachments', attachments: [attachment], uuid: 'u-att', parentUUID: null }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([toolCall, toolResult, attachmentMessage], context)

        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({
            kind: 'agent-attachments',
            attachments: [attachment]
        })
    })

})
