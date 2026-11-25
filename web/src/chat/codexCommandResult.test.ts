import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { toolDurationMs } from '@/components/ToolCard/toolDuration'
import { getToolTimingDetails } from '@/components/ToolCard/ToolCard'
import { getToolGroupTiming } from '@/components/ToolCard/ToolGroupCard'
import { reconcileChatBlocks } from './reconcile'
import type { ToolCallBlock } from './types'
import type { DecryptedMessage } from '@/types/api'

function message(data: unknown, createdAt = 20_000): DecryptedMessage {
    return { id: `m-${createdAt}`, seq: createdAt, localId: null, createdAt,
        content: { role: 'agent', content: { type: 'codex', data } } }
}

function reduce(messages: DecryptedMessage[]) {
    const normalized = messages.map(normalizeDecryptedMessage).filter(value => value !== null)
    const block = reduceChatBlocks(normalized, null).blocks.find(block => block.kind === 'tool-call')
    if (!block || block.kind !== 'tool-call') throw new Error('missing command card')
    return block.tool
}

const command = 'bun run vite --host 127.0.0.1 --port 3422'
const result = (output: Record<string, unknown>, extra = {}) => message({
    type: 'tool-call-result', callId: 'command', output: { type: 'exec_command_end', command, ...output }, ...extra
})

describe('late Codex command results', () => {
    it.each([{ status: 'failed' }, { exit_code: -1 }, { status: 'cancelled' }, { status: 'declined' }, { error: 'terminated' }])(
        'preserves native failure without a top-level flag: %j', output => {
            expect(reduce([result(output)]).state).toBe('error')
        })

    it('recovers identity and native duration without inventing a start timestamp', () => {
        const tool = reduce([result({ exit_code: -1, duration_ms: 16_636_720, cwd: '/repo/web' })])
        expect(tool).toMatchObject({ name: 'CodexBash', input: { command, cwd: '/repo/web' }, startedAt: null })
        expect(toolDurationMs(tool)).toBe(16_636_720)
        expect(getToolTimingDetails(tool, 25_000)).toEqual({ startedAt: null, completedAt: 20_000, durationMs: 16_636_720 })
    })

    it.each([undefined, -1, NaN, Infinity, '100'])('does not manufacture duration from an invalid native value: %s', duration_ms => {
        const tool = reduce([result({ status: 'completed', exit_code: 0, duration_ms })])
        expect(tool.state).toBe('completed')
        expect(toolDurationMs(tool)).toBeNull()
        expect(getToolTimingDetails(tool, 25_000).startedAt).toBeNull()
    })

    it('preserves a genuine zero native duration and explicit error flag', () => {
        const tool = reduce([result({ exit_code: 0, duration_ms: 0 }, { is_error: true })])
        expect(tool.state).toBe('error')
        expect(toolDurationMs(tool)).toBe(0)
    })

    it.each([false, true])('pairs a start loaded later and preserves native duration (result first: %s)', reverse => {
        const start = message({ type: 'tool-call', name: 'CodexBash', callId: 'command', input: { command, cwd: '/original' } }, 10_000)
        const end = result({ exit_code: 0, duration_ms: 8_000 })
        const tool = reduce(reverse ? [end, start] : [start, end])
        expect(tool).toMatchObject({ name: 'CodexBash', startedAt: 10_000, completedAt: 20_000, state: 'completed' })
        expect(tool.input).toMatchObject({ cwd: '/original' })
        expect(toolDurationMs(tool)).toBe(8_000)
    })

    it('does not interpret unrelated tool output as a Codex command result', () => {
        const tool = reduce([message({ type: 'tool-call-result', callId: 'other', output: { status: 'failed', exit_code: -1, command, duration_ms: 100 } })])
        expect(tool.name).toBe('Tool')
        expect(tool.state).toBe('completed')
    })

    it('does not manufacture an aggregate start or duration for a group with an unknown start', () => {
        const tool = reduce([result({ exit_code: -1, duration_ms: 10_000 })])
        const block: ToolCallBlock = { kind: 'tool-call', id: 'command', localId: null, createdAt: 20_000, tool, children: [] }
        expect(getToolGroupTiming([block], 25_000)).toEqual({ startedAt: null, completedAt: 20_000, durationMs: null, running: false })
    })

    it('reconciles native timing updates without retaining a stale card', () => {
        const tool = reduce([result({ exit_code: 0, duration_ms: 100 })])
        const before: ToolCallBlock = { kind: 'tool-call', id: 'command', localId: null, createdAt: 20_000, tool, children: [] }
        const after = { ...before, tool: { ...tool, executionDurationMs: 200 } }
        const reconciled = reconcileChatBlocks([after], new Map([[before.id, before]]))
        expect(reconciled.blocks[0]).toBe(after)
    })
})
