import { diffLines } from 'diff'
import { cn } from '@/lib/utils'

export function DiffView(props: {
    oldString: string
    newString: string
    filePath?: string
}) {
    const diff = diffLines(props.oldString, props.newString)

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
