import type { SDKMessage } from '@/claude/sdk'
import { isObject } from '@hapi/protocol'

type TextBlock = { text: string; streamId: string; lastText: string; lastAt: number | null; settled: boolean }
type MessageStream = { id: string; blocks: Map<number, TextBlock> }

/** Convert text deltas to replaceable snapshots; tool and thinking events stay native. */
export class ClaudeTextStream {
    private readonly streams = new Map<string, MessageStream>()
    private compacting = false

    process(message: SDKMessage): SDKMessage | null {
        const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
        if (message.type === 'result') {
            this.streams.clear()
            this.compacting = false
        }
        if (message.type === 'system') {
            if (message.subtype === 'status') this.compacting = message.status === 'compacting'
            if (message.subtype === 'compact_boundary') this.compacting = false
        }
        if (message.type === 'assistant') return this.settle(message, parent)
        if (message.type !== 'stream_event') return message
        if (this.compacting) return null
        const event = isObject(message.event) ? message.event : null
        if (!event) return null
        if (event.type === 'message_start') {
            const id = isObject(event.message) ? event.message.id : null
            if (typeof id === 'string' && id) this.streams.set(parent, { id, blocks: new Map() })
            return null
        }
        const stream = this.streams.get(parent)
        if (!stream || !Number.isInteger(event.index)) return null
        const index = event.index as number
        if (event.type === 'content_block_start') {
            const content = isObject(event.content_block) ? event.content_block : null
            if (content?.type !== 'text') return null
            stream.blocks.set(index, {
                text: typeof content.text === 'string' ? content.text : '',
                streamId: `claude:${stream.id}:${parent}:${index}`,
                lastText: '', lastAt: null, settled: false
            })
        }
        const block = stream.blocks.get(index)
        if (!block || block.settled) return null
        if (event.type === 'content_block_delta') {
            const delta = isObject(event.delta) ? event.delta : null
            if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return null
            block.text += delta.text
        } else if (event.type !== 'content_block_start' && event.type !== 'content_block_stop') {
            return null
        }
        const now = Date.now()
        if (!block.text.trim() || block.text === block.lastText) return null
        if (event.type !== 'content_block_stop' && block.lastAt !== null && now - block.lastAt < 100) return null
        block.lastAt = now
        block.lastText = block.text
        return {
            type: 'assistant', parent_tool_use_id: parent || undefined,
            live: true, streamIds: [block.streamId],
            message: { role: 'assistant', content: [{ type: 'text', text: block.text, streamId: block.streamId }] }
        }
    }

    private settle(message: SDKMessage, parent: string): SDKMessage {
        if (message.isMeta === true || message.isCompactSummary === true) return message
        const body = isObject(message.message) ? message.message : null
        const stream = this.streams.get(parent)
        if (!body || !stream || body.id !== stream.id || !Array.isArray(body.content)) return message
        const blocks = [...stream.blocks.values()]
        const textCount = body.content.filter(block => isObject(block) && block.type === 'text').length
        // SDK versions emit either one completed block at a time or the complete message.
        const candidates = textCount === blocks.length ? blocks : blocks.filter(block => !block.settled)
        let textIndex = 0
        const streamIds: string[] = []
        const content = body.content.map(block => {
            if (!isObject(block) || block.type !== 'text') return block
            const streamed = candidates[textIndex++]
            if (!streamed) return block
            streamed.settled = true
            streamIds.push(streamed.streamId)
            return { ...block, streamId: streamed.streamId }
        })
        return streamIds.length ? { ...message, streamIds, message: { ...body, content } } : message
    }
}
