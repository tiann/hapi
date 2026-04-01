import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import {
    isRequestUserInputToolName,
    parseRequestUserInputInput,
    formatRequestUserInputAnswers,
    type RequestUserInputQuestion
} from '@/components/ToolCard/requestUserInput'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function SelectionMark(props: { checked: boolean }) {
    const mark = props.checked ? '●' : '○'
    return (
        <span className="mt-0.5 w-4 shrink-0 text-center text-[var(--app-hint)]">
            {mark}
        </span>
    )
}

function OptionRow(props: {
    checked: boolean
    disabled: boolean
    title: string
    description?: string | null
    onClick: () => void
}) {
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] disabled:pointer-events-none disabled:opacity-50',
                props.checked ? 'bg-[var(--app-subtle-bg)]' : null
            )}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <SelectionMark checked={props.checked} />
            <span className="min-w-0 flex-1">
                <div className="[&_.aui-md]:font-medium [&_.aui-md]:text-sm [&_.aui-md]:text-[var(--app-fg)]">
                    <MarkdownRenderer content={props.title} />
                </div>
                {props.description ? (
                    <div className="mt-0.5 [&_.aui-md]:text-xs [&_.aui-md]:text-[var(--app-hint)]">
                        <MarkdownRenderer content={props.description} />
                    </div>
                ) : null}
            </span>
        </button>
    )
}

type QuestionState = {
    selected: string | null
    userNote: string
}

export function RequestUserInputFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const parsed = useMemo(() => parseRequestUserInputInput(props.tool.input), [props.tool.input])
    const questions = parsed.questions

    const [step, setStep] = useState(0)
    const [stateByQuestion, setStateByQuestion] = useState<Record<string, QuestionState>>({})

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setStep(0)
        const initial: Record<string, QuestionState> = {}
        for (const q of questions) {
            initial[q.id] = { selected: null, userNote: '' }
        }
        setStateByQuestion(initial)
        setLoading(false)
        setError(null)
    }, [props.tool.id])

    if (!permission || permission.status !== 'pending') return null
    if (!isRequestUserInputToolName(props.tool.name)) return null

    const run = async (action: () => Promise<void>, hapticType: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(hapticType)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('dialog.error.default'))
        }
    }

    const total = Math.max(1, questions.length)
    const clampedStep = Math.min(Math.max(step, 0), total - 1)
    const currentQuestion = questions[clampedStep] as RequestUserInputQuestion | undefined

    const validateQuestion = (question: RequestUserInputQuestion): boolean => {
        const state = stateByQuestion[question.id]
        if (!state) return false

        // For questions with options, require a selection OR user note
        if (question.options.length > 0) {
            return state.selected !== null || state.userNote.trim().length > 0
        }

        // For pure text questions (no options), require user note
        return state.userNote.trim().length > 0
    }

    const submit = async () => {
        if (loading) return

        // Validate all questions
        for (let i = 0; i < questions.length; i += 1) {
            const q = questions[i]
            if (!validateQuestion(q)) {
                setError(t('tool.selectOption'))
                setStep(i)
                return
            }
        }

        // Format answers for submission
        const formattedAnswers = formatRequestUserInputAnswers(stateByQuestion)

        setLoading(true)
        await run(() => props.api.approvePermission(props.sessionId, permission.id, formattedAnswers), 'success')
        setLoading(false)
    }

    const next = () => {
        if (!currentQuestion) return
        if (!validateQuestion(currentQuestion)) {
            setError(t('tool.selectOption'))
            return
        }
        setError(null)
        setStep((s) => Math.min(s + 1, questions.length - 1))
    }

    const prev = () => {
        setError(null)
        setStep((s) => Math.max(s - 1, 0))
    }

    const selectOption = (questionId: string, optionLabel: string) => {
        haptic.selection()
        setStateByQuestion((prev) => ({
            ...prev,
            [questionId]: {
                ...prev[questionId],
                selected: optionLabel
            }
        }))
    }

    const updateUserNote = (questionId: string, value: string) => {
        setStateByQuestion((prev) => ({
            ...prev,
            [questionId]: {
                ...prev[questionId],
                userNote: value
            }
        }))
    }

    const currentState = currentQuestion ? stateByQuestion[currentQuestion.id] : null
    const isPureTextQuestion = currentQuestion && currentQuestion.options.length === 0

    return (
        <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {t('tool.question')}
                        </Badge>
                        <span className="font-mono text-xs text-[var(--app-hint)]">
                            [{clampedStep + 1}/{total}]
                        </span>
                    </div>
                </div>
            </div>

            {error ? (
                <div className="mt-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            {currentQuestion ? (
                <div className="mt-3">
                    {currentQuestion.question ? (
                        <div>
                            <MarkdownRenderer content={currentQuestion.question} />
                        </div>
                    ) : null}

                    {isPureTextQuestion ? (
                        // Pure text question - show only textarea
                        <textarea
                            value={currentState?.userNote ?? ''}
                            onChange={(e) => updateUserNote(currentQuestion.id, e.target.value)}
                            disabled={props.disabled || loading}
                            placeholder={t('tool.requestUserInput.textPlaceholder')}
                            className="mt-3 w-full min-h-[88px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                        />
                    ) : (
                        // Question with options
                        <>
                            <div className="mt-3 flex flex-col gap-1">
                                {currentQuestion.options.map((opt, optIdx) => {
                                    const isSelected = currentState?.selected === opt.label
                                    return (
                                        <OptionRow
                                            key={optIdx}
                                            checked={isSelected}
                                            disabled={props.disabled || loading}
                                            title={opt.label}
                                            description={opt.description}
                                            onClick={() => selectOption(currentQuestion.id, opt.label)}
                                        />
                                    )
                                })}
                            </div>

                            {/* User note input - always shown for questions with options */}
                            <div className="mt-3">
                                <div className="text-xs text-[var(--app-hint)] mb-1">
                                    {t('tool.requestUserInput.noteLabel')}
                                </div>
                                <textarea
                                    value={currentState?.userNote ?? ''}
                                    onChange={(e) => updateUserNote(currentQuestion.id, e.target.value)}
                                    disabled={props.disabled || loading}
                                    placeholder={t('tool.requestUserInput.notePlaceholder')}
                                    className="w-full min-h-[60px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                                />
                            </div>
                        </>
                    )}
                </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    {questions.length > 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading || clampedStep === 0}
                            onClick={prev}
                        >
                            {t('tool.prev')}
                        </Button>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    {questions.length > 1 && clampedStep < questions.length - 1 ? (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={next}
                        >
                            {t('tool.next')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={submit}
                            aria-busy={loading}
                            className="gap-2"
                        >
                            {loading ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                    {t('tool.submitting')}
                                </>
                            ) : (
                                t('tool.submit')
                            )}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}
