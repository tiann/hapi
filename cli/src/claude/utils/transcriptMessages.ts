import type { RawJSONLines } from '@/claude/types'

const SYSTEM_INJECTION_PREFIXES = ['<task-notification>', '<command-name>', '<local-command-caveat>', '<system-reminder>']

export function extractRawUserTextContent(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null

    const parts = content
        .map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return null
            const record = block as Record<string, unknown>
            return record.type === 'text' && typeof record.text === 'string' ? record.text : null
        })
        .filter((text): text is string => text !== null)

    return parts.length > 0 ? parts.join('\n') : null
}

export function isExternalUserMessage(body: RawJSONLines): body is Extract<RawJSONLines, { type: 'user' }> {
    if (body.type !== 'user') return false
    const message = (body as { message?: { content?: unknown } }).message
    if (!message || typeof message !== 'object') return false
    const text = extractRawUserTextContent(message.content)
    if (text === null || body.isSidechain === true || body.isMeta === true) return false

    const trimmed = text.trimStart()
    return !SYSTEM_INJECTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}
