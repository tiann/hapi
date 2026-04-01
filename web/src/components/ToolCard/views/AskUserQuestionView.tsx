import type { ReactNode } from 'react'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { parseAskUserQuestionInput } from '@/components/ToolCard/askUserQuestion'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { cn } from '@/lib/utils'

type AnswersFormat = Record<string, string[]> | Record<string, { answers: string[] }>

/**
 * Normalize answers to flat format: Record<string, string[]>
 */
function normalizeAnswers(answers: AnswersFormat | undefined): Record<string, string[]> | undefined {
    if (!answers) return undefined
    const result: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            result[key] = value
        } else if (value && typeof value === 'object' && 'answers' in value) {
            result[key] = value.answers
        }
    }
    return result
}

function isAnswerSelected(
    answers: Record<string, string[]> | undefined,
    questionIdx: number,
    optionLabel: string
): boolean {
    if (!answers) return false
    const questionAnswers = answers[String(questionIdx)]
    if (!questionAnswers || !Array.isArray(questionAnswers)) return false
    return questionAnswers.some(a => a.trim() === optionLabel.trim())
}

function getSelectionMark(isMulti: boolean, isSelected: boolean): string {
    if (isMulti) {
        return isSelected ? '☑' : '☐'
    }
    return isSelected ? '●' : '○'
}

function renderOtherAnswers(
    answers: Record<string, string[]>,
    questionIdx: number,
    options: { label: string }[],
    isMulti: boolean
): ReactNode {
    const questionAnswers = answers[String(questionIdx)]
    if (!questionAnswers || !Array.isArray(questionAnswers)) return null

    const optionLabels = new Set(options.map(o => o.label.trim()))
    const otherAnswers = questionAnswers.filter(a => !optionLabels.has(a.trim()))

    if (otherAnswers.length === 0) return null

    return (
        <>
            {otherAnswers.map((answer, i) => (
                <div
                    key={`other-${i}`}
                    className="rounded-md border border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-2"
                >
                    <div className="flex items-start gap-2">
                        <span className="shrink-0 text-sm text-emerald-600">
                            {isMulti ? '☑' : '●'}
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm text-emerald-700 dark:text-emerald-300 font-medium break-words">
                                {answer}
                            </div>
                            <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                (custom answer)
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </>
    )
}

function renderFreeformAnswers(
    answers: Record<string, string[]>,
    questionIdx: number
): ReactNode {
    const questionAnswers = answers[String(questionIdx)]
    if (!questionAnswers || !Array.isArray(questionAnswers)) return null

    const cleaned = questionAnswers.map(a => a.trim()).filter(a => a.length > 0)
    if (cleaned.length === 0) return null

    return (
        <div className="mt-3 flex flex-col gap-1">
            {cleaned.map((answer, i) => (
                <div
                    key={i}
                    className="rounded-md border border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-2"
                >
                    <div className="flex items-start gap-2">
                        <span className="shrink-0 text-sm text-emerald-600">●</span>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm text-emerald-700 dark:text-emerald-300 font-medium break-words">
                                {answer}
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

export function AskUserQuestionView(props: ToolViewProps) {
    const parsed = parseAskUserQuestionInput(props.block.tool.input)
    const questions = parsed.questions
    const rawAnswers = props.block.tool.permission?.answers ?? undefined
    const answers = normalizeAnswers(rawAnswers)
    const hasAnswers = answers && Object.keys(answers).length > 0

    // When questions array is empty but answers exist (fallback path),
    // render the answers directly
    if (questions.length === 0) {
        if (hasAnswers && answers) {
            return renderFreeformAnswers(answers, 0)
        }
        return null
    }

    return (
        <div className="flex flex-col gap-3">
            {questions.map((q, idx) => {
                const isMulti = q.multiSelect

                return (
                    <div key={idx} className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                        {q.question ? (
                            <div>
                                <MarkdownRenderer content={q.question} />
                            </div>
                        ) : null}

                        {q.options.length > 0 ? (
                            <div className="mt-3 flex flex-col gap-1">
                                {q.options.map((opt, optIdx) => {
                                    const isSelected = isAnswerSelected(answers, idx, opt.label)
                                    return (
                                        <div
                                            key={optIdx}
                                            className={cn(
                                                "rounded-md border px-2 py-2",
                                                isSelected
                                                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                                                    : "border-[var(--app-border)]"
                                            )}
                                        >
                                            <div className="flex items-start gap-2">
                                                {hasAnswers && (
                                                    <span className={cn(
                                                        "shrink-0 text-sm",
                                                        isSelected
                                                            ? "text-emerald-600"
                                                            : "text-[var(--app-hint)]"
                                                    )}>
                                                        {getSelectionMark(isMulti, isSelected)}
                                                    </span>
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <div className={cn(
                                                        "[&_.aui-md]:text-sm",
                                                        isSelected
                                                            ? "[&_.aui-md]:text-emerald-700 dark:[&_.aui-md]:text-emerald-300 [&_.aui-md]:font-medium"
                                                            : "[&_.aui-md]:text-[var(--app-fg)]"
                                                    )}>
                                                        <MarkdownRenderer content={opt.label} />
                                                    </div>
                                                    {opt.description ? (
                                                        <div className="mt-0.5 [&_.aui-md]:text-xs [&_.aui-md]:text-[var(--app-hint)]">
                                                            <MarkdownRenderer content={opt.description} />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}

                                {hasAnswers && renderOtherAnswers(answers, idx, q.options, isMulti)}
                            </div>
                        ) : hasAnswers && answers ? (
                            // Freeform question (no options) - show the answer directly
                            renderFreeformAnswers(answers, idx)
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}
