/**
 * Tests for traceMessages — verifies that both Task and Agent tool names
 * are indexed and matched when grouping sidechain messages.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import { traceMessages } from '@/chat/tracer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentMsg(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
    const { id, ...rest } = overrides
    return {
        id,
        localId: null,
        createdAt: 1_700_000_000_000,
        role: 'agent',
        isSidechain: false,
        content: [],
        ...rest,
    } as NormalizedMessage
}

function makeToolCallMsg(
    id: string,
    toolName: 'Task' | 'Agent',
    prompt: string,
): NormalizedMessage {
    return makeAgentMsg({
        id,
        content: [
            {
                type: 'tool-call',
                id: `tc-${id}`,
                name: toolName,
                input: { prompt, subagent_type: 'general-purpose' },
                description: null,
                uuid: `uuid-${id}`,
                parentUUID: null,
            },
        ],
    })
}

function makeSidechainRootMsg(id: string, prompt: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: 1_700_000_001_000,
        role: 'agent',
        isSidechain: true,
        content: [
            {
                type: 'sidechain',
                uuid: `uuid-sc-${id}`,
                prompt,
            },
        ],
    } as NormalizedMessage
}

// ---------------------------------------------------------------------------
// Task — existing behaviour preserved
// ---------------------------------------------------------------------------

describe('traceMessages — Task tool name (preserved)', () => {
    it('matches sidechain root to a Task tool_use message', () => {
        const prompt = 'list .ts files'
        const taskMsg = makeToolCallMsg('msg-task', 'Task', prompt)
        const sidechainRoot = makeSidechainRootMsg('sc-root', prompt)

        const result = traceMessages([taskMsg, sidechainRoot])
        const sc = result.find(m => m.id === 'sc-root')
        expect(sc).toBeDefined()
        expect(sc!.sidechainId).toBe('msg-task')
    })

    it('does not assign sidechainId when prompt does not match', () => {
        const taskMsg = makeToolCallMsg('msg-task', 'Task', 'original prompt')
        const sidechainRoot = makeSidechainRootMsg('sc-root', 'different prompt')

        const result = traceMessages([taskMsg, sidechainRoot])
        const sc = result.find(m => m.id === 'sc-root')
        expect(sc).toBeDefined()
        expect(sc!.sidechainId).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// Agent — new SDK tool name (regression fix)
// ---------------------------------------------------------------------------

describe('traceMessages — Agent tool name (regression fix)', () => {
    it('indexes Agent prompt and matches sidechain root to the Agent message', () => {
        const prompt = 'explore the repo structure'
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', prompt)
        const sidechainRoot = makeSidechainRootMsg('sc-root', prompt)

        const result = traceMessages([agentMsg, sidechainRoot])
        const sc = result.find(m => m.id === 'sc-root')
        expect(sc).toBeDefined()
        // Before fix: sidechainId would be undefined because 'Agent' was not indexed
        expect(sc!.sidechainId).toBe('msg-agent')
    })

    it('does not assign sidechainId when Agent prompt does not match', () => {
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', 'original prompt')
        const sidechainRoot = makeSidechainRootMsg('sc-root', 'different prompt')

        const result = traceMessages([agentMsg, sidechainRoot])
        const sc = result.find(m => m.id === 'sc-root')
        expect(sc!.sidechainId).toBeUndefined()
    })

    it('handles both Task and Agent in the same message list', () => {
        const taskPrompt = 'task prompt'
        const agentPrompt = 'agent prompt'
        const taskMsg = makeToolCallMsg('msg-task', 'Task', taskPrompt)
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', agentPrompt)
        const scForTask = makeSidechainRootMsg('sc-task', taskPrompt)
        const scForAgent = makeSidechainRootMsg('sc-agent', agentPrompt)

        const result = traceMessages([taskMsg, agentMsg, scForTask, scForAgent])
        const scTaskResult = result.find(m => m.id === 'sc-task')
        const scAgentResult = result.find(m => m.id === 'sc-agent')
        expect(scTaskResult!.sidechainId).toBe('msg-task')
        expect(scAgentResult!.sidechainId).toBe('msg-agent')
    })
})
