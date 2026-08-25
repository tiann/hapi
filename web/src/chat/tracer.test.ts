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

// ---------------------------------------------------------------------------
// parentToolUseId direct grouping — fixes the "prompt-root never arrives"
// regression (SDK drops the sidechain root as system/task_started or as a
// top-level parent_tool_use_id:null user message for some subagents; the
// child sidechain messages still all carry parentToolUseId directly).
// ---------------------------------------------------------------------------

function makeSidechainChildMsg(
    id: string,
    parentToolUseId: string,
    parentUUID: string | null = null,
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: 1_700_000_002_000,
        role: 'agent',
        isSidechain: true,
        parentToolUseId,
        content: [
            { type: 'text', text: `child of ${parentToolUseId}`, uuid: `uuid-${id}`, parentUUID },
        ],
    } as NormalizedMessage
}

describe('traceMessages — parentToolUseId direct grouping (broken subagent case)', () => {
    it('groups a sidechain turn summary without an assistant-message uuid', () => {
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', 'investigate background task')
        const summary: NormalizedMessage = {
            id: 'sc-summary',
            localId: null,
            createdAt: 1_700_000_003_000,
            role: 'event',
            isSidechain: true,
            parentToolUseId: 'tc-msg-agent',
            content: {
                type: 'turn-summary',
                summary: { modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 2 } } }
            }
        } as NormalizedMessage

        const result = traceMessages([agentMsg, summary])

        expect(result.find(m => m.id === 'sc-summary')?.sidechainId).toBe('msg-agent')
    })

    it('groups an orphaned sidechain child directly via parentToolUseId when no prompt-root sidechain message exists', () => {
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', 'investigate background task')
        // No sidechain root carrying the prompt — SDK dropped it as system/task_started
        // (filtered) or as a top-level parent_tool_use_id:null user message. The child
        // still carries parentToolUseId pointing at the Agent tool_use's id (tc-msg-agent).
        const orphanChild = makeSidechainChildMsg('sc-child', 'tc-msg-agent')

        const result = traceMessages([agentMsg, orphanChild])
        const grouped = result.find(m => m.id === 'sc-child')
        expect(grouped).toBeDefined()
        expect(grouped!.sidechainId).toBe('msg-agent')
    })

    it('groups every descendant independently by parentToolUseId, even when their own parentUuid chain is broken', () => {
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', 'investigate background task')
        // First descendant has no resolvable parentUuid (chain seed was lost on resume).
        const child1 = makeSidechainChildMsg('sc-child-1', 'tc-msg-agent', null)
        // Second descendant chains to the first via parentUuid *and* still carries
        // parentToolUseId directly, per real SDK behaviour (every sidechain message
        // repeats parent_tool_use_id, not just the root).
        const child2 = makeSidechainChildMsg('sc-child-2', 'tc-msg-agent', 'uuid-sc-child-1')

        const result = traceMessages([agentMsg, child1, child2])
        expect(result.find(m => m.id === 'sc-child-1')!.sidechainId).toBe('msg-agent')
        expect(result.find(m => m.id === 'sc-child-2')!.sidechainId).toBe('msg-agent')
    })

    it('still falls back to prompt-root matching when parentToolUseId is absent (old stored messages)', () => {
        const prompt = 'legacy prompt without parentToolUseId'
        const agentMsg = makeToolCallMsg('msg-agent', 'Agent', prompt)
        const sidechainRoot = makeSidechainRootMsg('sc-root', prompt)

        const result = traceMessages([agentMsg, sidechainRoot])
        expect(result.find(m => m.id === 'sc-root')!.sidechainId).toBe('msg-agent')
    })

    it('groups nested subagents: a grandchild resolves to its mid-level (sidechain) Agent tool_use', () => {
        // Top-level Agent spawns a mid-level subagent; the mid-level subagent is
        // itself a sidechain message that carries its own Agent tool_use spawning a
        // grandchild. The indexing pass covers tool-calls inside sidechains, so each
        // level groups under the correct parent.
        const topAgent = makeToolCallMsg('msg-top', 'Agent', 'top-level task')
        const midAgent = makeAgentMsg({
            id: 'msg-mid',
            isSidechain: true,
            parentToolUseId: 'tc-msg-top',
            content: [
                {
                    type: 'tool-call',
                    id: 'tc-msg-mid',
                    name: 'Agent',
                    input: { prompt: 'nested task', subagent_type: 'general-purpose' },
                    description: null,
                    uuid: 'uuid-msg-mid',
                    parentUUID: null,
                },
            ],
        })
        const grandchild = makeSidechainChildMsg('sc-grandchild', 'tc-msg-mid')

        const result = traceMessages([topAgent, midAgent, grandchild])
        expect(result.find(m => m.id === 'msg-mid')!.sidechainId).toBe('msg-top')
        expect(result.find(m => m.id === 'sc-grandchild')!.sidechainId).toBe('msg-mid')
    })
})
