import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { DiffView } from '@/components/DiffView'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function parseUnifiedDiff(unifiedDiff: string): { oldText: string; newText: string; fileName?: string } {
    const lines = unifiedDiff.split('\n')
    const oldLines: string[] = []
    const newLines: string[] = []
    let fileName: string | undefined
    let inHunk = false

    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            fileName = line.replace(/^\+\+\+ (b\/)?/, '')
            continue
        }

        if (
            line.startsWith('diff --git')
            || line.startsWith('index ')
            || line.startsWith('---')
            || line.startsWith('new file mode')
            || line.startsWith('deleted file mode')
        ) {
            continue
        }

        if (line.startsWith('@@')) {
            inHunk = true
            continue
        }

        if (!inHunk) continue

        if (line.startsWith('+')) {
            newLines.push(line.substring(1))
        } else if (line.startsWith('-')) {
            oldLines.push(line.substring(1))
        } else if (line.startsWith(' ')) {
            oldLines.push(line.substring(1))
            newLines.push(line.substring(1))
        } else if (line === '\\ No newline at end of file') {
            continue
        } else if (line === '') {
            oldLines.push('')
            newLines.push('')
        }
    }

    return {
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n'),
        fileName
    }
}

function renderDiff(block: ToolViewProps['block'], showFileHeader: boolean) {
    const input = block.tool.input
    if (!isObject(input) || typeof input.unified_diff !== 'string') return null

    const parsed = parseUnifiedDiff(input.unified_diff)
    return (
        <DiffView
            oldString={parsed.oldText}
            newString={parsed.newText}
            filePath={showFileHeader ? parsed.fileName : undefined}
            variant={showFileHeader ? 'inline' : undefined}
        />
    )
}

export function CodexDiffCompactView(props: ToolViewProps) {
    return renderDiff(props.block, false)
}

export function CodexDiffFullView(props: ToolViewProps) {
    return renderDiff(props.block, true)
}
