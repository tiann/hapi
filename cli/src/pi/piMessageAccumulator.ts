import type { AgentMessage } from '@/agent/types'
import type { PiAgentEvent, PiAssistantMessageEvent } from './types'
import { PiAssistantMessageEventSchema } from './schemas'

/**
 * Accumulates Pi assistant-message text/thinking deltas into a single
 * snapshot, flushed on `message_end` (with a `turn_end` safety net).
 *
 * Without this, every delta would become a separate hub message, and
 * the web's reducer would render the last delta as the whole reasoning
 * block (the per-message content-array dedup by streamId would only
 * see one snapshot) while stacking every text delta as a new agent-text
 * block, producing a character-by-character column.
 *
 * Mirrors codex's `ReasoningProcessor`: accumulate deltas locally,
 * emit one reasoning + one text message per assistant message.
 */
export class PiMessageAccumulator {
    private active = false
    private text = ''
    private reasoning = ''
    private streamId = 'pi-stream'

    /**
     * Apply a Pi event to the accumulator.
     *
     * @returns AgentMessages to forward to the hub, if this event
     *   represents a flush point (`message_end` or `turn_end` with
     *   pending content). Returns an empty array otherwise.
     */
    handleEvent(event: PiAgentEvent): AgentMessage[] {
        if (event.type === 'message_start') {
            this.active = true
            this.text = ''
            this.reasoning = ''
            this.streamId = 'pi-stream'
            return []
        }

        if (event.type === 'message_update') {
            const updateEvent = event as { assistantMessageEvent?: PiAssistantMessageEvent }
            const rawAme = updateEvent.assistantMessageEvent
            if (!rawAme) return []
            const ameResult = PiAssistantMessageEventSchema.safeParse(rawAme)
            if (!ameResult.success) return []
            const ame = ameResult.data
            const streamId = ame.contentIndex?.toString() ?? 'pi-stream'
            this.streamId = streamId
            if (ame.type === 'text_delta' && ame.delta) {
                this.text += ame.delta
            } else if (ame.type === 'thinking_delta' && ame.delta) {
                this.reasoning += ame.delta
            }
            // Other assistant message events (text_start/thinking_start/
            // text_end/thinking_end) carry the full partial state — we
            // already have the deltas, so we ignore them.
            return []
        }

        if (event.type === 'message_end') {
            if (this.active) return this.flush()
            return []
        }

        // Safety net: turn_end with pending content means the assistant
        // message ended without a clean `message_end` (older Pi builds,
        // partial streams, or a stream that crashed mid-flight).
        if (event.type === 'turn_end' && this.active) {
            return this.flush()
        }

        return []
    }

    private flush(): AgentMessage[] {
        const streamId = this.streamId
        const reasoning = this.reasoning
        const text = this.text
        this.active = false
        this.text = ''
        this.reasoning = ''
        this.streamId = 'pi-stream'

        const out: AgentMessage[] = []
        // Reasoning comes before text in the Pi event sequence, so emit
        // in that order. Empty content is dropped so the web doesn't
        // render empty bubbles.
        if (reasoning) {
            out.push({ type: 'reasoning', text: reasoning, id: streamId })
        }
        if (text) {
            out.push({ type: 'text', text })
        }
        return out
    }
}
