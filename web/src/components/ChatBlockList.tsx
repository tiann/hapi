import type { ChatBlock } from '@/chat/types'
import type { MessageStatus } from '@/types/api'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ToolCard } from '@/components/ToolCard/ToolCard'

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

function renderEventLabel(event: ChatBlock & { kind: 'agent-event' }): string {
    const data = event.event as { type: string; [key: string]: unknown }
    if (data.type === 'switch') {
        const mode = data.mode === 'local' ? 'local' : 'remote'
        return `🔄 Switched to ${mode}`
    }
    if (data.type === 'title-changed') {
        const title = typeof data.title === 'string' ? data.title : ''
        return title ? `Title changed to "${title}"` : 'Title changed'
    }
    if (data.type === 'permission-mode-changed') {
        const mode = typeof data.mode === 'string' ? data.mode : 'default'
        return `🔐 Permission mode: ${mode}`
    }
    if (data.type === 'limit-reached') {
        const endsAt = typeof data.endsAt === 'number' ? data.endsAt : null
        return endsAt ? `⏳ Usage limit reached until ${formatUnixTimestamp(endsAt)}` : '⏳ Usage limit reached'
    }
    if (data.type === 'message') {
        return typeof data.message === 'string' ? data.message : 'Message'
    }
    try {
        return JSON.stringify(data)
    } catch {
        return 'Event'
    }
}

export function ChatBlockList(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    blocks: ChatBlock[]
    onRetryMessage?: (localId: string) => void
}) {
    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    const userBubbleClass = 'w-fit max-w-[92%] ml-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'
                    const status = block.status
                    const onRetry = block.localId && status === 'failed' && props.onRetryMessage
                        ? () => props.onRetryMessage!(block.localId!)
                        : undefined

                    return (
                        <div key={`user:${block.id}`} className={userBubbleClass}>
                            <div className="flex items-end gap-2">
                                <div className="flex-1">
                                    <MarkdownRenderer content={block.text} />
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
                                {renderEventLabel(block)}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'tool-call') {
                    const isTask = block.tool.name === 'Task'
                    return (
                        <div key={`tool:${block.id}`} className="py-1">
                            <ToolCard
                                api={props.api}
                                sessionId={props.sessionId}
                                metadata={props.metadata}
                                disabled={props.disabled}
                                onDone={props.onRefresh}
                                block={block}
                            />
                            {block.children.length > 0 ? (
                                isTask ? (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                            Task details ({block.children.length})
                                        </summary>
                                        <div className="mt-2 border-l border-[var(--app-border)] pl-3">
                                            <ChatBlockList
                                                api={props.api}
                                                sessionId={props.sessionId}
                                                metadata={props.metadata}
                                                disabled={props.disabled}
                                                onRefresh={props.onRefresh}
                                                blocks={block.children}
                                                onRetryMessage={props.onRetryMessage}
                                            />
                                        </div>
                                    </details>
                                ) : (
                                    <div className="mt-2 border-l border-[var(--app-border)] pl-3">
                                        <ChatBlockList
                                            api={props.api}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            disabled={props.disabled}
                                            onRefresh={props.onRefresh}
                                            blocks={block.children}
                                            onRetryMessage={props.onRetryMessage}
                                        />
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
