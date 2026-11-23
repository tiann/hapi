import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock, ToolCallBlock } from '@/chat/types'
import { filterConciseChatBlocks } from '@/chat/conciseView'

function tool(id: string, name: string, overrides: Partial<ToolCallBlock['tool']> = {}, children: ChatBlock[] = []): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id,
            name,
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: null,
            permission: undefined,
            ...overrides,
        },
        children,
    }
}

function text(id: string): ChatBlock {
    return { kind: 'agent-text', id, localId: null, createdAt: 1, text: id }
}

function reasoning(id: string): ChatBlock {
    return { kind: 'agent-reasoning', id, localId: null, createdAt: 1, text: id }
}

function user(id: string): ChatBlock {
    return { kind: 'user-text', id, localId: null, createdAt: 1, text: id }
}

function event(id: string, value: AgentEvent): ChatBlock {
    return { kind: 'agent-event', id, createdAt: 1, event: value }
}

function ids(blocks: ChatBlock[]): string[] {
    return blocks.map((block) => block.id)
}

describe('filterConciseChatBlocks', () => {
    it('keeps user messages and the trailing reply of each round', () => {
        const blocks = [
            user('u1'),
            reasoning('r1'),
            text('narration-1'),
            tool('t1', 'Bash'),
            text('narration-2'),
            tool('t2', 'Edit'),
            text('final-1a'),
            text('final-1b'),
            user('u2'),
            text('final-2'),
        ]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1', 'final-1a', 'final-1b', 'u2', 'final-2'])
    })

    it('treats trailing reasoning as work, so earlier text is not the reply', () => {
        const blocks = [user('u1'), text('narration'), reasoning('r1')]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1'])
    })

    it('shows the latest narration of a running round until the next tool call', () => {
        const streaming = [user('u1'), tool('t1', 'Read'), text('working')]
        expect(ids(filterConciseChatBlocks(streaming))).toEqual(['u1', 'working'])

        const movedOn = [...streaming, tool('t2', 'Bash', { state: 'running' })]
        expect(ids(filterConciseChatBlocks(movedOn))).toEqual(['u1'])
    })

    it('keeps blocks that need the user and drops ordinary work', () => {
        const blocks = [
            user('u1'),
            tool('todo', 'TodoWrite'),
            tool('task', 'Task'),
            tool('pending', 'Bash', { state: 'pending', permission: { id: 'p1', status: 'pending' } }),
            tool('question', 'AskUserQuestion'),
            tool('plan', 'ExitPlanMode'),
            tool('user-shell', 'CodexBash', { input: { command: 'ls', command_source: 'userShell' } }),
        ]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1', 'pending', 'question', 'plan', 'user-shell'])
    })

    it('keeps a subagent whose nested tool is waiting for approval', () => {
        const nested = tool('child', 'Bash', { state: 'pending', permission: { id: 'p1', status: 'pending' } })
        const blocks = [user('u1'), tool('task', 'Task', {}, [nested]), tool('other-task', 'Task', {}, [tool('done', 'Read')])]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1', 'task'])
    })

    it('keeps errors and terminal failures but drops status events', () => {
        const blocks = [
            user('u1'),
            event('title', { type: 'title-changed', title: 'x' }),
            event('duration', { type: 'turn-duration', durationMs: 1 }),
            event('retry', { type: 'api-error', retryAttempt: 1, maxRetries: 3, error: null }),
            event('gave-up', { type: 'api-error', retryAttempt: 3, maxRetries: 3, error: null }),
            event('error', { type: 'error', message: 'boom' }),
            event('limit', { type: 'limit-reached', endsAt: 1, limitType: 'five_hour' }),
            event('aborted', { type: 'message', message: 'Aborted by user' }),
        ]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1', 'gave-up', 'error', 'limit', 'aborted'])
    })

    it('keeps agent output that is not intermediate work', () => {
        const image: ChatBlock = {
            kind: 'generated-image',
            id: 'image',
            localId: null,
            createdAt: 1,
            imageId: 'img',
            fileName: 'a.png',
            mimeType: 'image/png',
        }
        const userCli: ChatBlock = { kind: 'cli-output', id: 'cli-user', localId: null, createdAt: 1, text: '/cost', source: 'user' }
        const agentCli: ChatBlock = { kind: 'cli-output', id: 'cli-agent', localId: null, createdAt: 1, text: '$0.10', source: 'assistant' }
        const blocks = [user('u1'), tool('t1', 'Bash'), image, userCli, agentCli]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['u1', 'image', 'cli-user', 'cli-agent'])
    })

    it('filters a window that starts mid-round before any user message', () => {
        const blocks = [text('older-narration'), tool('t1', 'Bash'), text('final'), user('u2')]

        expect(ids(filterConciseChatBlocks(blocks))).toEqual(['final', 'u2'])
    })
})
