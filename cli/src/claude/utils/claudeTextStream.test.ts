import { describe, expect, it, vi } from 'vitest'
import { SDKToLogConverter } from './sdkToLogConverter'

describe('Claude text streaming', () => {
    function setup() {
        const converter = new SDKToLogConverter({ sessionId: 'session', cwd: '.', gitBranch: 'main' })
        const event = (event: Record<string, unknown>, parent: string | null = null) =>
            converter.convert({ type: 'stream_event', event, parent_tool_use_id: parent })
        const start = (id = 'answer', parent: string | null = null) => {
            event({ type: 'message_start', message: { id } }, parent)
            event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, parent)
        }
        const delta = (text: string, parent: string | null = null) =>
            event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, parent)
        return { converter, event, start, delta }
    }

    it('shows text before completion and reconciles the final text without advancing the parent chain', () => {
        const { converter, start, delta } = setup()
        const user = converter.convert({ type: 'user', message: { role: 'user', content: 'hello' } })!
        start()
        const partial = delta('Hello')!
        expect(partial).toMatchObject({ type: 'assistant', live: true, parentUuid: user.uuid })
        const final = converter.convert({ type: 'assistant', message: {
            id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }]
        } })!
        expect(final).toMatchObject({ parentUuid: user.uuid, streamIds: (partial as any).streamIds })
        expect((final as any).message.content[0]).toMatchObject({
            text: 'Hello world!', streamId: (partial as any).message.content[0].streamId
        })
        expect(final).not.toHaveProperty('live')
    })

    it('throttles snapshots, preserves repeated fragments, and flushes the block tail', () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        try {
            const { event, start, delta } = setup()
            start()
            expect(delta('ha')).not.toBeNull()
            expect(delta('ha')).toBeNull()
            const tail = event({ type: 'content_block_stop', index: 1 })!
            expect((tail as any).message.content[0].text).toBe('haha')
        } finally { clock.mockRestore() }
    })

    it('keeps interleaved subagent streams separate and ignores tool argument deltas', () => {
        const { event, start, delta } = setup()
        start('main')
        start('child', 'tool-1')
        const main = delta('Main')!
        const child = delta('Child', 'tool-1')!
        expect(child).toMatchObject({ isSidechain: true, parentToolUseId: 'tool-1' })
        expect((main as any).streamIds).not.toEqual((child as any).streamIds)
        expect(event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{' } })).toBeNull()
    })

    it('does not expose internal compaction summaries as live answers', () => {
        const { converter, start, delta } = setup()
        converter.convert({ type: 'system', subtype: 'status', status: 'compacting' })
        start()
        expect(delta('Internal summary')).toBeNull()
        converter.convert({ type: 'system', subtype: 'compact_boundary' })
        start('next')
        expect(delta('Visible answer')).not.toBeNull()
    })

    it('maps successive completed text blocks to their original stream indices', () => {
        const { converter, event, start, delta } = setup()
        start()
        const first = delta('first') as any
        const finish = (text: string) => converter.convert({ type: 'assistant', message: {
            id: 'answer', role: 'assistant', content: [{ type: 'text', text }]
        } }) as any
        expect(finish('first').streamIds).toEqual(first.streamIds)
        event({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'second' } })
        expect(finish('second').streamIds).toEqual(['claude:answer::3'])
    })
})
