import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import {
    isRequestUserInputToolName,
    isAsyncRequestUserInput,
    parseRequestUserInputInput,
    formatRequestUserInputAnswers,
    isRequestUserInputQuestionAnswered,
    isRequestUserInputUrlConfirmed,
    openRequestUserInputUrl,
    requestUserInputOptions,
    selectRequestUserInputOption,
    type RequestUserInputOption,
    type RequestUserInputQuestion
} from '@/components/ToolCard/requestUserInput'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'
import { AskUserQuestionOptionRow, askUserQuestionNavButtonClassName } from '@/components/ToolCard/askUserQuestionOptionCard'

type QuestionState = {
    selected: string[]
    userNote: string
    noteExpanded: boolean
}

// Same shape as Submit, quieter colors.
const addNoteButtonClassName = 'h-8 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3.5 text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'

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
    const isAsync = isAsyncRequestUserInput(props.tool.name, props.tool.input)

    const [step, setStep] = useState(0)
    const [stateByQuestion, setStateByQuestion] = useState<Record<string, QuestionState>>({})

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const noteRef = useRef<HTMLTextAreaElement>(null)
    const shouldFocusNoteRef = useRef(false)

    useEffect(() => {
        setStep(0)
        const initial: Record<string, QuestionState> = {}
        for (const q of questions) {
            const userNote = q.prefill ?? ''
            initial[q.id] = {
                selected: [],
                userNote,
                noteExpanded: userNote.trim().length > 0
            }
        }
        setStateByQuestion(initial)
        setLoading(false)
        setError(null)
        shouldFocusNoteRef.current = false
    }, [props.tool.id])

    useEffect(() => {
        if (!shouldFocusNoteRef.current || !noteRef.current) return
        shouldFocusNoteRef.current = false
        noteRef.current.focus()
    })

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
        return isRequestUserInputQuestionAnswered(question, stateByQuestion[question.id])
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
        const formattedAnswers = formatRequestUserInputAnswers(stateByQuestion, questions)

        if (parsed.url) {
            if (!isRequestUserInputUrlConfirmed(parsed, stateByQuestion)) {
                setError(t('tool.selectOption'))
                return
            }
            if (!openRequestUserInputUrl(parsed.url)) {
                setError(t('tool.requestUserInput.popupBlocked'))
                haptic.notification('error')
                return
            }
        }

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
        shouldFocusNoteRef.current = false
        setStep((s) => Math.min(s + 1, questions.length - 1))
    }

    const dismiss = async () => {
        if (!isAsync || loading) return
        setLoading(true)
        await run(() => props.api.denyPermission(props.sessionId, permission.id), 'success')
        setLoading(false)
    }

    const prev = () => {
        setError(null)
        shouldFocusNoteRef.current = false
        setStep((s) => Math.max(s - 1, 0))
    }

    const requestNoteFocus = () => {
        if (noteRef.current) {
            shouldFocusNoteRef.current = false
            noteRef.current.focus()
        } else {
            shouldFocusNoteRef.current = true
        }
    }

    const selectOption = (question: RequestUserInputQuestion, option: RequestUserInputOption) => {
        haptic.selection()
        setError(null)
        setStateByQuestion((prev) => {
            const current = prev[question.id] ?? { selected: [], userNote: question.prefill ?? '', noteExpanded: false }
            return {
                ...prev,
                [question.id]: {
                    ...current,
                    selected: selectRequestUserInputOption(question, current.selected, option),
                    noteExpanded: current.noteExpanded || Boolean(option.isOther)
                }
            }
        })
        if (option.isOther) {
            requestNoteFocus()
        }
    }

    const expandNote = (question: RequestUserInputQuestion) => {
        setStateByQuestion((prev) => {
            const current = prev[question.id] ?? { selected: [], userNote: question.prefill ?? '', noteExpanded: false }
            return {
                ...prev,
                [question.id]: {
                    ...current,
                    noteExpanded: true
                }
            }
        })
        requestNoteFocus()
    }

    const updateUserNote = (question: RequestUserInputQuestion, value: string) => {
        setStateByQuestion((prev) => {
            const current = prev[question.id] ?? { selected: [], userNote: question.prefill ?? '', noteExpanded: false }
            return {
                ...prev,
                [question.id]: {
                    ...current,
                    userNote: value
                }
            }
        })
    }

    const currentState = currentQuestion ? stateByQuestion[currentQuestion.id] : null
    const isPureTextQuestion = currentQuestion && currentQuestion.options.length === 0
    const hasSelection = (currentState?.selected.length ?? 0) > 0
    const hasNoteContent = (currentState?.userNote.trim().length ?? 0) > 0
    const isNoteExpanded = Boolean(currentState?.noteExpanded) || hasNoteContent
    const showAddNote = !isPureTextQuestion && hasSelection && !isNoteExpanded

    return (
        <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="mb-2 text-xs text-[var(--app-hint)]">
                {t('tool.waitingForReply')}
            </div>
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
                            onChange={(e) => updateUserNote(currentQuestion, e.target.value)}
                            disabled={props.disabled || loading}
                            placeholder={currentQuestion.placeholder ?? t('tool.requestUserInput.textPlaceholder')}
                            className="mt-3 w-full min-h-[88px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                        />
                    ) : (
                        // Question with options
                        <>
                            <div className="mt-3 flex flex-col gap-1">
                                {requestUserInputOptions(currentQuestion).map((opt, optIdx) => {
                                    const isSelected = currentState?.selected.includes(opt.label) ?? false
                                    return (
                                        <AskUserQuestionOptionRow
                                            key={optIdx}
                                            mode={currentQuestion.multiple ? 'multi' : 'single'}
                                            checked={isSelected}
                                            disabled={props.disabled || loading}
                                            title={opt.isOther ? t('tool.requestUserInput.otherLabel') : opt.label}
                                            description={opt.isOther ? t('tool.requestUserInput.otherDescription') : opt.description}
                                            markdown
                                            onClick={() => selectOption(currentQuestion, opt)}
                                        />
                                    )
                                })}
                            </div>

                            {isNoteExpanded ? (
                                <div className="mt-3">
                                    <div className="text-xs text-[var(--app-hint)] mb-1">
                                        {t('tool.requestUserInput.noteLabel')}
                                    </div>
                                    <textarea
                                        ref={noteRef}
                                        aria-label={t('tool.requestUserInput.noteLabel')}
                                        value={currentState?.userNote ?? ''}
                                        onChange={(e) => updateUserNote(currentQuestion, e.target.value)}
                                        disabled={props.disabled || loading}
                                        placeholder={t('tool.requestUserInput.notePlaceholder')}
                                        className="w-full min-h-[60px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                                    />
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}

            <div
                data-testid="request-user-input-actions"
                className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] pt-3"
            >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {showAddNote && currentQuestion ? (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={() => expandNote(currentQuestion)}
                            className={addNoteButtonClassName}
                        >
                            {t('tool.requestUserInput.addNote')}
                        </Button>
                    ) : null}
                    {isAsync ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={dismiss}
                            title={t('tool.requestUserInput.dismissHint')}
                            className={askUserQuestionNavButtonClassName}
                        >
                            {t('button.dismiss')}
                        </Button>
                    ) : null}
                    {questions.length > 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading || clampedStep === 0}
                            onClick={prev}
                            className={askUserQuestionNavButtonClassName}
                        >
                            {t('tool.prev')}
                        </Button>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    {questions.length > 1 && clampedStep < questions.length - 1 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={next}
                            className={askUserQuestionNavButtonClassName}
                        >
                            {t('tool.next')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={props.disabled || loading}
                            onClick={submit}
                            aria-busy={loading}
                            className={cn(askUserQuestionNavButtonClassName, 'gap-2')}
                        >
                            {loading ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-fg)]" />
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
