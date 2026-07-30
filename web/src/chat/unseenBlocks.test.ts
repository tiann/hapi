/**
 * Tests for the "N new messages" counter. The regression these guard against:
 * the count used to be computed over raw messages, so a subagent run (dozens of
 * sidechain messages folded into one Task card) and every tool_result inflated
 * it far beyond what the user would actually see on screen.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, type VisibleChatBlock } from '@/chat/toolGroups'
import { countUnseenBlocks, createUnseenWatermark } from '@/chat/unseenBlocks'

const BASE_AT = 1_700_000_000_000

function userMsg(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false
    }
}

function agentText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text, uuid: `uuid-${id}`, parentUUID: null }]
    } as NormalizedMessage
}

function agentReasoning(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'reasoning', text, uuid: `uuid-${id}`, parentUUID: null }]
    } as NormalizedMessage
}

function toolCall(id: string, name: string, createdAt: number, input: unknown = {}): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: `tc-${id}`,
            name,
            input,
            description: null,
            uuid: `uuid-${id}`,
            parentUUID: null
        }]
    } as NormalizedMessage
}

function toolResult(id: string, toolUseId: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-result',
            tool_use_id: toolUseId,
            content: 'ok',
            is_error: false,
            uuid: `uuid-${id}`,
            parentUUID: null
        }]
    } as NormalizedMessage
}

/** A message produced inside a subagent run, grouped by parentToolUseId. */
function sidechainMsg(id: string, parentToolUseId: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: true,
        parentToolUseId,
        content: [{ type: 'text', text: `subagent step ${id}`, uuid: `uuid-${id}`, parentUUID: null }]
    } as NormalizedMessage
}

function visible(messages: NormalizedMessage[], hasMoreMessages = false): VisibleChatBlock[] {
    const reduced = reduceChatBlocks(messages, null)
    return buildVisibleChatBlocks(reduced.blocks, { hasMoreMessages })
}

describe('countUnseenBlocks', () => {
    it('returns 0 without a watermark', () => {
        const blocks = visible([userMsg('u1', 'hi', BASE_AT)])
        expect(countUnseenBlocks(blocks, null)).toBe(0)
    })

    it('returns 0 when nothing arrived after the watermark', () => {
        const blocks = visible([userMsg('u1', 'hi', BASE_AT), agentText('a1', 'hello', BASE_AT + 1)])
        expect(countUnseenBlocks(blocks, createUnseenWatermark(blocks))).toBe(1 - 1)
    })

    it('counts a whole subagent run as the single Task card it renders as', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        // One Task tool_use followed by 30 sidechain messages from the subagent.
        const subagentRun: NormalizedMessage[] = [
            toolCall('task-1', 'Task', BASE_AT + 1, { prompt: 'explore', subagent_type: 'Explore' }),
            ...Array.from({ length: 30 }, (_, index) =>
                sidechainMsg(`sc-${index}`, 'tc-task-1', BASE_AT + 2 + index))
        ]

        const blocks = visible([...seed, ...subagentRun])
        expect(countUnseenBlocks(blocks, watermark)).toBe(1)

        // Guard against a false pass: the 30 messages must actually be folded
        // into the Task card, not silently dropped before reaching the reducer.
        const taskCard = blocks.at(-1)
        expect(taskCard?.kind).toBe('tool-call')
        expect(taskCard?.kind === 'tool-call' && taskCard.children.length).toBe(30)
    })

    it('counts a run of grouped tools as one collapsed group', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        const reads = Array.from({ length: 20 }, (_, index) =>
            toolCall(`read-${index}`, 'Read', BASE_AT + 1 + index, { file_path: `/tmp/${index}.ts` }))

        const blocks = visible([...seed, ...reads])
        expect(countUnseenBlocks(blocks, watermark)).toBe(1)
    })

    it('does not count a tool_result that completes an already-counted card', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        const withCall = [...seed, toolCall('bash-1', 'Bash', BASE_AT + 1, { command: 'ls' })]
        const beforeResult = countUnseenBlocks(visible(withCall), watermark)

        const withResult = [...withCall, toolResult('res-1', 'tc-bash-1', BASE_AT + 2)]
        const afterResult = countUnseenBlocks(visible(withResult), watermark)

        expect(beforeResult).toBe(1)
        expect(afterResult).toBe(1)
    })

    it('ignores older blocks prepended by history pagination', () => {
        const seed = [userMsg('u2', 'second', BASE_AT + 10)]
        const watermark = createUnseenWatermark(visible(seed))

        const withNew = [...seed, agentText('a1', 'reply', BASE_AT + 20)]
        expect(countUnseenBlocks(visible(withNew), watermark)).toBe(1)

        // loadMore prepends an older page; the count must not move.
        const withOlder = [userMsg('u0', 'first', BASE_AT), ...withNew]
        expect(countUnseenBlocks(visible(withOlder), watermark)).toBe(1)
    })

    it('does not jump when a lone tool card is absorbed into a group', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        // A single eligible tool renders as a plain tool-call block (id = tool id).
        const lone = [...seed, toolCall('read-0', 'Read', BASE_AT + 1, { file_path: '/a.ts' })]
        expect(countUnseenBlocks(visible(lone), watermark)).toBe(1)

        // A second tool merges both into a group whose id is derived from the
        // first tool — the watermark must still recognize the seed as the anchor.
        const grouped = [...lone, toolCall('read-1', 'Read', BASE_AT + 2, { file_path: '/b.ts' })]
        expect(countUnseenBlocks(visible(grouped), watermark)).toBe(1)
    })

    it('reports 0 when every seen block has been trimmed out of the window', () => {
        const seed = [userMsg('u1', 'old', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        // The window scrolled past everything the watermark knew about.
        const replaced = visible([agentText('a9', 'much later', BASE_AT + 999)])
        expect(countUnseenBlocks(replaced, watermark)).toBe(0)
    })

    it('counts alternating user and assistant turns as separate rows', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        const blocks = visible([
            ...seed,
            agentText('a1', 'first', BASE_AT + 1),
            userMsg('u2', 'again', BASE_AT + 2),
            agentText('a2', 'second', BASE_AT + 3)
        ])
        expect(countUnseenBlocks(blocks, watermark)).toBe(3)
    })

    it('counts one response of reasoning + text + tool as a single row', () => {
        // assistant-ui joins adjacent assistant-role blocks into one card, so a
        // multi-part response must not read as several new messages.
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        const blocks = visible([
            ...seed,
            agentReasoning('r1', 'thinking', BASE_AT + 1),
            agentText('a1', 'here is the answer', BASE_AT + 2),
            toolCall('bash-1', 'Bash', BASE_AT + 3, { command: 'ls' })
        ])

        // Four blocks in the window...
        expect(blocks).toHaveLength(4)
        // ...but only one new card below the anchor.
        expect(countUnseenBlocks(blocks, watermark)).toBe(1)
    })

    it('does not bump the count when a response grows another assistant block', () => {
        const seed = [userMsg('u1', 'go', BASE_AT)]
        const watermark = createUnseenWatermark(visible(seed))

        const started = visible([...seed, agentText('a1', 'partial', BASE_AT + 1)])
        expect(countUnseenBlocks(started, watermark)).toBe(1)

        const continued = visible([
            ...seed,
            agentText('a1', 'partial', BASE_AT + 1),
            toolCall('bash-1', 'Bash', BASE_AT + 2, { command: 'ls' })
        ])
        expect(countUnseenBlocks(continued, watermark)).toBe(1)
    })

    it('recognizes an optimistic block after the stored row replaces its id', () => {
        // mergeMessages swaps an optimistic row for the stored one, which keeps
        // localId but carries a new server id (lib/messages.ts), and the user
        // block renders with the changing message id (reducerTimeline.ts). If the
        // user scrolls up while their own message is still optimistic, the echo
        // must not read as a brand new row.
        const earlier = visible([userMsg('u0', 'earlier turn', BASE_AT)])
        const optimistic = { ...earlier[0], id: 'local-1', localId: 'local-1' }
        const watermark = createUnseenWatermark([...earlier, optimistic])

        // The stored echo keeps localId but arrives under a server id. Anchoring
        // must still land on it, not fall back to the block before it.
        const stored = [...earlier, { ...optimistic, id: 'srv-1' }]
        expect(countUnseenBlocks(stored, watermark)).toBe(0)
    })
})
