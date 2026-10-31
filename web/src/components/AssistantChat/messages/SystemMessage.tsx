import { useState } from 'react'
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

export function formatTokenDelta(event: AgentEvent | undefined): string | null {
    if (!event || event.type !== 'compact-summary') return null
    const token = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const before = token(event.tokensBefore)
    const after = token(event.tokensAfter)
    const estimatedAfter = after === undefined ? token(event.estimatedTokensAfter) : undefined
    if (before !== undefined && after !== undefined) return `${before.toLocaleString()} → ${after.toLocaleString()} tokens`
    if (before !== undefined && estimatedAfter !== undefined) return `${before.toLocaleString()} → ~${estimatedAfter.toLocaleString()} tokens (estimated after)`
    if (before !== undefined) return `${before.toLocaleString()} tokens before`
    if (after !== undefined) return `${after.toLocaleString()} tokens after`
    if (estimatedAfter !== undefined) return `~${estimatedAfter.toLocaleString()} tokens after (estimated)`
    return null
}

function SystemStatusLine({ icon, text }: { icon: string | null; text: string }) {
    return (
        <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
            <span className="inline-flex items-center gap-1">
                {icon ? <span aria-hidden="true">{icon}</span> : null}
                <span>{text}</span>
                <MessageTimestamp className="text-[10px]" />
            </span>
        </div>
    )
}

// Compaction summaries are long; keep them collapsed by default and let the
// chevron reveal the body on demand. Toggle state is intentionally local and
// non-persistent — revisiting a session collapses the card again.
export function CompactSummaryCard({ delta, text }: { delta: string | null; text: string }) {
    const [expanded, setExpanded] = useState(false)
    const hasSummary = text.trim().length > 0
    const Header = hasSummary ? 'button' : 'div'
    if (!hasSummary && !delta) return <SystemStatusLine icon="📦" text="Context compacted" />
    return (
        <div className="mx-auto max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
            <Header
                type={hasSummary ? 'button' : undefined}
                aria-expanded={hasSummary ? expanded : undefined}
                onClick={hasSummary ? () => setExpanded((v) => !v) : undefined}
                className="flex w-full items-center gap-1.5 text-left text-xs text-[var(--app-hint)]"
            >
                <span aria-hidden="true">📦</span>
                <span className="font-medium">Context compacted</span>
                {delta ? <span className="font-normal">· {delta}</span> : null}
                <MessageTimestamp className="text-[10px]" />
                {hasSummary ? <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    fill="none"
                    className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                >
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg> : null}
            </Header>
            {hasSummary && expanded ? (
                <div className="max-h-96 overflow-y-auto pr-1">
                    <MarkdownRenderer standalone content={text} />
                </div>
            ) : null}
        </div>
    )
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

    // Available summary/token facts determine the presentation. A boundary
    // without either remains an ordinary status line.
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
            <SystemStatusLine icon={icon} text={text} />
        </MessagePrimitive.Root>
    )
}
