import { isObject } from '@hapi/protocol'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol/modes'
import type { SyncEvent } from '../sync/syncEngine'
import type { AttentionReason } from './notificationTypes'

type EventEnvelope = {
    type?: unknown
    data?: unknown
}

function extractEventEnvelope(message: unknown): EventEnvelope | null {
    const directEnvelope = extractContentEnvelope(message)
    if (directEnvelope) {
        return directEnvelope
    }

    if (!isObject(message)) {
        return null
    }

    return extractContentEnvelope(message.content)
}

function extractContentEnvelope(content: unknown): EventEnvelope | null {
    if (!isObject(content)) {
        return null
    }

    if (content.type === 'event') {
        return content as EventEnvelope
    }

    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE || content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (data && typeof data.type === 'string') {
            return { type: 'event', data }
        }
    }

    return null
}

function extractMessageContent(event: SyncEvent): unknown {
    if (event.type !== 'message-received') {
        return null
    }
    return event.message?.content
}

export function extractMessageEventType(event: SyncEvent): string | null {
    const envelope = extractEventEnvelope(extractMessageContent(event))
    if (!envelope) {
        return null
    }

    const data = isObject(envelope.data) ? envelope.data : null
    const eventType = data?.type
    return typeof eventType === 'string' ? eventType : null
}

export function extractAttentionReason(event: SyncEvent): AttentionReason | null {
    const eventType = extractMessageEventType(event)
    if (
        eventType === 'error'
        || eventType === 'failed'
        || eventType === 'task-failed'
        || eventType === 'task_failed'
    ) {
        return 'failed'
    }
    if (eventType === 'aborted' || eventType === 'interrupted' || eventType === 'turn_aborted') {
        return 'interrupted'
    }
    return null
}

export function isAgentMessageEvent(event: SyncEvent): boolean {
    const content = extractMessageContent(event)
    if (!isObject(content)) {
        return false
    }

    return content.role === 'agent'
}
