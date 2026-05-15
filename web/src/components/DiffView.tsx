import { diffLines } from 'diff'
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function countLines(text: string) {
    if (text.length === 0) return 0
    return splitDiffLines(text).length
}

function splitDiffLines(text: string): string[] {
    if (text.length === 0) return []
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return lines
}

function countChangedLines(parts: ReturnType<typeof diffLines>, kind: 'added' | 'removed') {
    return parts.reduce((sum, part) => {
        if ((kind === 'added' && !part.added) || (kind === 'removed' && !part.removed)) {
            return sum
        }
        return sum + splitDiffLines(part.value).length
    }, 0)
}

function DiffStatBadge(props: { tone: 'added' | 'removed'; value: number }) {
    const className = props.tone === 'added'
        ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]'
        : 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]'

    return (
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', className)}>
            {props.tone === 'added' ? '+' : '-'}{props.value}
        </span>
    )
}

export function DiffView(props: {
    oldString: string
    newString: string
    filePath?: string
    variant?: 'preview' | 'inline'
    size?: 'compact' | 'comfortable'
    scrollY?: boolean
    maxHeight?: number
}) {
    const { t } = useTranslation()
    const variant = props.variant ?? 'preview'
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()

    const diff = useMemo(() => diffLines(props.oldString, props.newString), [props.oldString, props.newString])
    const stats = useMemo(() => {
        const oldLines = countLines(props.oldString)
        const newLines = countLines(props.newString)
        const additions = countChangedLines(diff, 'added')
        const deletions = countChangedLines(diff, 'removed')
        const summary = `${oldLines.toLocaleString()} → ${newLines.toLocaleString()} lines`
        return { additions, deletions, summary }
    }, [diff, props.oldString, props.newString])

    const title = props.filePath ? props.filePath : t('diff.title')
    const subtitle = props.filePath ? stats.summary : `${t('diff.title')} • ${stats.summary}`

    const diffInline = (
        <DiffInlineView
            oldString={props.oldString}
            newString={props.newString}
            filePath={props.filePath}
            additions={stats.additions}
            deletions={stats.deletions}
            showHeader
            size={props.size}
            scrollY={props.scrollY}
            maxHeight={props.maxHeight}
        />
    )

    if (variant === 'inline') {
        return diffInline
    }

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    type="button"
                    aria-label={props.filePath ? `Open diff for ${props.filePath}` : 'Open diff preview'}
                    className={cn(
                        'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        suppressFocusRing && 'focus-visible:ring-0'
                    )}
                    onPointerDown={onTriggerPointerDown}
                    onKeyDown={onTriggerKeyDown}
                    onBlur={onTriggerBlur}
                >
                    <div className="overflow-hidden rounded-2xl bg-[var(--app-code-bg)] transition-colors">
                        <div className="flex items-center justify-between gap-3 bg-[var(--app-code-header-bg)] px-3 py-2">
                            <div className="min-w-0">
                                <div className="truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
                                    {props.filePath ?? t('diff.title')}
                                </div>
                                <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                    {stats.summary}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <DiffStatBadge tone="added" value={stats.additions} />
                                <DiffStatBadge tone="removed" value={stats.deletions} />
                                <span className="text-xs font-medium text-[var(--app-link)]">{t('diff.view')}</span>
                            </div>
                        </div>
                        <div className="max-h-40 overflow-hidden">
                            <DiffInlineView
                                oldString={props.oldString}
                                newString={props.newString}
                                additions={stats.additions}
                                deletions={stats.deletions}
                                showHeader={false}
                                size={props.size}
                            />
                        </div>
                    </div>
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-5xl">
                <DialogHeader>
                    <DialogTitle className="break-all">{title}</DialogTitle>
                    <DialogDescription className="break-all font-mono">
                        {subtitle}
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-3 max-h-[75vh] overflow-auto">
                    {diffInline}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function DiffInlineView(props: {
    oldString: string
    newString: string
    filePath?: string
    additions: number
    deletions: number
    showHeader: boolean
    size?: 'compact' | 'comfortable'
    scrollY?: boolean
    maxHeight?: number
}) {
    const diff = useMemo(() => diffLines(props.oldString, props.newString), [props.oldString, props.newString])
    const isComfortable = props.size === 'comfortable'
    const lineNumberWidth = Math.max(
        String(countLines(props.oldString)).length,
        String(countLines(props.newString)).length,
        2
    )
    const rowStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch ${lineNumberWidth}ch ${isComfortable ? 'max-content' : 'minmax(0, 1fr)'}`
    } satisfies CSSProperties

    let oldLineNumber = 1
    let newLineNumber = 1

    return (
        <div className={cn('overflow-hidden bg-[var(--app-code-bg)]', props.showHeader ? 'rounded-2xl' : 'rounded-none')}>
            {props.showHeader ? (
                <div className="flex items-center justify-between gap-3 bg-[var(--app-code-header-bg)] px-3 py-2">
                    <div className="min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
                        {props.filePath ?? 'Diff'}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <DiffStatBadge tone="added" value={props.additions} />
                        <DiffStatBadge tone="removed" value={props.deletions} />
                    </div>
                </div>
            ) : null}

            <div
                className={cn(
                    'overflow-x-auto',
                    props.scrollY ? 'overflow-y-auto' : 'overflow-y-hidden'
                )}
                style={props.scrollY ? { maxHeight: props.maxHeight ?? 420 } : undefined}
            >
                <div className={cn('font-mono', isComfortable ? 'w-max min-w-full text-sm leading-6' : 'text-xs')}>
                    {diff.map((part, i) => {
                        const lines = splitDiffLines(part.value)

                        return (
                            <div key={i}>
                                {lines.map((line, j) => {
                                    const prefix = part.added ? '+' : part.removed ? '-' : ' '
                                    const leftNumber = part.added ? '' : String(oldLineNumber++)
                                    const rightNumber = part.removed ? '' : String(newLineNumber++)
                                    const rowClass = cn(
                                        'grid min-w-full gap-3',
                                        isComfortable ? 'px-4' : 'px-3',
                                        isComfortable ? 'py-0' : 'py-1.5',
                                        part.added && 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]',
                                        part.removed && 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]'
                                    )

                                    return (
                                        <div key={j} className={rowClass} style={rowStyle}>
                                            <div className={cn('text-left text-[var(--app-hint)]/80', isComfortable ? 'text-xs leading-6' : 'text-[10px]')}>{leftNumber}</div>
                                            <div className={cn('text-left text-[var(--app-hint)]/80', isComfortable ? 'text-xs leading-6' : 'text-[10px]')}>{rightNumber}</div>
                                            <div className={cn(isComfortable ? 'whitespace-pre' : 'min-w-0 whitespace-pre-wrap break-words')}>
                                                <span className="mr-2 inline-block w-3 text-[var(--app-hint)]/90">{prefix}</span>
                                                <span>{line}</span>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
