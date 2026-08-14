import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

/**
 * Compact tool card for DSH sessions: invocation input and result output
 * with collapsible detail. Rendered from the projected tool_call/tool_result
 * messages.
 */
export function DshToolCard({ id, name, input, output, status, isResult }: {
    id: string
    name: string
    input?: unknown
    output?: unknown
    status?: string
    isResult?: boolean
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const failed = status === 'failed'
    const tone = failed
        ? 'border-red-500/30 bg-red-500/5'
        : isResult
            ? 'border-[var(--app-border)] bg-[var(--app-secondary-bg)]/40'
            : 'border-[var(--app-border)] bg-[var(--app-card-bg)]'

    const detail = isResult ? output : input
    const detailText = typeof detail === 'string'
        ? detail
        : detail === undefined
            ? ''
            : safeStringify(detail)

    return (
        <div className={`rounded-lg border ${tone} px-3 py-2 text-xs`}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
            >
                <span className="truncate font-mono font-medium">
                    {isResult ? '' : `⚡ ${name}`}
                    {isResult && failed ? '✗' : isResult ? '✓' : ''}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--app-hint)]">
                    {isResult ? t('dsh.toolResult') : t('dsh.toolCall')}
                    {status ? ` · ${status}` : ''}
                </span>
            </button>
            {open && detailText ? (
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--app-secondary-bg)] p-2 font-mono text-[10px] leading-relaxed">
                    {detailText}
                </pre>
            ) : null}
            <div className="mt-1 truncate text-[10px] text-[var(--app-hint)]">{id}</div>
        </div>
    )
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
