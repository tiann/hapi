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

    it('extracts task-notification summary as event from sidechain block', () => {
        const msg: TracedMessage = {
            id: 'msg-notif',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'n-1', prompt: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }],
            isSidechain: true
        } as TracedMessage

        const { blocks } = reduceTimeline([msg], makeContext())
        const events = blocks.filter(b => b.kind === 'agent-event')
        expect(events).toHaveLength(1)
        expect((events[0] as any).event.message).toBe('Background command stopped')
    })

    it('suppresses sentinel reply to task-notification (summary path)', () => {
        const notifMsg: TracedMessage = {
            id: 'msg-notif',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{ type: 'sidechain', uuid: 'notif-uuid', prompt: '<task-notification> <summary>Done</summary> </task-notification>' }],
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

    it('merges turn-duration event into assistant block by targetMessageId', () => {
        const assistantMsg = makeAgentMessage('Thinking...', { id: 'target-msg-id' })
        const durationEvent: TracedMessage = {
            id: 'event-1',
            role: 'event',
            createdAt: 1_700_000_002_000,
            content: { type: 'turn-duration', durationMs: 1500, targetMessageId: 'target-msg-id' }
        } as TracedMessage

        const { blocks } = reduceTimeline([assistantMsg, durationEvent], makeContext())
        const agentTextBlock = blocks.find(b => b.kind === 'agent-text') as any
        expect(agentTextBlock).toBeDefined()
        expect(agentTextBlock.durationMs).toBe(1500)
    })

    it('merges turn-duration event into the last assistant block as fallback', () => {
        const assistantMsg = makeAgentMessage('Hello')
        const durationEvent: TracedMessage = {
            id: 'event-1',
            role: 'event',
            createdAt: 1_700_000_002_000,
            content: { type: 'turn-duration', durationMs: 2500 } // No targetMessageId
        } as TracedMessage

        const { blocks } = reduceTimeline([assistantMsg, durationEvent], makeContext())
        const agentTextBlock = blocks.find(b => b.kind === 'agent-text') as any
        expect(agentTextBlock).toBeDefined()
        expect(agentTextBlock.durationMs).toBe(2500)
    })

    it('propagates model information to assistant blocks', () => {
        const assistantMsg = makeAgentMessage('Hello', { model: 'claude-3-opus' })
        const { blocks } = reduceTimeline([assistantMsg], makeContext())

        const agentTextBlock = blocks.find(b => b.kind === 'agent-text') as any
        expect(agentTextBlock).toBeDefined()
        expect(agentTextBlock.model).toBe('claude-3-opus')
    })

    it('preserves per-message model across mid-session model switches', () => {
        const earlier = makeAgentMessage('Earlier reply', {
            id: 'msg-earlier',
            createdAt: 1_700_000_000_000,
            model: 'claude-3-opus'
        })
        const later = makeAgentMessage('Later reply', {
            id: 'msg-later',
            createdAt: 1_700_000_001_000,
            model: 'gemini-3-flash-preview',
            content: [{ type: 'text', text: 'Later reply', uuid: 'u-2', parentUUID: null }]
        })

        const { blocks } = reduceTimeline([earlier, later], makeContext())
        const earlierBlock = blocks.find(b => b.id === 'msg-earlier:0') as any
        const laterBlock = blocks.find(b => b.id === 'msg-later:0') as any
        expect(earlierBlock.model).toBe('claude-3-opus')
        expect(laterBlock.model).toBe('gemini-3-flash-preview')
    })

    it('leaves model undefined when message lacks per-message model', () => {
        const assistantMsg = makeAgentMessage('Hello without model')
        const { blocks } = reduceTimeline([assistantMsg], makeContext())

        const agentTextBlock = blocks.find(b => b.kind === 'agent-text') as any
        expect(agentTextBlock).toBeDefined()
        expect(agentTextBlock.model).toBeUndefined()
    })

    it('falls back to the last duration-bearing block when targetMessageId resolves to a non-duration block', () => {
        // Regression: the matcher used to take the first id-prefix match and
        // then silently drop the duration when that block was not duration-
        // bearing (agent-event / user-text). The fallback search must run.
        const userMsg = makeUserMessage('Earlier user text', { id: 'u-prefix' })
        const assistantMsg = makeAgentMessage('Assistant reply', { id: 'asst-1' })
        const durationEvent: TracedMessage = {
            id: 'event-fallback',
            role: 'event',
            createdAt: 1_700_000_002_000,
            // targetMessageId matches a user-text block id by prefix; the
            // matcher must skip it (kind is not duration-bearing) and fall
            // back to the last assistant-like block.
            content: { type: 'turn-duration', durationMs: 9999, targetMessageId: 'u-prefix' }
        } as TracedMessage

        const { blocks } = reduceTimeline([userMsg, assistantMsg, durationEvent], makeContext())
        const userBlock = blocks.find(b => b.kind === 'user-text') as any
        const agentBlock = blocks.find(b => b.kind === 'agent-text') as any
        expect((userBlock as { durationMs?: number }).durationMs).toBeUndefined()
        expect(agentBlock.durationMs).toBe(9999)
    })

    it('preserves the original tool-call invokedAt when the matching tool-result message arrives later', () => {
        // Regression: the second `ensureToolBlock` call (driven by a
        // tool-result message) used to overwrite the tool-call's invokedAt
        // with the result message's invokedAt, so the rendered "Invoke"
        // timestamp told the user when the result was processed instead of
        // when the tool was invoked.
        const toolUseMsg: TracedMessage = {
            id: 'msg-call',
            localId: null,
            createdAt: 1_700_000_000_000,
            invokedAt: 1_700_000_000_500,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tc-invoked-at',
                name: 'Bash',
                input: { command: 'ls' },
                description: null,
                uuid: 'u-1',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage
        const toolResultMsg: TracedMessage = {
            id: 'msg-result',
            localId: null,
            createdAt: 1_700_000_001_000,
            invokedAt: 1_700_000_002_000, // would clobber the tool-call invokedAt without the guard
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: 'tc-invoked-at',
                content: 'ok',
                is_error: false,
                uuid: 'u-2',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([toolUseMsg, toolResultMsg], makeContext())
        const toolBlock = blocks.find(b => b.kind === 'tool-call') as any
        expect(toolBlock).toBeDefined()
        expect(toolBlock.invokedAt).toBe(1_700_000_000_500)
    })

    it('populates block.children for Agent tool (same as Task)', () => {
        // Agent tool_use message with a sidechain group
        const agentToolMsg: TracedMessage = {
            id: 'msg-agent',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tc-agent-1',
                name: 'Agent',
                input: { prompt: 'explore stuff', subagent_type: 'general-purpose' },
                description: null,
                uuid: 'u-agent',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage

        // Sidechain child message that would be in the group for msg-agent
        const sidechainChild: TracedMessage = {
            id: 'sc-msg-1',
            localId: null,
            createdAt: 1_700_000_001_000,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tc-glob-1',
                name: 'Glob',
                input: { pattern: '**/*.ts' },
                description: null,
                uuid: 'u-sc-1',
                parentUUID: null
            }],
            isSidechain: true,
            sidechainId: 'msg-agent'
        } as TracedMessage

        // Build groups map the way the real pipeline does it
        const groups = new Map<string, TracedMessage[]>()
        groups.set('msg-agent', [sidechainChild])

        const ctx = { ...makeContext(), groups }
        const { blocks } = reduceTimeline([agentToolMsg], ctx)

        const agentBlock = blocks.find(b => b.kind === 'tool-call') as any
        expect(agentBlock).toBeDefined()
        // block.children must be populated for Agent (was broken before fix)
        expect(agentBlock.children.length).toBeGreaterThan(0)
    })

    it('suppresses prompt-text duplicate for Agent tool (same as Task)', () => {
        // When an agent message contains an Agent tool_use, Claude often writes
        // the prompt as a text block before the tool_use. The reducer must skip
        // that duplicate text just like it does for Task.
        const prompt = 'explore the repository structure'
        const agentMsg: TracedMessage = {
            id: 'msg-agent-dup',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [
                { type: 'text', text: prompt, uuid: 'u-text', parentUUID: null },
                {
                    type: 'tool-call',
                    id: 'tc-agent-2',
                    name: 'Agent',
                    input: { prompt, subagent_type: 'Explore' },
                    description: null,
                    uuid: 'u-agent',
                    parentUUID: null
                }
            ],
            isSidechain: false
        } as TracedMessage

        const { blocks } = reduceTimeline([agentMsg], makeContext())
        // text block with same content as Agent.input.prompt must be suppressed
        const textBlocks = blocks.filter(b => b.kind === 'agent-text')
        expect(textBlocks).toHaveLength(0)
    })

    it('keeps toolBlocksById reference identity when applying turn-duration to a tool-call', () => {
        const toolCallMsg: TracedMessage = {
            id: 'msg-tool',
            localId: null,
            createdAt: 1_700_000_000_000,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tc-1',
                name: 'Bash',
                input: { command: 'ls' },
                description: null,
                uuid: 'u-1',
                parentUUID: null
            }],
            isSidechain: false
        } as TracedMessage
        const durationEvent: TracedMessage = {
            id: 'event-1',
            role: 'event',
            createdAt: 1_700_000_001_000,
            content: { type: 'turn-duration', durationMs: 1234, targetMessageId: 'msg-tool' }
        } as TracedMessage

        const { blocks, toolBlocksById } = reduceTimeline([toolCallMsg, durationEvent], makeContext())
        const toolBlock = blocks.find(b => b.kind === 'tool-call') as any
        expect(toolBlock).toBeDefined()
        expect(toolBlock.durationMs).toBe(1234)
        // The block in `blocks` and the one indexed in `toolBlocksById` must be
        // the same object reference, so that subsequent permission/result
        // mutations land on the rendered block instead of a stale clone.
        expect(toolBlocksById.get('tc-1')).toBe(toolBlock)
    })
})
