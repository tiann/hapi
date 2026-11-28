import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { codexPatchFiles } from '@/components/ToolCard/codexPatch'
import { basename, resolveDisplayPath } from '@/utils/path'

function PatchLines({ diff }: { diff: string }) {
    // Keep hunk boundaries, context, and original line prefixes intact.
    const lines = diff.replace(/\r?\n$/, '').split(/\r?\n/)
    const firstHunk = lines.findIndex(line => line.startsWith('@@'))
    return (
        <pre className="overflow-x-auto rounded-md bg-[var(--app-code-bg)] text-xs">
            {lines.map((line, index) => {
                const body = firstHunk < 0 || index > firstHunk
                const color = body && line.startsWith('+') ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]'
                    : body && line.startsWith('-') ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]'
                    : 'text-[var(--app-hint)]'
                return <span key={index} className={`block min-w-max px-2 ${color}`}>{line || ' '}</span>
            })}
        </pre>
    )
}

export function CodexPatchView(props: ToolViewProps) {
    const files = codexPatchFiles(props.block.tool.input)
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {files.map(({ path, diff }, index) => {
                const display = resolveDisplayPath(path, props.metadata)
                const pathInCardHeader = props.surface === 'inline' && files.length === 1 && display === basename(display)
                return (
                    <div key={index} className="min-w-0">
                        {!pathInCardHeader && <div className="break-all font-mono text-sm">{display}</div>}
                        {diff && <PatchLines diff={diff} />}
                    </div>
                )
            })}
        </div>
    )
}
