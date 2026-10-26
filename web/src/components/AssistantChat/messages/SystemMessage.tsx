import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { CodeBlock } from '@/components/CodeBlock'
import { parseGoalStatusMessage } from '@/components/ToolCard/goalTools'
import { GoalSummary } from '@/components/ToolCard/views/GoalView'
import { useTranslation } from '@/lib/use-translation'

function formatTokenDelta(event: AgentEvent | undefined): string | null {
    if (!event || event.type !== 'compact-summary') return null
    const parts: string[] = []
    if (typeof event.tokensBefore === 'number') parts.push(event.tokensBefore.toLocaleString())
    if (typeof event.estimatedTokensAfter === 'number') parts.push(event.estimatedTokensAfter.toLocaleString())
    if (parts.length === 0) return null
    return parts.length === 2 ? `${parts[0]} → ${parts[1]} tokens` : `${parts[0]} tokens`
}

export function HappySystemMessage() {
    const { t } = useTranslation()
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const text = useAuiState((s) => {
        if (s.message.role !== 'system') return ''
        return s.message.content[0]?.type === 'text' ? s.message.content[0].text : ''
    })
    const event = useAuiState((s) => {
        if (s.message.role !== 'system') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'event' ? custom.event : undefined
    })
    const compactSummary = useAuiState((s) => {
        if (s.message.role !== 'system') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'compact-summary' ? custom.event : undefined
    })

    if (role !== 'system') return null

    const icon = event ? getEventPresentation(event).icon : null
    const goalMessage = event?.type === 'message' && typeof event.message === 'string' ? event.message : null
    const goal = goalMessage !== null ? parseGoalStatusMessage(goalMessage) : null
    if (goal && goalMessage !== null) {
        return (
            <MessagePrimitive.Root id={getConversationMessageAnchorId(messageId)} className="scroll-mt-4 py-1">
                <section aria-label={t('session.status.goal')} className="mx-auto max-w-[92%] rounded-[20px] bg-[var(--app-tool-card-bg)] p-3 text-left">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
                        <span>{t('session.status.goal')}</span>
                        <MessageTimestamp className="text-[10px] font-normal text-[var(--app-hint)]" />
                    </div>
                    <GoalSummary result={goal} surface="inline" />
                    <details className="mt-3 min-w-0 text-xs text-[var(--app-hint)]">
                        <summary className="cursor-pointer py-1">{t('tool.goal.raw')}</summary>
                        <CodeBlock code={goalMessage} language="json" />
                    </details>
                </section>
            </MessagePrimitive.Root>
        )
    }

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
