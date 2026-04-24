import { isObject } from '@hapi/protocol'
import type { SyncEvent } from '../sync/syncEngine'

type EventEnvelope = {
    type?: unknown
    data?: unknown
}

function extractEventEnvelope(message: unknown): EventEnvelope | null {
    if (!isObject(message)) {
        return null
    }

    if (message.type === 'event') {
        return message as EventEnvelope
    }

    const content = message.content
    if (!isObject(content) || content.type !== 'event') {
        return null
    }

    return content as EventEnvelope
}

export function extractMessageEventType(event: SyncEvent): string | null {
    if (event.type !== 'message-received') {
        return null
    }

    const message = event.message?.content
    const envelope = extractEventEnvelope(message)
    if (!envelope) {
        return null
    }

    const data = isObject(envelope.data) ? envelope.data : null
    const eventType = data?.type
    return typeof eventType === 'string' ? eventType : null
}

export type TaskNotificationEvent = {
    summary: string
    status?: string
}

function extractTaskNotificationFromSystemOutput(message: unknown): TaskNotificationEvent | null {
    if (!isObject(message) || message.type !== 'output') {
        return null
    }

    const data = isObject(message.data) ? message.data : null
    if (!data || data.type !== 'system' || data.subtype !== 'task_notification') {
        return null
    }

    const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
    if (!summary) {
        return null
    }

    const status = typeof data.status === 'string' ? data.status.trim() : undefined
    return { summary, status }
}

function extractTaskNotificationFromUserOutput(message: unknown): TaskNotificationEvent | null {
    if (!isObject(message) || message.type !== 'output') {
        return null
    }

    const data = isObject(message.data) ? message.data : null
    if (!data || data.type !== 'user') {
        return null
    }

    const wrappedMessage = isObject(data.message) ? data.message : null
    const content = typeof data.content === 'string'
        ? data.content
        : wrappedMessage?.content
    if (typeof content !== 'string') {
        return null
    }

    const trimmed = content.trimStart()
    if (!trimmed.startsWith('<task-notification>')) {
        return null
    }

    const summary = trimmed.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
    if (!summary) {
        return null
    }

    const status = trimmed.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || undefined
    return { summary, status }
}

export function extractTaskNotification(event: SyncEvent): TaskNotificationEvent | null {
    if (event.type !== 'message-received') {
        return null
    }

    const message = event.message?.content
    if (!isObject(message)) {
        return null
    }

    const roleWrapped = isObject(message.content) ? message.content : null
    const candidates = roleWrapped ? [roleWrapped, message] : [message]
    for (const candidate of candidates) {
        const fromSystem = extractTaskNotificationFromSystemOutput(candidate)
        if (fromSystem) {
            return fromSystem
        }

        const fromUser = extractTaskNotificationFromUserOutput(candidate)
        if (fromUser) {
            return fromUser
        }
    }

    return null
}
