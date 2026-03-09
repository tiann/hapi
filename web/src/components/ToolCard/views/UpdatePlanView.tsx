import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { ChecklistList, extractUpdatePlanChecklist } from '@/components/ToolCard/checklist'

export function UpdatePlanView(props: ToolViewProps) {
    const steps = extractUpdatePlanChecklist(props.block.tool.input, props.block.tool.result)
    return <ChecklistList items={steps} />
}
