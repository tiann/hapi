import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { DiffView } from '@/components/DiffView'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

type Edit = { old_string: string; new_string: string }

const MAX_COMPACT_EDITS = 3

function extractEdits(input: unknown): Edit[] {
    if (!isObject(input) || !Array.isArray(input.edits)) return []
    return input.edits
        .filter(isObject)
        .map((edit) => ({
            old_string: typeof edit.old_string === 'string' ? edit.old_string : '',
            new_string: typeof edit.new_string === 'string' ? edit.new_string : ''
        }))
        .filter((edit) => edit.old_string.length > 0 || edit.new_string.length > 0)
}

export function MultiEditView(props: ToolViewProps) {
    const edits = extractEdits(props.block.tool.input)
    if (edits.length === 0) return null

    return (
        <div className="flex flex-col gap-2">
            {edits.slice(0, MAX_COMPACT_EDITS).map((edit, idx) => (
                <DiffView
                    key={idx}
                    oldString={edit.old_string}
                    newString={edit.new_string}
                />
            ))}
            {edits.length > MAX_COMPACT_EDITS ? (
                <div className="text-xs text-[var(--app-hint)]">
                    (+{edits.length - MAX_COMPACT_EDITS} more edits)
                </div>
            ) : null}
        </div>
    )
}

export function MultiEditFullView(props: ToolViewProps) {
    const edits = extractEdits(props.block.tool.input)
    if (edits.length === 0) return null

    return (
        <div className="flex flex-col gap-2">
            {edits.map((edit, idx) => (
                <DiffView
                    key={idx}
                    oldString={edit.old_string}
                    newString={edit.new_string}
                />
            ))}
        </div>
    )
}
