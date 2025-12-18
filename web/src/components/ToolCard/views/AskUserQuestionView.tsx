import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { Badge } from '@/components/ui/badge'
import { parseAskUserQuestionInput } from '@/components/ToolCard/askUserQuestion'

export function AskUserQuestionView(props: ToolViewProps) {
    const parsed = parseAskUserQuestionInput(props.block.tool.input)
    const questions = parsed.questions
    if (questions.length === 0) return null

    return (
        <div className="flex flex-col gap-3">
            {questions.map((q, idx) => (
                <div key={idx} className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {q.header ?? `Question ${idx + 1}`}
                        </Badge>
                        <Badge variant="default">
                            {q.multiSelect ? 'Multi' : 'Single'}
                        </Badge>
                    </div>

                    {q.question ? (
                        <div className="mt-2 text-sm text-[var(--app-fg)] break-words">
                            {q.question}
                        </div>
                    ) : null}

                    {q.options.length > 0 ? (
                        <div className="mt-3 flex flex-col gap-1">
                            {q.options.map((opt, optIdx) => (
                                <div key={optIdx} className="rounded-md border border-[var(--app-border)] px-2 py-2">
                                    <div className="text-sm text-[var(--app-fg)] break-words">
                                        {opt.label}
                                    </div>
                                    {opt.description ? (
                                        <div className="mt-0.5 text-xs text-[var(--app-hint)] break-words">
                                            {opt.description}
                                        </div>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    )
}
