/**
 * TraceSection — shows child tool calls inside a Task/Agent tool dialog.
 * Placed between Input and Result sections.
 */
import { useState } from 'react'
import { isObject, safeStringify } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { getToolFullViewComponent } from '@/components/ToolCard/views/_all'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { formatTaskChildLabel, TaskStateIcon } from '@/components/ToolCard/helpers'
import { CodeBlock } from '@/components/CodeBlock'
import { useTranslation } from '@/lib/use-translation'
import { isSubagentToolName } from '@/chat/subagentTool'

// ---------------------------------------------------------------------------
// Result type narrowing (trace.tsx-internal; do NOT move to shared protocol)
// ---------------------------------------------------------------------------

type TaskToolResultSummary = {
    totalTokens?: number
    totalDurationMs?: number
    totalToolUseCount?: number
}

function readSummaryFields(result: unknown): {
    totalTokens: number | null
    totalDurationMs: number | null
    totalToolUseCount: number | null
} {
    if (!isObject(result)) {
        return { totalTokens: null, totalDurationMs: null, totalToolUseCount: null }
    }
    const r = result as Record<string, unknown>
    return {
        totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : null,
        totalDurationMs: typeof r.totalDurationMs === 'number' ? r.totalDurationMs : null,
        totalToolUseCount: typeof r.totalToolUseCount === 'number' ? r.totalToolUseCount : null,
    }
}

// Keep the type alias visible for documentation purposes
type _TaskToolResultSummary = TaskToolResultSummary

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns tool-call children of the given Task/Agent block, or null if none exist.
 */
export function getTaskTraceChildren(block: ToolCallBlock): ToolCallBlock[] | null {
    if (!isSubagentToolName(block.tool.name)) return null
    const children = block.children.filter(
        (c): c is ToolCallBlock => c.kind === 'tool-call',
    )
    return children.length === 0 ? null : children
}

/**
 * Formats the summary line shown in the Trace header.
 * Falls back gracefully when token / duration data is unavailable.
 */
export function getTraceSummaryText(
    calls: number,
    totalTokens: number | null,
    totalDurationMs: number | null,
    callsSuffix: string,
): string {
    const parts: string[] = [`${calls} ${callsSuffix}`]

    if (totalTokens !== null) {
        const k = totalTokens / 1000
        parts.push(`${k.toFixed(1)}k tok`)
    }

    if (totalDurationMs !== null) {
        const s = totalDurationMs / 1000
        parts.push(`${s.toFixed(1)}s`)
    }

    return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// TraceSection component
// ---------------------------------------------------------------------------

type TraceSectionProps = {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
}

export function TraceSection({ block, metadata }: TraceSectionProps) {
    const { t } = useTranslation()
    const children = getTaskTraceChildren(block)
    if (!children) return null

    const state = block.tool.state
    const defaultOpen = state === 'running' || state === 'error' || state === 'pending'

    // Extract summary metadata from result using typed helper
    const { totalTokens, totalDurationMs, totalToolUseCount } = readSummaryFields(block.tool.result)
    const callCount = totalToolUseCount !== null ? totalToolUseCount : children.length

    const summaryText = getTraceSummaryText(callCount, totalTokens, totalDurationMs, t('tool.trace.callsSuffix'))

    return (
        <TraceSectionInner
            items={children}
            metadata={metadata}
            defaultOpen={defaultOpen}
            summaryText={summaryText}
        />
    )
}

// ---------------------------------------------------------------------------
// Inner component (holds open/close state)
// ---------------------------------------------------------------------------

type TraceSectionInnerProps = {
    items: ToolCallBlock[]
    metadata: SessionMetadataSummary | null
    defaultOpen: boolean
    summaryText: string
}

function TraceSectionInner({
    items,
    metadata,
    defaultOpen,
    summaryText,
}: TraceSectionInnerProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(defaultOpen)

    return (
        <div className="flex flex-col gap-1">
            {/* Header row — clickable to toggle */}
            <button
                type="button"
                className="flex items-center gap-1 text-left text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
            >
                <span className="w-3 text-center select-none">{open ? '▾' : '▸'}</span>
                <span>{t('tool.trace')}</span>
                <span className="font-mono font-normal opacity-70">({summaryText})</span>
            </button>

            {open && (
                <TraceChildList items={items} metadata={metadata} />
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Child list
// ---------------------------------------------------------------------------

type TraceChildListProps = {
    items: ToolCallBlock[]
    metadata: SessionMetadataSummary | null
}

function TraceChildList({ items, metadata }: TraceChildListProps) {
    const [expandedId, setExpandedId] = useState<string | null>(null)

    return (
        <div className="flex flex-col gap-1 pl-4 border-l border-[var(--app-border)]">
            {items.map((child) => (
                <TraceChildRow
                    key={child.id}
                    child={child}
                    metadata={metadata}
                    expanded={expandedId === child.id}
                    onToggle={() =>
                        setExpandedId((prev) => (prev === child.id ? null : child.id))
                    }
                />
            ))}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Individual child row
// ---------------------------------------------------------------------------

type TraceChildRowProps = {
    child: ToolCallBlock
    metadata: SessionMetadataSummary | null
    expanded: boolean
    onToggle: () => void
}

function TraceChildRow({ child, metadata, expanded, onToggle }: TraceChildRowProps) {
    const { t } = useTranslation()
    const label = formatTaskChildLabel(child, metadata, t)
    const FullInputView = getToolFullViewComponent(child.tool.name)
    const ResultView = getToolResultViewComponent(child.tool.name)

    return (
        <div className="flex flex-col gap-1">
            <button
                type="button"
                className="flex items-center gap-2 text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                onClick={onToggle}
            >
                <span className="w-3 text-center select-none">{expanded ? '▾' : '▸'}</span>
                <span className="w-4 text-center shrink-0">
                    <TaskStateIcon state={child.tool.state} />
                </span>
                <span className="font-mono break-all">{label}</span>
            </button>

            {expanded && (
                <div className="ml-8 flex flex-col gap-2 rounded border border-[var(--app-border)] p-2">
                    <div>
                        <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.input')}</div>
                        {FullInputView ? (
                            <FullInputView block={child} metadata={metadata} />
                        ) : (
                            <CodeBlock code={safeStringify(child.tool.input)} language="json" />
                        )}
                    </div>
                    <div>
                        <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                        <ResultView block={child} metadata={metadata} />
                    </div>
                </div>
            )}
        </div>
    )
}
