import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from './types'
import { annotateCodexSidechains } from './codexSidechain'

function agentToolCall(
    id: string,
    name: string,
    input: unknown,
    createdAt: number
): NormalizedMessage {
    return {
        id: `msg-${id}`,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id,
            name,
            input,
            description: null,
            uuid: `uuid-${id}`,
            parentUUID: null
        }]
    }
}

function agentToolResult(
    toolUseId: string,
    content: unknown,
    createdAt: number
): NormalizedMessage {
    return {
        id: `msg-${toolUseId}-result`,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-result',
            tool_use_id: toolUseId,
            content,
            is_error: false,
            uuid: `uuid-${toolUseId}-result`,
            parentUUID: null
        }]
    }
}

function agentText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'text',
            text,
            uuid: `uuid-${id}`,
            parentUUID: null
        }]
    }
}

function agentReasoning(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'reasoning',
            text,
            uuid: `uuid-${id}`,
            parentUUID: null
        }]
    }
}

function userText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        isSidechain: false,
        content: { type: 'text', text }
    }
}

describe('annotateCodexSidechains', () => {
    it('marks inline child messages under the matching CodexSpawnAgent', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'Search GitHub trending' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1', nickname: 'Pauli' }, 2),
            userText('child-user', 'child prompt', 3),
            agentText('child-agent', 'child answer', 4),
            agentReasoning('child-reasoning', 'child thought', 5),
            agentToolCall('child-tool', 'CodexSendInput', { target: 'agent-1', message: 'ping' }, 6),
            agentToolResult('child-tool', { ok: true }, 7),
            userText('notification', '<subagent_notification> done', 8),
            agentToolCall('wait-1', 'CodexWaitAgent', { targets: ['agent-1'], timeout_ms: 120000 }, 9)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[2]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[3]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[4]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[5]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[6]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[7]).toMatchObject({ isSidechain: false })
        expect(result[8]).toMatchObject({ isSidechain: false })
    })

    it('keeps messages root-level when the spawn result has no agent_id', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'Search GitHub trending' }, 1),
            agentToolResult('spawn-1', { nickname: 'Pauli' }, 2),
            userText('child-user', 'child prompt', 3),
            agentText('child-agent', 'child answer', 4),
            agentToolCall('wait-1', 'CodexWaitAgent', { targets: ['agent-1'], timeout_ms: 120000 }, 5)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[2]).toMatchObject({ isSidechain: false })
        expect(result[3]).toMatchObject({ isSidechain: false })
        expect(result[4]).toMatchObject({ isSidechain: false })
    })

    it('binds sequential spawns to the correct spawn key', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'First' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1' }, 2),
            userText('child-1-user', 'first child prompt', 3),
            agentText('child-1-agent', 'first child answer', 4),
            agentToolCall('wait-1', 'CodexWaitAgent', { targets: ['agent-1'] }, 5),
            agentToolCall('spawn-2', 'CodexSpawnAgent', { message: 'Second' }, 6),
            agentToolResult('spawn-2', { agent_id: 'agent-2' }, 7),
            userText('child-2-user', 'second child prompt', 8),
            agentText('child-2-agent', 'second child answer', 9),
            agentToolCall('wait-2', 'CodexWaitAgent', { targets: ['agent-2'] }, 10)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[2]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[3]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[7]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-2' })
        expect(result[8]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-2' })
        expect(result[4]).toMatchObject({ isSidechain: false })
        expect(result[9]).toMatchObject({ isSidechain: false })
    })

    it('keeps earlier spawned agents active when a newer spawn closes first', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'First' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1' }, 2),
            agentToolCall('spawn-2', 'CodexSpawnAgent', { message: 'Second' }, 3),
            agentToolResult('spawn-2', { agent_id: 'agent-2' }, 4),
            agentToolCall('wait-2', 'CodexWaitAgent', { targets: ['agent-2'] }, 5),
            userText('child-1-user', 'first child prompt resumes', 6),
            agentText('child-1-agent', 'first child answer resumes', 7),
            agentToolCall('wait-1', 'CodexWaitAgent', { targets: ['agent-1'] }, 8)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[4]).toMatchObject({ isSidechain: false })
        expect(result[5]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[6]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[7]).toMatchObject({ isSidechain: false })
    })

    it('marks live inline child messages after a valid spawn call before the spawn result lands', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'Delegate task' }, 1),
            userText('child-user', 'live child prompt', 2),
            agentText('child-agent', 'live child answer', 3),
            agentToolResult('spawn-1', { agent_id: 'agent-1', nickname: 'Pauli' }, 4),
            agentToolCall('wait-1', 'CodexWaitAgent', { targets: ['agent-1'] }, 5)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[1]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[2]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[3]).toMatchObject({ isSidechain: false })
        expect(result[4]).toMatchObject({ isSidechain: false })
    })

    it('does not nest a later CodexSpawnAgent tool call under the currently active child', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'First child' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1' }, 2),
            agentToolCall('spawn-2', 'CodexSpawnAgent', { message: 'Second child' }, 3),
            agentToolResult('spawn-2', { agent_id: 'agent-2' }, 4)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[2]).toMatchObject({ isSidechain: false })
        expect(result[3]).toMatchObject({ isSidechain: false })
    })

    it('preserves explicit sidechain keys for parallel live child streams', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'First child' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1' }, 2),
            agentToolCall('spawn-2', 'CodexSpawnAgent', { message: 'Second child' }, 3),
            agentToolResult('spawn-2', { agent_id: 'agent-2' }, 4),
            {
                ...userText('child-1-user', 'first child prompt', 5),
                isSidechain: true,
                sidechainKey: 'spawn-1'
            },
            {
                ...userText('child-2-user', 'second child prompt', 6),
                isSidechain: true,
                sidechainKey: 'spawn-2'
            },
            {
                ...agentText('child-1-agent', 'first child answer', 7),
                isSidechain: true,
                sidechainKey: 'spawn-1'
            },
            {
                ...agentText('child-2-agent', 'second child answer', 8),
                isSidechain: true,
                sidechainKey: 'spawn-2'
            }
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[4]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[5]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-2' })
        expect(result[6]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-1' })
        expect(result[7]).toMatchObject({ isSidechain: true, sidechainKey: 'spawn-2' })
    })

    it('does not heuristically assign untagged messages when multiple child agents are active', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1', 'CodexSpawnAgent', { message: 'First child' }, 1),
            agentToolResult('spawn-1', { agent_id: 'agent-1' }, 2),
            agentToolCall('spawn-2', 'CodexSpawnAgent', { message: 'Second child' }, 3),
            agentToolResult('spawn-2', { agent_id: 'agent-2' }, 4),
            agentText('root-parent-progress', 'Parent progress update', 5),
            agentText('stray-child-reply', 'First child answer', 6)
        ]

        const result = annotateCodexSidechains(messages)

        expect(result[4]).toMatchObject({ isSidechain: false })
        expect(result[5]).toMatchObject({ isSidechain: false })
    })
})
