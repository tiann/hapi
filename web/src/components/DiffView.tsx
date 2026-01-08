import { diffLines } from 'diff'
import { useMemo } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export function DiffView(props: {
    oldString: string
    newString: string
    filePath?: string
    variant?: 'preview' | 'inline'
}) {
    const { t } = useTranslation()
    const variant = props.variant ?? 'preview'
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()

    const stats = useMemo(() => {
        const oldChars = props.oldString.length
        const newChars = props.newString.length
        const oldLabel = `${oldChars.toLocaleString()} chars`
        const newLabel = `${newChars.toLocaleString()} chars`
        return { oldChars, newChars, label: `old: ${oldLabel} → new: ${newLabel}` }
    }, [props.oldString.length, props.newString.length])

    const title = props.filePath ? props.filePath : t('diff.title')
    const subtitle = props.filePath ? stats.label : `${t('diff.title')} • ${stats.label}`

    const DiffInline = (
        <DiffInlineView
            oldString={props.oldString}
            newString={props.newString}
            filePath={props.filePath}
        />
    )

    if (variant === 'inline') {
        return DiffInline
    }

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        suppressFocusRing && 'focus-visible:ring-0'
                    )}
                    onPointerDown={onTriggerPointerDown}
                    onKeyDown={onTriggerKeyDown}
                    onBlur={onTriggerBlur}
                >
                    <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] hover:bg-[var(--app-secondary-bg)] transition-colors">
                        {props.filePath ? (
                            <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-hint)] truncate">
                                {props.filePath}
                            </div>
                        ) : null}
                        <div className="px-2 py-2">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 font-mono text-xs text-[var(--app-hint)] truncate">
                                    {props.filePath ? stats.label : subtitle}
                                </div>
                                <div className="shrink-0 text-xs text-[var(--app-link)]">
                                    {t('diff.view')}
                                </div>
                            </div>
                        </div>
                    </div>
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <DialogTitle className="break-all">{title}</DialogTitle>
                    <DialogDescription className="font-mono break-all">
                        {stats.label}
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-3 max-h-[75vh] overflow-auto">
                    {DiffInline}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function DiffInlineView(props: {
    oldString: string
    newString: string
    filePath?: string
}) {
    const diff = useMemo(() => diffLines(props.oldString, props.newString), [props.oldString, props.newString])

    return (
        <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
            {props.filePath ? (
                <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-hint)] truncate">
                    {props.filePath}
                </div>
            ) : null}

            <div className="font-mono text-xs">
                {diff.map((part, i) => {
                    const lines = part.value.split('\n')
                    if (lines.length > 0 && lines[lines.length - 1] === '') {
                        lines.pop()
                    }

                    const prefix = part.added ? '+' : part.removed ? '-' : ' '
                    const className = cn(
                        part.added && 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]',
                        part.removed && 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]'
                    )

                    return (
                        <div key={i} className={className}>
                            {lines.map((line, j) => (
                                <div key={j} className="whitespace-pre-wrap px-2">
                                    {prefix} {line}
                                </div>
                            ))}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
