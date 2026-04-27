import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol'

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function hasHumanTextContent(content: unknown): boolean {
    if (typeof content === 'string') {
        return content.trim().length > 0
    }

    if (Array.isArray(content)) {
        return content.some((block) => {
            const record = asRecord(block)
            return record?.type === 'text'
                && typeof record.text === 'string'
                && record.text.trim().length > 0
        })
    }

    const record = asRecord(content)
    return record?.type === 'text'
        && typeof record.text === 'string'
        && record.text.trim().length > 0
}

function isReadyEventContent(content: unknown): boolean {
    const record = asRecord(content)
    if (record?.type !== 'event') {
        return false
    }

    const data = asRecord(record.data)
    return data?.type === 'ready'
}

export function shouldRecordSessionActivity(content: unknown): boolean {
    const message = unwrapRoleWrappedRecordEnvelope(content)
    if (!message) {
        return false
    }

    if (message.role === 'user') {
        return hasHumanTextContent(message.content)
    }

    if (message.role !== 'agent') {
        return false
    }

    return isReadyEventContent(message.content)
}
