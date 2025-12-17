import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

export function CodexPatchView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input) || !isObject(input.changes)) return null

    const files = Object.keys(input.changes)
    if (files.length === 0) return null

    return (
        <div className="flex flex-col gap-1">
            {files.map((file) => {
                const display = resolveDisplayPath(file, props.metadata)
                return (
                    <div key={file} className="text-sm text-[var(--app-fg)] font-mono break-all">
                        {basename(display)}
                    </div>
                )
            })}
        </div>
    )
}

