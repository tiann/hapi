import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject } from '@hapi/protocol'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

export function CursorCreatePlanView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input)) return null
    const plan = typeof input.plan === 'string' ? input.plan : null
    const overview = typeof input.overview === 'string' ? input.overview : null
    if (!plan && !overview) return null

    return (
        <div className="flex flex-col gap-3">
            {overview ? (
                <p className="text-sm text-[var(--app-hint)]">{overview}</p>
            ) : null}
            {plan ? <MarkdownRenderer content={plan} /> : null}
        </div>
    )
}
