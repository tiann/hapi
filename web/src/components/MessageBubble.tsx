import type { ReactNode } from 'react'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

/**
 * Converts snake_case string to Title Case with spaces.
 * Example: "create_issue" -> "Create Issue"
 */
function snakeToTitleWithSpaces(value: string): string {
    return value
        .split('_')
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ')
}

/**
 * Formats MCP tool names for display.
 * Example: "mcp__linear__create_issue" -> "MCP: Linear Create Issue"
 */
function formatMCPTitle(toolName: string): string {
    const withoutPrefix = toolName.replace(/^mcp__/, '')
    const parts = withoutPrefix.split('__')
    if (parts.length >= 2) {
        const serverName = snakeToTitleWithSpaces(parts[0])
        const toolPart = snakeToTitleWithSpaces(parts.slice(1).join('_'))
        return `MCP: ${serverName} ${toolPart}`
    }
    return `MCP: ${snakeToTitleWithSpaces(withoutPrefix)}`
}

function formatToolTitle(toolName: string): string {
    if (toolName.startsWith('mcp__')) {
        return formatMCPTitle(toolName)
    }
    return toolName
}

type RoleWrappedMessage = {
    role: string
    content: unknown
}

function isRoleWrappedMessage(value: unknown): value is RoleWrappedMessage {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

function unwrapRoleWrappedMessageEnvelope(value: unknown): RoleWrappedMessage | null {
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedMessage(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedMessage(data.message)) return data.message

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedMessage(payload.message)) return payload.message

    return null
}

function normalizeMessageContent(value: unknown): { role: string | null; inner: unknown } {
    if (isRoleWrappedMessage(value)) {
        return { role: value.role, inner: value.content }
    }
    const unwrapped = unwrapRoleWrappedMessageEnvelope(value)
    if (unwrapped) {
        return { role: unwrapped.role, inner: unwrapped.content }
    }
    return { role: null, inner: value }
}

function renderRoleWrappedMessageContent(message: RoleWrappedMessage): ReactNode {
    const content = message.content
    if (typeof content === 'string') {
        return <MarkdownRenderer content={content} />
    }

    if (Array.isArray(content)) {
        return (
            <div className="flex flex-col gap-3">
                {content.map((block, idx) => (
                    <div key={idx}>
                        {renderBlock(block)}
                    </div>
                ))}
            </div>
        )
    }

    if (content) {
        return renderBlock(content)
    }

    return (
        <div className="text-xs text-[var(--app-hint)]">
            {message.role}
        </div>
    )
}

function formatEventLabel(event: unknown): string {
    if (!isObject(event)) return 'Event'
    const type = event.type
    if (type === 'ready') return 'ready'
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

function parseToolUseError(message: string): { isToolUseError: boolean; errorMessage: string | null } {
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s
    const match = message.match(regex)

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: typeof match[1] === 'string' ? match[1].trim() : ''
        }
    }

    return {
        isToolUseError: false,
        errorMessage: null
    }
}

function parseClaudeUsageLimit(text: string): number | null {
    const match = text.match(/^Claude AI usage limit reached\|(\d+)$/)
    if (!match) return null
    const timestamp = Number.parseInt(match[1], 10)
    if (!Number.isFinite(timestamp)) return null
    return timestamp
}

function formatUnixTimestamp(value: number): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
}

function getToolName(value: Record<string, unknown>): string {
    if (typeof value.name === 'string') return value.name
    if (typeof value.tool === 'string') return value.tool
    if (typeof value.toolName === 'string') return value.toolName
    return 'Tool'
}

function isExitPlanModeTool(name: string): boolean {
    return name === 'ExitPlanMode' || name === 'exit_plan_mode'
}

function extractPlanFromInput(input: unknown): string | null {
    if (!isObject(input)) return null
    const plan = input.plan
    return typeof plan === 'string' ? plan : null
}

function getToolInput(value: Record<string, unknown>): unknown {
    return value.input ?? value.arguments ?? value.args ?? value.params ?? null
}

function isToolUseLike(value: Record<string, unknown>): boolean {
    const type = value.type
    if (type === 'tool_use' || type === 'toolUse' || type === 'tool_call') return true
    if (typeof value.name === 'string' || typeof value.tool === 'string') {
        return 'input' in value || 'arguments' in value || 'args' in value || 'params' in value
    }
    return false
}

function isToolResultLike(value: Record<string, unknown>): boolean {
    const type = value.type
    if (type === 'tool_result' || type === 'toolResult') return true
    const hasResult = 'content' in value || 'result' in value || 'output' in value
    const hasErrorFlag = 'is_error' in value || 'isError' in value
    return Boolean(hasResult && hasErrorFlag)
}

function getToolResultContent(value: Record<string, unknown>): unknown {
    return value.content ?? value.result ?? value.output ?? null
}

function extractTextFromToolResult(resultContent: unknown): string | null {
    if (resultContent === null || resultContent === undefined) {
        return null
    }

    if (typeof resultContent === 'string') {
        return resultContent
    }

    if (Array.isArray(resultContent)) {
        const textBlocks = resultContent
            .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
            .map((block) => (block as Record<string, unknown>).text as string)
            .filter((text) => text.trim().length > 0)

        if (textBlocks.length > 0) {
            return textBlocks.join('\n')
        }
    }

    if (isObject(resultContent) && typeof resultContent.text === 'string') {
        return resultContent.text
    }

    return null
}

function generateOutputSummary(text: string): string {
    const lines = text.split('\n').length
    const chars = text.length
    if (chars >= 1024) {
        return `${lines} lines, ${(chars / 1024).toFixed(1)}KB`
    }
    return `${lines} lines`
}

function getInputString(input: unknown, key: string): string | null {
    if (!isObject(input)) return null
    const value = input[key]
    return typeof value === 'string' ? value : null
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    for (const key of keys) {
        const value = getInputString(input, key)
        if (value) return value
    }
    return null
}

function tryParseJsonString(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed) return value
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return value
    }
}

function ToolUseView(props: { toolName: string; input: unknown }) {
    const normalizedInput = tryParseJsonString(props.input)
    const filePath = getInputStringAny(normalizedInput, ['file_path', 'path', 'filePath', 'file'])
    const command = getInputStringAny(normalizedInput, ['command', 'cmd'])
    const pattern = getInputStringAny(normalizedInput, ['pattern'])
    const url = getInputStringAny(normalizedInput, ['url'])
    const prompt = getInputStringAny(normalizedInput, ['description', 'prompt'])

    const title = formatToolTitle(props.toolName)

    // Generate compact title suffix
    const titleSuffix = filePath
        ? `: ${filePath.split('/').pop() ?? filePath}`
        : command
            ? `: ${truncate(command.split('\n')[0], 40)}`
            : pattern
                ? `: ${truncate(pattern, 40)}`
                : url
                    ? `: ${truncate(url, 40)}`
                    : ''

    // Check if there's any detail to show (use explicit null/undefined checks for falsy values like 0, "", false)
    const hasDetails = filePath !== null || command !== null || pattern !== null || url !== null || prompt !== null || (normalizedInput !== null && normalizedInput !== undefined)

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-1 text-left text-xs font-medium text-[var(--app-hint)] hover:underline"
                >
                    🔧 {title}{titleSuffix}
                </button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>🔧 {title}</DialogTitle>
                </DialogHeader>
                <div className="mt-3 flex max-h-[60vh] flex-col gap-3 overflow-auto">
                    {filePath && (
                        <div className="text-sm">
                            <span className="text-[var(--app-hint)]">File:</span>{' '}
                            <span className="font-mono break-all">{filePath}</span>
                        </div>
                    )}
                    {pattern && (
                        <div className="text-sm">
                            <span className="text-[var(--app-hint)]">Pattern:</span>{' '}
                            <span className="font-mono break-all">{pattern}</span>
                        </div>
                    )}
                    {url && (
                        <div className="text-sm">
                            <span className="text-[var(--app-hint)]">URL:</span>{' '}
                            <span className="font-mono break-all">{url}</span>
                        </div>
                    )}
                    {prompt && (
                        <div className="whitespace-pre-wrap break-words text-sm">
                            {prompt}
                        </div>
                    )}
                    {command && (
                        <CodeBlock code={command} language="bash" />
                    )}
                    {normalizedInput !== null && normalizedInput !== undefined && !filePath && !command && !pattern && !url && !prompt && (
                        <CodeBlock code={safeStringify(normalizedInput)} language="json" />
                    )}
                    {!hasDetails && (
                        <div className="text-sm text-[var(--app-hint)]">(no arguments)</div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function ToolResultView(props: { isError: boolean; content: unknown }) {
    const text = extractTextFromToolResult(props.content)
    const toolUseError = text !== null ? parseToolUseError(text) : null
    const toolUseErrorText = toolUseError?.isToolUseError ? (toolUseError.errorMessage ?? '') : null

    const displayText = toolUseError?.isToolUseError ? toolUseErrorText : text
    const summary = displayText !== null ? generateOutputSummary(displayText) : null

    const header = toolUseError?.isToolUseError
        ? '⛔ Tool rejected'
        : props.isError
            ? '❌ Tool error'
            : '✓ Tool result'
    const hasContent = props.content !== null && props.content !== undefined

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-1 text-left text-xs font-medium text-[var(--app-hint)] hover:underline"
                >
                    {header}
                    {summary !== null && <span>({summary})</span>}
                </button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{header}</DialogTitle>
                </DialogHeader>
                <div className="mt-3 max-h-[60vh] overflow-auto">
                    {displayText !== null ? (
                        <CodeBlock code={displayText} language="text" />
                    ) : hasContent ? (
                        <CodeBlock code={safeStringify(props.content)} language="json" />
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function ThinkingView(props: { thinking: string }) {
    const preview = truncate(props.thinking.split('\n')[0], 50)

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-1 text-left text-xs font-medium text-[var(--app-hint)] hover:underline"
                >
                    💭 Thinking: {preview}
                </button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>💭 Thinking</DialogTitle>
                </DialogHeader>
                <div className="mt-3 max-h-[60vh] overflow-auto">
                    <div className="whitespace-pre-wrap break-words text-sm">
                        {props.thinking}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}

function ExitPlanModeView(props: { input: unknown }) {
    const plan = extractPlanFromInput(props.input)

    if (!plan) {
        return (
            <div className="text-xs text-[var(--app-hint)]">
                📋 Plan proposal (empty)
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-[var(--app-hint)]">
                📋 Plan Proposal
            </div>
            <MarkdownRenderer content={plan} />
        </div>
    )
}

function renderOutputData(data: unknown): ReactNode {
    if (!isObject(data)) {
        return <CodeBlock code={safeStringify(data)} language="json" />
    }

    if (isRoleWrappedMessage(data)) {
        return renderRoleWrappedMessageContent(data)
    }

    const embeddedMessage = unwrapRoleWrappedMessageEnvelope(data)
    if (embeddedMessage) {
        return renderRoleWrappedMessageContent(embeddedMessage)
    }

    const outputType = data.type

    if (outputType === 'summary' && typeof data.summary === 'string') {
        return (
            <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                📝 {data.summary}
            </div>
        )
    }

    if (outputType === 'thinking' && typeof data.thinking === 'string') {
        return <ThinkingView thinking={data.thinking} />
    }

    if (outputType === 'event') {
        const event = (data.data ?? data.event ?? data) as unknown
        if (isObject(event) && event.type === 'ready') {
            return null
        }
        return (
            <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                {formatEventLabel(event)}
            </div>
        )
    }

    if (outputType === 'assistant') {
        const message = isObject(data.message) ? data.message : null
        const assistantContent = (message?.content ?? null) as unknown

        if (typeof assistantContent === 'string') {
            return <MarkdownRenderer content={assistantContent} />
        }

        if (Array.isArray(assistantContent)) {
            return (
                <div className="flex flex-col gap-3">
                    {assistantContent.map((block, idx) => (
                        <div key={idx}>
                            {renderBlock(block)}
                        </div>
                    ))}
                </div>
            )
        }

        if (assistantContent) {
            return renderBlock(assistantContent)
        }

        return (
            <div className="text-xs text-[var(--app-hint)]">
                Assistant
            </div>
        )
    }

    if (outputType === 'tool_use') {
        const name = getToolName(data)
        const input = getToolInput(data)
        if (name === 'mcp__happy__change_title' && isObject(input) && typeof input.title === 'string') {
            return (
                <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                    Title changed to &quot;{input.title}&quot;
                </div>
            )
        }
        // Special handling for ExitPlanMode - show plan content directly
        if (isExitPlanModeTool(name)) {
            return <ExitPlanModeView input={input} />
        }
        return <ToolUseView toolName={name} input={input} />
    }

    if (outputType === 'tool_result') {
        const isError = Boolean(data.is_error ?? data.isError)
        const content = getToolResultContent(data)
        return <ToolResultView isError={isError} content={content} />
    }

    return <CodeBlock code={safeStringify(data)} language="json" />
}

function renderBlock(block: unknown): ReactNode {
    if (typeof block === 'string') {
        const parsed = tryParseJsonString(block)
        if (parsed !== block) {
            return renderBlock(parsed)
        }
        const usageLimit = parseClaudeUsageLimit(block)
        if (usageLimit !== null) {
            return (
                <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                    ⏳ Usage limit reached until {formatUnixTimestamp(usageLimit)}
                </div>
            )
        }
        return <MarkdownRenderer content={block} />
    }

    if (Array.isArray(block)) {
        return (
            <div className="flex flex-col gap-3">
                {block.map((item, idx) => (
                    <div key={idx}>
                        {renderBlock(item)}
                    </div>
                ))}
            </div>
        )
    }

    if (!isObject(block)) {
        return (
            <pre className="text-xs whitespace-pre-wrap break-words">
                {String(block)}
            </pre>
        )
    }

    if (isRoleWrappedMessage(block.message)) {
        return renderBlock(block.message.content)
    }

    const type = block.type

    if (type === 'text' && typeof block.text === 'string') {
        const usageLimit = parseClaudeUsageLimit(block.text)
        if (usageLimit !== null) {
            return (
                <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                    ⏳ Usage limit reached until {formatUnixTimestamp(usageLimit)}
                </div>
            )
        }
        return <MarkdownRenderer content={block.text} />
    }

    if (type === 'thinking' && typeof block.thinking === 'string') {
        return <ThinkingView thinking={block.thinking} />
    }

    if (type === 'event') {
        if (isObject(block.data) && block.data.type === 'ready') {
            return null
        }
        return (
            <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                {formatEventLabel(block.data)}
            </div>
        )
    }

    if (type === 'output') {
        return renderOutputData(block.data)
    }

    if (type === 'tool_use') {
        const name = getToolName(block)
        const input = getToolInput(block)
        if (name === 'mcp__happy__change_title' && isObject(input) && typeof input.title === 'string') {
            return (
                <div className="mx-auto w-fit rounded-full bg-[var(--app-subtle-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
                    Title changed to &quot;{input.title}&quot;
                </div>
            )
        }
        // Special handling for ExitPlanMode - show plan content directly
        if (isExitPlanModeTool(name)) {
            return <ExitPlanModeView input={input} />
        }
        return <ToolUseView toolName={name} input={input} />
    }

    if (type === 'tool_result') {
        const isError = Boolean(block.is_error ?? block.isError)
        const content = getToolResultContent(block)
        return <ToolResultView isError={isError} content={content} />
    }

    if (isToolUseLike(block)) {
        const name = getToolName(block)
        const input = getToolInput(block)
        // Special handling for ExitPlanMode - show plan content directly
        if (isExitPlanModeTool(name)) {
            return <ExitPlanModeView input={input} />
        }
        return <ToolUseView toolName={name} input={input} />
    }

    if (isToolResultLike(block)) {
        const isError = Boolean(block.is_error ?? block.isError)
        const content = getToolResultContent(block)
        return <ToolResultView isError={isError} content={content} />
    }

    return (
        <CodeBlock code={safeStringify(block)} language="json" />
    )
}

function safeStringify(value: unknown): string {
    try {
        const result = JSON.stringify(value, null, 2)
        return typeof result === 'string' ? result : String(value)
    } catch {
        return String(value)
    }
}

function ErrorIcon() {
    return (
        <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function MessageStatusIndicator(props: {
    status?: MessageStatus
    onRetry?: () => void
}) {
    // Only show indicator for failed status
    if (props.status !== 'failed') {
        return null
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-red-500">
                <ErrorIcon />
            </span>
            {props.onRetry && (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-xs text-blue-500 hover:underline"
                >
                    重试
                </button>
            )}
        </span>
    )
}

export function MessageBubble(props: {
    message: DecryptedMessage
    onRetry?: () => void
}) {
    const normalized = normalizeMessageContent(props.message.content)
    const role = normalized.role
    const inner = normalized.inner

    const isUser = role === 'user'

    // Events render centered without bubble
    if (isObject(inner) && inner.type === 'event') {
        if (isObject(inner.data) && inner.data.type === 'ready') {
            return null
        }
        return (
            <div className="py-1">
                {renderBlock(inner)}
            </div>
        )
    }

    // User messages: bubble styling (right-aligned, secondary background like happy-app)
    if (isUser) {
        const userBubbleClass = 'w-fit max-w-[96%] ml-auto rounded-2xl px-3 py-2 bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
        const status = props.message.status

        if (Array.isArray(inner)) {
            return (
                <div className={userBubbleClass}>
                    <div className="flex flex-col gap-3">
                        {inner.map((block, idx) => (
                            <div key={idx}>
                                {renderBlock(block)}
                            </div>
                        ))}
                    </div>
                    {status && (
                        <div className="mt-0.5 flex justify-end">
                            <MessageStatusIndicator status={status} onRetry={props.onRetry} />
                        </div>
                    )}
                </div>
            )
        }

        if (isObject(inner)) {
            return (
                <div className={userBubbleClass}>
                    {renderBlock(inner)}
                    {status && (
                        <div className="mt-0.5 flex justify-end">
                            <MessageStatusIndicator status={status} onRetry={props.onRetry} />
                        </div>
                    )}
                </div>
            )
        }

        return (
            <div className={userBubbleClass}>
                <div className="flex items-end gap-2">
                    <div className="flex-1">
                        {renderBlock(typeof inner === 'string' ? inner : safeStringify(inner))}
                    </div>
                    {status && (
                        <div className="shrink-0 self-end pb-0.5">
                            <MessageStatusIndicator status={status} onRetry={props.onRetry} />
                        </div>
                    )}
                </div>
            </div>
        )
    }

    // Agent messages: no bubble, full width
    if (Array.isArray(inner)) {
        return (
            <div className="flex flex-col gap-2">
                {inner.map((block, idx) => (
                    <div key={idx}>
                        {renderBlock(block)}
                    </div>
                ))}
            </div>
        )
    }

    if (isObject(inner)) {
        return renderBlock(inner)
    }

    return renderBlock(typeof inner === 'string' ? inner : safeStringify(inner))
}
