import { useState } from 'react'
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

// Compaction summaries are long; keep them collapsed by default and let the
// chevron reveal the body on demand. Toggle state is intentionally local and
// non-persistent — revisiting a session collapses the card again.
export function CompactSummaryCard({ delta, text }: { delta: string | null; text: string }) {
    const [expanded, setExpanded] = useState(false)
    return (
        <div className="mx-auto max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center gap-1.5 text-left text-xs text-[var(--app-hint)]"
            >
                <span aria-hidden="true">📦</span>
                <span className="font-medium">Context compacted</span>
                {delta ? <span className="font-normal">· {delta}</span> : null}
                <MessageTimestamp className="text-[10px]" />
                <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    fill="none"
                    className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                >
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {expanded && text ? (
                <div className="max-h-96 overflow-y-auto pr-1">
                    <MarkdownRenderer standalone content={text} />
                </div>
            ) : null}
        </div>
    )
}

export function HappySystemMessage() {
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
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
                <CompactSummaryCard delta={delta} text={text} />
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(messageId)} className="scroll-mt-4 py-1">
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
