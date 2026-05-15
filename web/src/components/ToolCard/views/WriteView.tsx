import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { DiffView } from '@/components/DiffView'
import { getInputStringAny } from '@/lib/toolInputUtils'

export function WriteView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input)) return null

    const content = typeof input.content === 'string' ? input.content : typeof input.text === 'string' ? input.text : null
    if (content === null) return null
    const filePath = getInputStringAny(input, ['file_path', 'path'])

    if (props.surface === 'dialog') {
        return (
            <div className="flex flex-col gap-2">
                {filePath ? (
                    <div className="text-xs text-[var(--app-hint)] font-mono break-all">
                        {filePath}
                    </div>
                ) : null}
                <CodeBlock code={content} language="text" title="Draft" size="comfortable" scrollY />
            </div>
        )
    }

    return (
        <DiffView
            oldString=""
            newString={content}
            variant="inline"
        />
    )
}
