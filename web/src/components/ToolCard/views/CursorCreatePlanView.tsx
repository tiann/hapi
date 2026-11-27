import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'
import { isObject } from '@hapi/protocol'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

export function CursorCreatePlanView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input)) return null
    const plan = typeof input.plan === 'string' ? input.plan : null
    const overview = typeof input.overview === 'string' ? input.overview : null
    const phases = (Array.isArray(input.phases) ? input.phases : []).filter(isObject)
        .map(phase => ({ name: typeof phase.name === 'string' ? phase.name : '', items: extractTodoChecklist(phase, null) }))
        .filter(phase => phase.name || phase.items.length)
    const todos = phases.length ? [] : extractTodoChecklist(input, null)
    if (!plan && !overview && !phases.length && !todos.length) return null

    return (
        <div className="flex flex-col gap-3">
            {overview ? (
                <p className="text-sm text-[var(--app-hint)]">{overview}</p>
            ) : null}
            {plan ? <MarkdownRenderer content={plan} /> : null}
            {phases.map((phase, index) => <div key={index}>
                {phase.name ? <strong>{phase.name}</strong> : null}
                <ChecklistList items={phase.items} />
            </div>)}
            <ChecklistList items={todos} />
        </div>
    )
}
