import { describe, expect, it } from 'vitest'
import {
    ClaudeStreamSnapshotEmitter,
    MAX_STREAMED_PREFIX_CHARS,
    REASONING_SNAPSHOT_THROTTLE_MS,
    TEXT_SNAPSHOT_THROTTLE_MS,
    isStreamSnapshotMessage,
    type SettledStreamMarkers,
    type StreamSnapshotMessage
} from './streamSnapshots'

type Sent = StreamSnapshotMessage[]

function makeEmitter(sent: Sent, clock: { now: number }) {
    return new ClaudeStreamSnapshotEmitter(
        (snapshot) => { sent.push(snapshot) },
        () => clock.now
    )
}

function streamEvent(event: Record<string, unknown>, parent_tool_use_id?: string) {
    return { type: 'stream_event', ...(parent_tool_use_id ? { parent_tool_use_id } : {}), event }
}

function messageStart(id: string) {
    return streamEvent({ type: 'message_start', message: { id, role: 'assistant', content: [] } })
}

function blockStart(index: number, blockType: string) {
    return streamEvent({ type: 'content_block_start', index, content_block: { type: blockType } })
}

function blockDelta(index: number, deltaType: string, text: string) {
    return streamEvent({ type: 'content_block_delta', index, delta: { type: deltaType, text, thinking: text } })
}

function blockStop(index: number) {
    return streamEvent({ type: 'content_block_stop', index })
}

function assistantComplete(id: string, text: string) {
    return {
        type: 'assistant',
        message: { id, role: 'assistant', content: [{ type: 'text', text }] }
    }
}

describe('ClaudeStreamSnapshotEmitter', () => {
    it('emits throttled live text snapshots with stable stream ids', () => {
        const sent: Sent = []
        const clock = { now: 1000 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_1'))
        emitter.handleStreamEvent(blockStart(0, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'Hello'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', ' world'))

        // Within the throttle window: only the first delta emits.
        expect(sent).toEqual([
            { type: 'message', message: 'Hello', id: 'claude-msg_1-text', live: true, streamSnapshot: true }
        ])

        clock.now += TEXT_SNAPSHOT_THROTTLE_MS
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', '!'))
        expect(sent).toEqual([
            { type: 'message', message: 'Hello', id: 'claude-msg_1-text', live: true, streamSnapshot: true },
            { type: 'message', message: 'Hello world!', id: 'claude-msg_1-text', live: true, streamSnapshot: true }
        ])
    })

    it('flushes at content_block_stop instead of waiting out the throttle', () => {
        const sent: Sent = []
        const clock = { now: 5000 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_2'))
        emitter.handleStreamEvent(blockStart(0, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'par'))
        // First snapshot goes out immediately; the next delta buffers.
        expect(sent).toEqual([
            { type: 'message', message: 'par', id: 'claude-msg_2-text', live: true, streamSnapshot: true }
        ])
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'tial'))
        expect(sent).toHaveLength(1)
        // Boundary flush fires even though the throttle window is wide open.
        emitter.handleStreamEvent(blockStop(0))
        expect(sent).toEqual([
            { type: 'message', message: 'par', id: 'claude-msg_2-text', live: true, streamSnapshot: true },
            { type: 'message', message: 'partial', id: 'claude-msg_2-text', live: true, streamSnapshot: true }
        ])
    })

    it('streams only the first text and first thinking block', () => {
        const sent: Sent = []
        const clock = { now: 0 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_3'))
        emitter.handleStreamEvent(blockStart(0, 'thinking'))
        emitter.handleStreamEvent(blockStart(1, 'text'))
        // Second text block (index 2) must not stream.
        emitter.handleStreamEvent(blockStart(2, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'thinking_delta', 'hm'))
        emitter.handleStreamEvent(blockDelta(1, 'text_delta', 'one'))
        emitter.handleStreamEvent(blockDelta(2, 'text_delta', 'two'))
        emitter.handleStreamEvent(blockStop(0))
        emitter.handleStreamEvent(blockStop(1))
        emitter.handleStreamEvent(blockStop(2))

        expect(sent).toEqual([
            { type: 'reasoning', message: 'hm', id: 'claude-msg_3-reasoning', live: true },
            { type: 'message', message: 'one', id: 'claude-msg_3-text', live: true, streamSnapshot: true }
        ])
    })

    it('returns settled markers matching the streamed ids and resets state', () => {
        const sent: Sent = []
        const clock = { now: 0 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_4'))
        emitter.handleStreamEvent(blockStart(0, 'thinking'))
        emitter.handleStreamEvent(blockStart(1, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'thinking_delta', 'think'))
        emitter.handleStreamEvent(blockDelta(1, 'text_delta', 'answer'))

        const markers = emitter.takeSettledMarkers(assistantComplete('msg_4', 'answer') as never) as SettledStreamMarkers
        expect(markers).toEqual({
            streamId: 'claude-msg_4-text',
            reasoningStreamId: 'claude-msg_4-reasoning'
        })

        // State consumed: a second settle with the same ids yields nothing.
        expect(emitter.takeSettledMarkers(assistantComplete('msg_4', 'answer') as never)).toBeNull()
    })

    it('rejects markers when the settle belongs to a different message id', () => {
        const sent: Sent = []
        const emitter = makeEmitter(sent, { now: 0 })

        emitter.handleStreamEvent(messageStart('msg_5'))
        emitter.handleStreamEvent(blockStart(0, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'streaming'))

        const markers = emitter.takeSettledMarkers(assistantComplete('msg_OTHER', 'streaming') as never)
        expect(markers).toBeNull()
    })

    it('skips sidechain stream events entirely', () => {
        const sent: Sent = []
        const emitter = makeEmitter(sent, { now: 0 })

        emitter.handleStreamEvent(messageStart('msg_6'))
        const handled = emitter.handleStreamEvent(
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'toolu_1')
        )
        expect(handled).toBe(true)
        emitter.handleStreamEvent(
            streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'side' } }, 'toolu_1')
        )
        expect(sent).toEqual([])
        // Main-stream state is untouched: settling the MAIN message still works.
        emitter.handleStreamEvent(blockStart(0, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'main'))
        const markers = emitter.takeSettledMarkers(assistantComplete('msg_6', 'main') as never)
        expect(markers).toEqual({ streamId: 'claude-msg_6-text' })
    })

    it('finalizeOpenStreams emits terminal snapshots without live markers', () => {
        const sent: Sent = []
        const clock = { now: 0 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_7'))
        emitter.handleStreamEvent(blockStart(0, 'text'))
        emitter.handleStreamEvent(blockDelta(0, 'text_delta', 'turn aborted mid'))
        clock.now += TEXT_SNAPSHOT_THROTTLE_MS * 10
        emitter.finalizeOpenStreams()

        expect(sent).toEqual([
            { type: 'message', message: 'turn aborted mid', id: 'claude-msg_7-text', live: true, streamSnapshot: true },
            { type: 'message', message: 'turn aborted mid', id: 'claude-msg_7-text', streamSnapshot: true }
        ])
        // Finalize is idempotent / stateless afterwards.
        emitter.finalizeOpenStreams()
        expect(sent).toHaveLength(2)
    })

    it('freezes streaming past the prefix cap but keeps markers for the settle', () => {
        const sent: Sent = []
        const clock = { now: 0 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_8'))
        emitter.handleStreamEvent(blockStart(0, 'text'))
        const bigChunk = 'x'.repeat(1024)
        for (let round = 0; round < 200; round++) {
            clock.now += TEXT_SNAPSHOT_THROTTLE_MS + 1
            emitter.handleStreamEvent(blockDelta(0, 'text_delta', bigChunk))
        }
        // Streaming stopped well below 200 rounds of 1KB.
        expect(sent.length).toBeLessThan(80)
        const last = sent[sent.length - 1] as { message: string }
        expect(last.message.length).toBeLessThanOrEqual(MAX_STREAMED_PREFIX_CHARS + 1024)

        // Markers still returned so the settled line replaces the prefix.
        const markers = emitter.takeSettledMarkers(assistantComplete('msg_8', 'full text') as never)
        expect(markers).toEqual({ streamId: 'claude-msg_8-text' })
    })

    it('reasoning uses its own slower throttle', () => {
        const sent: Sent = []
        const clock = { now: 0 }
        const emitter = makeEmitter(sent, clock)

        emitter.handleStreamEvent(messageStart('msg_9'))
        emitter.handleStreamEvent(blockStart(0, 'thinking'))
        emitter.handleStreamEvent(blockDelta(0, 'thinking_delta', 'a'))
        clock.now += TEXT_SNAPSHOT_THROTTLE_MS // past the text throttle, short of reasoning's
        emitter.handleStreamEvent(blockDelta(0, 'thinking_delta', 'b'))
        expect(sent).toHaveLength(1)

        clock.now += REASONING_SNAPSHOT_THROTTLE_MS
        emitter.handleStreamEvent(blockDelta(0, 'thinking_delta', 'c'))
        expect(sent).toEqual([
            { type: 'reasoning', message: 'a', id: 'claude-msg_9-reasoning', live: true },
            { type: 'reasoning', message: 'abc', id: 'claude-msg_9-reasoning', live: true }
        ])
    })

    it('ignores input_json_delta (tool arguments) and unknown events', () => {
        const sent: Sent = []
        const emitter = makeEmitter(sent, { now: 0 })

        emitter.handleStreamEvent(messageStart('msg_10'))
        emitter.handleStreamEvent(blockStart(0, 'tool_use'))
        emitter.handleStreamEvent(blockDelta(0, 'input_json_delta', '{"a":1}'))
        emitter.handleStreamEvent(streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }))
        expect(sent).toEqual([])
        const markers = emitter.takeSettledMarkers(assistantComplete('msg_10', '') as never)
        expect(markers).toBeNull()
    })

    it('isStreamSnapshotMessage matches snapshots only', () => {
        expect(isStreamSnapshotMessage({ type: 'message', message: 'hi', id: 's1', live: true, streamSnapshot: true })).toBe(true)
        expect(isStreamSnapshotMessage({ type: 'reasoning', message: 'hm', id: 's2', live: true })).toBe(true)
        expect(isStreamSnapshotMessage({ type: 'assistant', message: { role: 'assistant' }, uuid: 'u1' })).toBe(false)
        expect(isStreamSnapshotMessage(null)).toBe(false)
        expect(isStreamSnapshotMessage({ type: 'message', message: 42, id: 's3' })).toBe(false)
    })
})
