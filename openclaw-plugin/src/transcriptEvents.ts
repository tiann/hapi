import { createHash } from 'node:crypto'
import type { HapiCallbackEvent } from './types'
import { parseHapiSessionKey, stripReplyToCurrentPrefix } from './sessionKeys'

type TranscriptTextContent = {
    type?: unknown
    text?: unknown
}

type TranscriptMessage = {
    role?: unknown
    content?: unknown
    timestamp?: unknown
    responseId?: unknown
}

type TranscriptUpdate = {
    sessionKey?: string
    messageId?: string
    message?: unknown
}

function buildTranscriptEventId(externalMessageId: string, createdAt: number, text: string): string {
    const digest = createHash('sha1')
        .update(`${externalMessageId}:${createdAt}:${text}`)
        .digest('hex')
        .slice(0, 12)
    return `message:${externalMessageId}:${digest}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractAssistantText(content: unknown): string | null {
    if (typeof content === 'string') {
        const normalized = stripReplyToCurrentPrefix(content)
        return normalized.length > 0 ? normalized : null
    }

    if (!Array.isArray(content)) {
        return null
    }

    const texts = content
        .flatMap((entry) => {
            if (!isRecord(entry)) {
                return []
            }

            const block = entry as TranscriptTextContent
            if (block.type !== 'text' || typeof block.text !== 'string') {
                return []
            }

            const normalized = stripReplyToCurrentPrefix(block.text)
            return normalized.length > 0 ? [normalized] : []
        })

    if (texts.length === 0) {
        return null
    }

    return texts.join('\n\n')
}

export function normalizeAssistantTranscriptEvent(update: TranscriptUpdate): Extract<HapiCallbackEvent, { type: 'message' }> | null {
    const parsed = parseHapiSessionKey(update.sessionKey)
    if (!parsed || !isRecord(update.message)) {
        return null
    }

    const message = update.message as TranscriptMessage
    if (message.role !== 'assistant') {
        return null
    }

    const text = extractAssistantText(message.content)
    if (!text) {
        return null
    }

    const externalMessageId = typeof update.messageId === 'string' && update.messageId.length > 0
        ? update.messageId
        : (typeof message.responseId === 'string' && message.responseId.length > 0 ? message.responseId : null)
    if (!externalMessageId) {
        return null
    }

    const createdAt = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Date.now()

    return {
        type: 'message',
        eventId: buildTranscriptEventId(externalMessageId, createdAt, text),
        occurredAt: createdAt,
        namespace: parsed.namespace,
        conversationId: update.sessionKey!,
        externalMessageId,
        role: 'assistant',
        content: {
            mode: 'replace',
            text
        },
        createdAt,
        status: 'completed'
    }
}
