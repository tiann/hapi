import type { DecryptedMessage } from '@/types/api'
import { Button } from '@/components/ui/button'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

type RoleWrappedMessage = {
    role: string
    content: unknown
}

function isRoleWrappedMessage(value: unknown): value is RoleWrappedMessage {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

function getMessageInner(value: unknown): unknown {
    return isRoleWrappedMessage(value) ? value.content : value
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

function formatEventLabel(event: unknown): string {
    if (!isObject(event)) return 'Event'
    const type = event.type
    if (type === 'ready') return '✅ Ready for input'
    if (type === 'switch') {
        const mode = event.mode === 'local' ? 'local' : 'remote'
        return `🔄 Switched to ${mode}`
    }
    if (type === 'permission-mode-changed') {
        const mode = typeof event.mode === 'string' ? event.mode : 'default'
        return `🔐 Permission mode: ${mode}`
    }
    if (type === 'message') {
        return typeof event.message === 'string' ? event.message : 'Message'
    }

    try {
        return JSON.stringify(event)
    } catch {
        return 'Event'
    }
}

function formatToolUseSummary(toolUse: Record<string, unknown>): string {
    const name = typeof toolUse.name === 'string'
        ? toolUse.name
        : typeof toolUse.tool === 'string'
            ? toolUse.tool
            : 'Tool'

    const input = toolUse.input ?? toolUse.arguments ?? toolUse.args
    if (isObject(input)) {
        const filePath = typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string'
                ? input.path
                : null
        if (filePath) {
            return `🔧 ${name} ${filePath}`
        }
        if (typeof input.command === 'string') {
            return `🔧 ${name} ${truncate(input.command, 160)}`
        }
        if (typeof input.pattern === 'string') {
            return `🔧 ${name} ${input.pattern}`
        }
        const prompt = typeof input.description === 'string'
            ? input.description
            : typeof input.prompt === 'string'
                ? input.prompt
                : null
        if (prompt) {
            return `🔧 ${name} ${truncate(prompt, 160)}`
        }
    }

    return `🔧 ${name}`
}

function extractTextFromToolResult(resultContent: unknown): string | null {
    if (!resultContent) {
        return null
    }

    if (typeof resultContent === 'string') {
        return truncate(resultContent, 300)
    }

    if (Array.isArray(resultContent)) {
        const textBlocks = resultContent
            .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
            .map((block) => (block as Record<string, unknown>).text as string)
            .filter((text) => text.trim().length > 0)
        if (textBlocks.length > 0) {
            return truncate(textBlocks.join('\n'), 300)
        }
    }

    if (isObject(resultContent) && typeof resultContent.text === 'string') {
        return truncate(resultContent.text, 300)
    }

    try {
        return truncate(JSON.stringify(resultContent), 300)
    } catch {
        return null
    }
}

function formatToolResultSummary(toolResult: Record<string, unknown>): string {
    const isError = Boolean(toolResult.is_error ?? toolResult.isError)
    const status = isError ? '❌' : '✓'
    const resultContent = toolResult.content ?? toolResult.result ?? toolResult.output
    const extracted = extractTextFromToolResult(resultContent)
    return extracted ? `${status} Tool result: ${extracted}` : `${status} Tool result`
}

function extractTextFromBlock(block: unknown): string | null {
    if (!block) return null
    if (typeof block === 'string') return block
    if (!isObject(block)) return null

    const type = block.type

    if (type === 'text' && typeof block.text === 'string') {
        return block.text
    }

    if (type === 'event') {
        return formatEventLabel(block.data)
    }

    if (type === 'tool_use') {
        return formatToolUseSummary(block)
    }

    if (type === 'tool_result') {
        return formatToolResultSummary(block)
    }

    if (type === 'output') {
        return extractTextFromOutput(block.data)
    }

    return null
}

function extractTextFromOutput(data: unknown): string | null {
    if (!isObject(data)) {
        return null
    }

    const outputType = data.type

    if (outputType === 'summary' && typeof data.summary === 'string') {
        return `📝 ${data.summary}`
    }

    if (outputType === 'event') {
        const event = (data.data ?? data.event ?? data) as unknown
        return formatEventLabel(event)
    }

    if (outputType === 'assistant') {
        const message = isObject(data.message) ? data.message : null
        const assistantContent = (message?.content ?? null) as unknown

        if (typeof assistantContent === 'string') {
            return assistantContent
        }

        if (Array.isArray(assistantContent)) {
            const parts = assistantContent
                .map((block) => extractTextFromBlock(block))
                .filter((part): part is string => Boolean(part && part.trim().length > 0))
            if (parts.length > 0) {
                return parts.join('\n')
            }
        }

        return null
    }

    if (outputType === 'tool_use') {
        return formatToolUseSummary(data)
    }

    if (outputType === 'tool_result') {
        return formatToolResultSummary(data)
    }

    return null
}

function extractText(content: unknown): string {
    const inner = getMessageInner(content)
    if (inner === null || inner === undefined) return ''
    if (typeof inner === 'string') return inner

    const fromBlock = extractTextFromBlock(inner)
    if (fromBlock) {
        return fromBlock
    }

    if (Array.isArray(inner)) {
        const parts = inner
            .map((block) => extractTextFromBlock(block))
            .filter((part): part is string => Boolean(part && part.trim().length > 0))
        if (parts.length > 0) {
            return parts.join('\n')
        }
    }

    return ''
}

function getRoleEmoji(content: unknown): string {
    if (isRoleWrappedMessage(content)) {
        if (content.role === 'user') return '👤'
        if (content.role === 'assistant' || content.role === 'agent') return '🤖'
    }

    const inner = getMessageInner(content)
    if (isObject(inner) && inner.type === 'event') return '🟦'
    if (isObject(inner) && inner.type === 'tool_use') return '🔧'
    if (isObject(inner) && inner.type === 'tool_result') return '🔧'
    if (isObject(inner) && inner.type === 'output') {
        const data = inner.data
        if (isObject(data)) {
            if (data.type === 'assistant') return '🤖'
            if (data.type === 'tool_use' || data.type === 'tool_result') return '🔧'
            if (data.type === 'event') return '🟦'
            if (data.type === 'summary') return '📝'
        }
    }

    return '💬'
}

export function MessageList(props: {
    messages: DecryptedMessage[]
    hasMore: boolean
    isLoadingMore: boolean
    onLoadMore: () => void
}) {
    return (
        <div className="flex flex-col gap-2">
            {props.hasMore ? (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={props.onLoadMore}
                    disabled={props.isLoadingMore}
                >
                    Load older
                </Button>
            ) : null}

            <div className="flex flex-col gap-2">
                {props.messages.map((m) => {
                    const text = extractText(m.content)
                    return (
                        <div key={m.id} className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2">
                            <div className="flex items-start gap-2">
                                <div className="text-sm">{getRoleEmoji(m.content)}</div>
                                <div className="flex-1">
                                    {text ? (
                                        <div className="whitespace-pre-wrap text-sm">{text}</div>
                                    ) : (
                                        <pre className="whitespace-pre-wrap text-xs text-[var(--app-hint)]">
                                            {JSON.stringify(m.content, null, 2)}
                                        </pre>
                                    )}
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
