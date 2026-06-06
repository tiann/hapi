import { safeStringify } from '@hapi/protocol'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { renderEventLabel } from '@/chat/presentation'
import type { NormalizedAgentContent, NormalizedMessage } from '@/chat/types'
import type { HapiSessionExport } from '@/types/api'

function getSessionTitle(payload: HapiSessionExport): string {
    const metadata = payload.session.metadata
    if (metadata?.name) return metadata.name
    if (metadata?.summary?.text) return metadata.summary.text
    if (metadata?.path) {
        const parts = metadata.path.split('/').filter(Boolean)
        return parts.at(-1) ?? metadata.path
    }
    return payload.session.id.slice(0, 8)
}

function escapeYamlString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
}

function formatTimestamp(value: number): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function formatFrontMatter(payload: HapiSessionExport, title: string): string {
    const metadata = payload.session.metadata
    const lines = [
        '---',
        `title: "${escapeYamlString(title)}"`,
        `sessionId: "${escapeYamlString(payload.session.id)}"`,
        `exportedAt: "${formatTimestamp(payload.exportedAt)}"`,
        `messageCount: ${payload.messages.length}`
    ]
    if (metadata?.path) {
        lines.push(`path: "${escapeYamlString(metadata.path)}"`)
    }
    if (metadata?.host) {
        lines.push(`host: "${escapeYamlString(metadata.host)}"`)
    }
    if (metadata?.flavor) {
        lines.push(`agent: "${escapeYamlString(metadata.flavor)}"`)
    }
    lines.push('---')
    return lines.join('\n')
}

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength - 1)}…`
}

function formatToolInput(input: unknown): string {
    if (input == null) return ''
    const text = safeStringify(input).trim()
    return text ? ` — ${truncate(text.replace(/\s+/g, ' '), 160)}` : ''
}

function formatAgentContentBlock(block: NormalizedAgentContent): string | null {
    switch (block.type) {
        case 'text':
            return block.text
        case 'reasoning':
            return `> Reasoning: ${block.text}`
        case 'tool-call':
            return `- Tool: ${block.name}${formatToolInput(block.input)}`
        case 'tool-result': {
            const label = block.is_error ? 'Tool error' : 'Tool result'
            const content = safeStringify(block.content).trim()
            return content ? `- ${label}: ${truncate(content.replace(/\s+/g, ' '), 240)}` : `- ${label}`
        }
        case 'generated-image':
            return `- Generated image: ${block.fileName}`
        case 'codex-review':
            return `- Codex review: ${block.review.overallCorrectness ?? 'review'} (${block.review.findings.length} findings)`
        case 'summary':
            return `> Summary: ${block.summary}`
        case 'sidechain':
            return null
        default: {
            const _exhaustive: never = block
            return safeStringify(_exhaustive)
        }
    }
}

function formatNormalizedMessage(message: NormalizedMessage): string | null {
    const timestamp = formatTimestamp(message.createdAt)
    if (message.role === 'user') {
        const attachments = message.content.attachments?.length
            ? `\n\n${message.content.attachments.map((attachment) => `- Attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`).join('\n')}`
            : ''
        return `## User\n\n_Time: ${timestamp}_\n\n${message.content.text}${attachments}`
    }

    if (message.role === 'event') {
        return `## Event\n\n_Time: ${timestamp}_\n\n${renderEventLabel(message.content)}`
    }

    const parts = message.content
        .map(formatAgentContentBlock)
        .filter((part): part is string => Boolean(part && part.trim()))

    if (parts.length === 0) {
        return null
    }

    return `## Assistant\n\n_Time: ${timestamp}_\n\n${parts.join('\n\n')}`
}

export function serializeSessionMarkdown(payload: HapiSessionExport): string {
    const title = getSessionTitle(payload)
    const sections: string[] = [
        formatFrontMatter(payload, title),
        `# ${title}`,
        `Session: \`${payload.session.id}\``,
        `Exported: ${formatTimestamp(payload.exportedAt)}`
    ]

    for (const message of payload.messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized) continue
        const section = formatNormalizedMessage(normalized)
        if (section) sections.push(section)
    }

    return `${sections.join('\n\n')}\n`
}
