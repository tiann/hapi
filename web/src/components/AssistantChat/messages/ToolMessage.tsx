import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ChatBlock } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import type { MessageStatus } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'tool-call') return false
    if (typeof value.id !== 'string') return false
    if (!isObject(value.tool)) return false
    return true
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
    if (props.status !== 'failed') {
        return null
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-red-500">
                <ErrorIcon />
            </span>
            {props.onRetry ? (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-xs text-blue-500 hover:underline"
                >
                    重试
                </button>
            ) : null}
        </span>
    )
}

function formatUnixTimestamp(value: number): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
}

function renderEventLabel(event: AgentEvent): string {
    if (event.type === 'switch') {
        const mode = event.mode === 'local' ? 'local' : 'remote'
        return `🔄 Switched to ${mode}`
    }
    if (event.type === 'title-changed') {
        const title = typeof event.title === 'string' ? event.title : ''
        return title ? `Title changed to "${title}"` : 'Title changed'
    }
    if (event.type === 'permission-mode-changed') {
        const modeValue = (event as Record<string, unknown>).mode
        const mode = typeof modeValue === 'string' ? modeValue : 'default'
        return `🔐 Permission mode: ${mode}`
    }
    if (event.type === 'limit-reached') {
        const endsAt = typeof event.endsAt === 'number' ? event.endsAt : null
        return endsAt ? `⏳ Usage limit reached until ${formatUnixTimestamp(endsAt)}` : '⏳ Usage limit reached'
    }
    if (event.type === 'message') {
        return typeof event.message === 'string' ? event.message : 'Message'
    }
    try {
        return JSON.stringify(event)
    } catch {
        return String(event.type)
    }
}

function HappyNestedBlockList(props: {
    blocks: ChatBlock[]
}) {
    const ctx = useHappyChatContext()

    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    const userBubbleClass = 'w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'
                    const status = block.status
                    const canRetry = status === 'failed' && typeof block.localId === 'string' && Boolean(ctx.onRetryMessage)
                    const onRetry = canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined

                    return (
                        <div key={`user:${block.id}`} className={userBubbleClass}>
                            <div className="flex items-end gap-2">
                                <div className="flex-1">
                                    <LazyRainbowText text={block.text} />
                                </div>
                                {status ? (
                                    <div className="shrink-0 self-end pb-0.5">
                                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-text') {
                    return (
                        <div key={`agent:${block.id}`} className="px-1">
                            <MarkdownRenderer content={block.text} />
                        </div>
                    )
                }

                if (block.kind === 'agent-event') {
                    return (
                        <div key={`event:${block.id}`} className="py-1">
                            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                                {renderEventLabel(block.event)}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'tool-call') {
                    const isTask = block.tool.name === 'Task'

                    return (
                        <div key={`tool:${block.id}`} className="py-1">
                            <ToolCard
                                api={ctx.api}
                                sessionId={ctx.sessionId}
                                metadata={ctx.metadata}
                                disabled={ctx.disabled}
                                onDone={ctx.onRefresh}
                                block={block}
                            />
                            {block.children.length > 0 ? (
                                isTask ? (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                            Task details ({block.children.length})
                                        </summary>
                                        <div className="mt-2 pl-3">
                                            <HappyNestedBlockList blocks={block.children} />
                                        </div>
                                    </details>
                                ) : (
                                    <div className="mt-2 pl-3">
                                        <HappyNestedBlockList blocks={block.children} />
                                    </div>
                                )
                            ) : null}
                        </div>
                    )
                }

                return null
            })}
        </div>
    )
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
    const ctx = useHappyChatContext()
    const artifact = props.artifact

    if (!isToolCallBlock(artifact)) {
        return (
            <div className="py-1">
                <div className="text-xs text-[var(--app-hint)]">
                    Tool call: {props.toolName}
                </div>
            </div>
        )
    }

    const block = artifact
    const isTask = block.tool.name === 'Task'

    return (
        <div className="py-1">
            <ToolCard
                api={ctx.api}
                sessionId={ctx.sessionId}
                metadata={ctx.metadata}
                disabled={ctx.disabled}
                onDone={ctx.onRefresh}
                block={block}
            />
            {block.children.length > 0 ? (
                isTask ? (
                    <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                            Task details ({block.children.length})
                        </summary>
                        <div className="mt-2 pl-3">
                            <HappyNestedBlockList blocks={block.children} />
                        </div>
                    </details>
                ) : (
                    <div className="mt-2 pl-3">
                        <HappyNestedBlockList blocks={block.children} />
                    </div>
                )
            ) : null}
        </div>
    )
}
