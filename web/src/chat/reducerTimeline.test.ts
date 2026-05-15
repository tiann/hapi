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

    it('aggregates Codex agent-run events into one agent block with child trace', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files', agent_type: 'explorer' },
                    status: 'starting',
                    statusText: 'Starting',
                    summary: 'Inspect files',
                    activity: 'Starting task',
                    activityKind: 'starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-update',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Running',
                    activity: 'Running command: ls'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-trace-tool',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    message: {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: 'cmd-1',
                        input: { command: 'ls' }
                    }
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-trace-result',
                localId: null,
                createdAt: 1_700_000_003_000,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    message: {
                        type: 'tool-call-result',
                        callId: 'cmd-1',
                        output: { stdout: 'ok\n', exit_code: 0 },
                        is_error: false
                    }
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-trace-message',
                localId: null,
                createdAt: 1_700_000_004_000,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    message: {
                        type: 'message',
                        message: 'agent done'
                    }
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-done',
                localId: null,
                createdAt: 1_700_000_005_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'completed',
                    statusText: 'Completed',
                    activity: 'Completed: agent done',
                    result: 'agent done'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())

        expect(blocks).toHaveLength(1)
        const agentBlock = blocks[0] as any
        expect(agentBlock.kind).toBe('tool-call')
        expect(agentBlock.tool.name).toBe('CodexAgent')
        expect(agentBlock.tool.state).toBe('completed')
        expect(agentBlock.tool.result).toBe('agent done')
        expect(agentBlock.tool.input).toMatchObject({
            agent_type: 'explorer',
            agentId: 'agent-1',
            statusText: 'Completed',
            summary: 'Inspect files',
            activity: 'Completed: agent done'
        })
        expect(agentBlock.children.some((child: any) => child.kind === 'tool-call' && child.tool.id === 'codex-agent:agent-1:call:cmd-1')).toBe(true)
        expect(agentBlock.children.some((child: any) => child.kind === 'agent-text' && child.text === 'agent done')).toBe(true)
    })

    it('keeps new Codex agent trace commands nested under the existing agent block', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files' },
                    status: 'starting',
                    summary: 'Inspect files',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-update',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    activity: 'Running command: ls'
                },
                isSidechain: false
            } as TracedMessage,
            ...['cmd-1', 'cmd-2'].flatMap((callId, index) => ([
                {
                    id: `${callId}-trace`,
                    localId: null,
                    createdAt: 1_700_000_002_000 + index * 2,
                    role: 'event',
                    content: {
                        type: 'agent-run-trace',
                        cardId: 'spawn-1',
                        agentId: 'agent-1',
                        message: {
                            type: 'tool-call',
                            name: 'CodexBash',
                            callId,
                            input: { command: callId === 'cmd-1' ? 'ls' : 'pwd' }
                        }
                    },
                    isSidechain: false
                } as TracedMessage,
                {
                    id: `${callId}-result`,
                    localId: null,
                    createdAt: 1_700_000_003_000 + index * 2,
                    role: 'event',
                    content: {
                        type: 'agent-run-trace',
                        cardId: 'spawn-1',
                        agentId: 'agent-1',
                        message: {
                            type: 'tool-call-result',
                            callId,
                            output: { stdout: 'ok\n', exit_code: 0 },
                            is_error: false
                        }
                    },
                    isSidechain: false
                } as TracedMessage
            ]))
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlock = blocks[0] as any

        expect(blocks).toHaveLength(1)
        expect(agentBlock.tool.name).toBe('CodexAgent')
        expect(agentBlock.children.filter((child: any) => child.kind === 'tool-call')).toHaveLength(2)
        expect(agentBlock.children.map((child: any) => child.kind === 'tool-call' ? child.tool.id : null).filter(Boolean)).toEqual([
            'codex-agent:agent-1:call:cmd-1',
            'codex-agent:agent-1:call:cmd-2'
        ])
    })

    it('namespaces Codex child trace tool ids away from parent tool ids', () => {
        const messages: TracedMessage[] = [
            {
                id: 'parent-tool',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'cmd-1',
                    name: 'CodexBash',
                    input: { command: 'echo parent' },
                    description: null,
                    uuid: 'parent-tool',
                    parentUUID: null
                }],
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files' },
                    status: 'starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-update',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-trace-tool',
                localId: null,
                createdAt: 1_700_000_003_000,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    message: {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: 'cmd-1',
                        input: { command: 'echo child' }
                    }
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const parentBlock = blocks.find((block: any) => block.kind === 'tool-call' && block.tool.id === 'cmd-1') as any
        const agentBlock = blocks.find((block: any) => block.kind === 'tool-call' && block.tool.name === 'CodexAgent') as any

        expect(parentBlock).toBeDefined()
        expect(parentBlock.tool.input).toEqual({ command: 'echo parent' })
        expect(agentBlock).toBeDefined()
        expect(agentBlock.children.some((child: any) => (
            child.kind === 'tool-call'
            && child.tool.id === 'codex-agent:agent-1:call:cmd-1'
            && child.tool.input.command === 'echo child'
        ))).toBe(true)
    })

    it('merges fallback Codex agent card ids into the spawn card for the same agent', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect README' },
                    status: 'starting',
                    summary: 'Inspect README',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-early-update',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'codex-agent:agent-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Running',
                    activity: 'Starting task'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-early-trace',
                localId: null,
                createdAt: 1_700_000_001_500,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'codex-agent:agent-1',
                    agentId: 'agent-1',
                    message: {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: 'cmd-1',
                        input: { command: 'pwd' }
                    }
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-linked-update',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Running',
                    activity: 'Started'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-late-fallback-update',
                localId: null,
                createdAt: 1_700_000_003_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'codex-agent:agent-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Waiting for agent',
                    activity: 'Waiting for agent',
                    activityKind: 'wait_agent'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks, toolBlocksById } = reduceTimeline(messages, makeContext())
        const agentBlocks = blocks.filter((block: any) => block.kind === 'tool-call' && block.tool.name === 'CodexAgent') as any[]

        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0].id).toBe('spawn-1')
        expect(toolBlocksById.has('spawn-1')).toBe(true)
        expect(toolBlocksById.has('codex-agent:agent-1')).toBe(false)
        expect(agentBlocks[0].tool.input).toMatchObject({
            agentId: 'agent-1',
            summary: 'Inspect README',
            activity: 'Waiting for agent',
            activityKind: 'wait_agent'
        })
        expect(agentBlocks[0].children.some((child: any) => child.kind === 'tool-call' && child.tool.id === 'codex-agent:agent-1:call:cmd-1')).toBe(true)
    })

    it('does not create an orphan Codex agent card for fallback notFound updates', () => {
        const messages: TracedMessage[] = [
            {
                id: 'stale-agent-wait',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'codex-agent:stale-agent',
                    agentId: 'stale-agent',
                    status: 'running',
                    statusText: 'Waiting for agent',
                    activity: 'Waiting for agent',
                    activityKind: 'wait_agent'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'stale-agent-not-found',
                localId: null,
                createdAt: 1_700_000_000_500,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'codex-agent:stale-agent',
                    agentId: 'stale-agent',
                    status: 'notFound',
                    statusText: 'notFound',
                    activity: 'notFound: {"status":"notFound","message":null}'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'new-agent-start',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect README' },
                    status: 'starting',
                    summary: 'Inspect README',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'new-agent-done',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'completed',
                    statusText: 'Completed',
                    activity: 'Completed: ok',
                    result: 'ok'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks, toolBlocksById } = reduceTimeline(messages, makeContext())
        const agentBlocks = blocks.filter((block: any) => block.kind === 'tool-call' && block.tool.name === 'CodexAgent') as any[]

        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0].id).toBe('spawn-1')
        expect(toolBlocksById.has('codex-agent:stale-agent')).toBe(false)
    })

    it('shows notFound as an error when it belongs to a known Codex agent card', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect README' },
                    status: 'starting',
                    summary: 'Inspect README',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-linked',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    activity: 'Started'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-not-found',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'codex-agent:agent-1',
                    agentId: 'agent-1',
                    status: 'notFound',
                    statusText: 'notFound',
                    activity: 'notFound: {"status":"notFound","message":null}'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlock = blocks[0] as any

        expect(blocks).toHaveLength(1)
        expect(agentBlock.id).toBe('spawn-1')
        expect(agentBlock.tool.state).toBe('error')
        expect(agentBlock.tool.input).toMatchObject({
            agentId: 'agent-1',
            agentStatus: 'notFound'
        })
    })

    it('does not regress a completed Codex agent card to running on a later wait_agent begin', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files' },
                    status: 'starting',
                    summary: 'Inspect files',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-done',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'completed',
                    statusText: 'Completed',
                    activity: 'Completed: done',
                    result: 'done'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-wait-begin',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Waiting for agent',
                    activity: 'Waiting for agent',
                    activityKind: 'wait_agent'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlock = blocks[0] as any

        expect(agentBlock.tool.state).toBe('completed')
        expect(agentBlock.tool.input).toMatchObject({
            agentStatus: 'completed',
            statusText: 'Completed',
            activity: 'Completed: done'
        })
    })

    it('keeps Codex agent elapsed time stable when the start event fell out of the visible window', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-update',
                localId: null,
                createdAt: 1_700_000_010_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    startedAt: 1_700_000_000_000,
                    status: 'running',
                    statusText: 'Running command',
                    activity: 'Running command: test'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-trace',
                localId: null,
                createdAt: 1_700_000_020_000,
                role: 'event',
                content: {
                    type: 'agent-run-trace',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    startedAt: 1_700_000_000_000,
                    message: {
                        type: 'message',
                        message: 'still running'
                    }
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlock = blocks[0] as any

        expect(agentBlock.tool.name).toBe('CodexAgent')
        expect(agentBlock.tool.state).toBe('running')
        expect(agentBlock.tool.startedAt).toBe(1_700_000_000_000)
    })

    it('does not turn a completed Codex agent card into an error when close_agent cleans it up', () => {
        const messages: TracedMessage[] = [
            {
                id: 'agent-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'review diff' },
                    status: 'starting',
                    summary: 'Review diff',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-done',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'completed',
                    statusText: 'Completed',
                    activity: 'Completed: approved',
                    result: 'approved'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-close-begin',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    statusText: 'Closing agent',
                    activity: 'Closing agent',
                    activityKind: 'close_agent'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'agent-close-end',
                localId: null,
                createdAt: 1_700_000_003_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'canceled',
                    statusText: 'Closed',
                    activity: 'Closed',
                    activityKind: 'canceled',
                    result: { previous_status: { completed: 'approved' }, agent_id: 'agent-1' }
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlock = blocks[0] as any

        expect(agentBlock.tool.state).toBe('completed')
        expect(agentBlock.tool.result).toBe('approved')
        expect(agentBlock.tool.input).toMatchObject({
            agentStatus: 'completed',
            activity: 'Completed: approved'
        })
    })

    it('drops duplicate orphan Codex agent starts with the same work summary', () => {
        const messages: TracedMessage[] = [
            {
                id: 'orphan-start',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-orphan',
                    input: { message: 'inspect README' },
                    status: 'starting',
                    summary: 'Inspect README',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'real-start',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'agent-run-start',
                    cardId: 'spawn-real',
                    input: { message: 'inspect README' },
                    status: 'starting',
                    summary: 'Inspect README',
                    activity: 'Starting'
                },
                isSidechain: false
            } as TracedMessage,
            {
                id: 'real-update',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'agent-run-update',
                    cardId: 'spawn-real',
                    agentId: 'agent-real',
                    status: 'completed',
                    summary: 'Inspect README',
                    activity: 'Completed: ok',
                    result: 'ok'
                },
                isSidechain: false
            } as TracedMessage
        ]

        const { blocks } = reduceTimeline(messages, makeContext())
        const agentBlocks = blocks.filter((block: any) => block.kind === 'tool-call' && block.tool.name === 'CodexAgent') as any[]

        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0].id).toBe('spawn-real')
        expect(agentBlocks[0].tool.input).toMatchObject({
            agentId: 'agent-real',
            summary: 'Inspect README',
            activity: 'Completed: ok'
        })
    })
})
