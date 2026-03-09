import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'

export function TodoWriteView(props: ToolViewProps) {
    const todos = extractTodoChecklist(props.block.tool.input, props.block.tool.result)
    return <ChecklistList items={todos} />
}
