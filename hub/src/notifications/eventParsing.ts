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

/**
 * Extract text content from assistant message
 */
export function extractAssistantMessageText(event: SyncEvent): string | null {
    if (event.type !== 'message-received') {
        return null
    }

    const content = event.message?.content

    if (!isObject(content)) {
        return null
    }

    // Check if this is an assistant message
    const role = content.role

    if (role !== 'assistant' && role !== 'agent') {
        return null
    }

    // Extract text from content
    const messageContent = content.content
    if (!isObject(messageContent)) {
        return null
    }

    // Handle text content (from external sources like telegram-bot)
    if (messageContent.type === 'text' && typeof messageContent.text === 'string') {
        return messageContent.text
    }

    // Handle output content (from CLI/agent)
    if (messageContent.type === 'output') {
        const outputData = messageContent.data
        if (isObject(outputData)) {
            // Try to extract text from various output formats
            // Format 1: { type: 'text', text: '...' }
            if (outputData.type === 'text' && typeof outputData.text === 'string') {
                return outputData.text
            }
            // Format 2: { message: { content: [...] } }
            const message = outputData.message
            if (isObject(message) && Array.isArray(message.content)) {
                const texts: string[] = []
                for (const block of message.content) {
                    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
                        texts.push(block.text)
                    }
                }
                if (texts.length > 0) {
                    return texts.join('\n')
                }
            }
            // Format 3: Direct text in data
            if (typeof outputData.text === 'string') {
                return outputData.text
            }
            // Format 4: Look for content array directly in outputData
            if (Array.isArray(outputData.content)) {
                const texts: string[] = []
                for (const block of outputData.content) {
                    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
                        texts.push(block.text)
                    }
                }
                if (texts.length > 0) {
                    return texts.join('\n')
                }
            }
        }
    }

    // Handle content array (Claude format)
    if (Array.isArray(messageContent.content)) {
        const texts: string[] = []
        for (const block of messageContent.content) {
            if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
                texts.push(block.text)
            }
        }
        if (texts.length > 0) {
            return texts.join('\n')
        }
    }

    return null
}
