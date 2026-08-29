import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

function formatTokenDelta(event: AgentEvent | undefined): string | null {
    if (!event || event.type !== 'compact-summary') return null
    const parts: string[] = []
    if (typeof event.tokensBefore === 'number') parts.push(event.tokensBefore.toLocaleString())
    if (typeof event.estimatedTokensAfter === 'number') parts.push(event.estimatedTokensAfter.toLocaleString())
    if (parts.length === 0) return null
    return parts.length === 2 ? `${parts[0]} → ${parts[1]} tokens` : `${parts[0]} tokens`
}

export function HappySystemMessage() {
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const sourceMessageIds = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.sourceMessageIds
    })
    const text = useAuiState((s) => {
        if (s.message.role !== 'system') return ''
        return s.message.content[0]?.type === 'text' ? s.message.content[0].text : ''
    })
    const icon = useAuiState((s) => {
        if (s.message.role !== 'system') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        const event = custom?.kind === 'event' ? custom.event : undefined
        return event ? getEventPresentation(event).icon : null
    })
    const compactSummary = useAuiState((s) => {
        if (s.message.role !== 'system') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'compact-summary' ? custom.event : undefined
    })

    if (role !== 'system') return null

    // Pi compaction summaries are real content, not status: render them as an
    // independent block (header with token delta + the summary markdown)
    // instead of the tiny centered status line used for other events.
    if (compactSummary && compactSummary.type === 'compact-summary') {
        const delta = formatTokenDelta(compactSummary)
        return (
            <MessagePrimitive.Root id={getConversationMessageAnchorId(messageId)} className="scroll-mt-4 py-1">
                <div className="mx-auto max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                        <span aria-hidden="true">📦</span>
                        <span className="font-medium">Context compacted</span>
                        {delta ? <span className="font-normal">{delta}</span> : null}
                        <MessageTimestamp className="text-[10px]" />
                    </div>
                    {text ? (
                        <div className="max-h-96 overflow-y-auto pr-1">
                            <MarkdownRenderer standalone content={text} />
                        </div>
                    ) : null}
                </div>
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            data-hapi-source-message-ids={sourceMessageIds?.join(' ') || undefined}
            className="scroll-mt-4 py-1"
        >
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                    {icon ? <span aria-hidden="true">{icon}</span> : null}
                    <span>{text}</span>
                    <MessageTimestamp className="text-[10px]" />
                </span>
            </div>
        </MessagePrimitive.Root>
    )
}
