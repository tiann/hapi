import type { ReactNode } from 'react'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { parseAskUserQuestionInput } from '@/components/ToolCard/askUserQuestion'
import {
    AskUserQuestionOptionBody,
    askUserQuestionQuoteClassName,
    getAskUserQuestionOptionFrameClassName
} from '@/components/ToolCard/askUserQuestionOptionCard'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

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

function AnswerOptionCard(props: {
    isMulti: boolean
    isSelected: boolean
    title: string
    description?: string
    customLabel?: string
    showControl?: boolean
}) {
    const { isMulti, isSelected, title, description, customLabel, showControl } = props

    return (
        <div className={getAskUserQuestionOptionFrameClassName(isSelected)}>
            <AskUserQuestionOptionBody
                checked={isSelected}
                mode={isMulti ? 'multi' : 'single'}
                title={title}
                description={description}
                customLabel={customLabel}
                showControl={showControl}
            />
        </div>
    )
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
                <AnswerOptionCard
                    key={`other-${i}`}
                    isMulti={isMulti}
                    isSelected={true}
                    title={answer}
                    customLabel="(custom answer)"
                />
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
        <div className="mt-3 flex flex-col gap-1.5">
            {cleaned.map((answer, i) => (
                <AnswerOptionCard
                    key={i}
                    isMulti={false}
                    isSelected={true}
                    title={answer}
                />
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
        <div className="flex flex-col gap-4">
            {questions.map((q, idx) => {
                const isMulti = q.multiSelect

                return (
                    <div key={idx} className="flex flex-col gap-3">
                        {q.question ? (
                            <div className={askUserQuestionQuoteClassName}>
                                <MarkdownRenderer content={q.question} />
                            </div>
                        ) : null}

                        {q.options.length > 0 ? (
                            <div className="flex flex-col gap-1.5">
                                {q.options.map((opt, optIdx) => {
                                    const isSelected = isAnswerSelected(answers, idx, opt.label)
                                    return (
                                        <AnswerOptionCard
                                            key={optIdx}
                                            isMulti={isMulti}
                                            isSelected={isSelected}
                                            title={opt.label}
                                            description={opt.description ?? undefined}
                                            showControl={Boolean(hasAnswers)}
                                        />
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
