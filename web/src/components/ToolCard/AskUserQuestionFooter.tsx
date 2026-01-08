import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { isAskUserQuestionToolName, parseAskUserQuestionInput, type AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function SelectionMark(props: { checked: boolean; mode: 'single' | 'multi' }) {
    const mark = props.mode === 'multi'
        ? (props.checked ? '☑' : '☐')
        : (props.checked ? '●' : '○')
    return (
        <span className="mt-0.5 w-4 shrink-0 text-center text-[var(--app-hint)]">
            {mark}
        </span>
    )
}

function OptionRow(props: {
    checked: boolean
    mode: 'single' | 'multi'
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
            <SelectionMark checked={props.checked} mode={props.mode} />
            <span className="min-w-0 flex-1">
                <div className="font-medium text-[var(--app-fg)] break-words">{props.title}</div>
                {props.description ? (
                    <div className="mt-0.5 text-xs text-[var(--app-hint)] break-words">
                        {props.description}
                    </div>
                ) : null}
            </span>
        </button>
    )
}

function computeAnswersForQuestion(
    question: AskUserQuestionQuestion,
    selectedOptionIndices: number[],
    otherSelected: boolean,
    otherText: string
): string[] {
    const answers: string[] = []

    for (const idx of selectedOptionIndices) {
        const opt = question.options[idx]
        if (!opt) continue
        const label = opt.label.trim()
        if (label.length > 0) answers.push(label)
    }

    const other = otherText.trim()
    if (otherSelected && other.length > 0) {
        answers.push(other)
    }

    return answers
}

export function AskUserQuestionFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const parsed = useMemo(() => parseAskUserQuestionInput(props.tool.input), [props.tool.input])
    const questions = parsed.questions

    const [step, setStep] = useState(0)
    const [selectedByQuestion, setSelectedByQuestion] = useState<number[][]>([])
    const [otherSelectedByQuestion, setOtherSelectedByQuestion] = useState<boolean[]>([])
    const [otherTextByQuestion, setOtherTextByQuestion] = useState<string[]>([])
    const [fallbackText, setFallbackText] = useState('')

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setStep(0)
        setSelectedByQuestion(questions.map(() => []))
        setOtherSelectedByQuestion(questions.map(() => false))
        setOtherTextByQuestion(questions.map(() => ''))
        setFallbackText('')
        setLoading(false)
        setError(null)
    }, [props.tool.id])

    if (!permission || permission.status !== 'pending') return null
    if (!isAskUserQuestionToolName(props.tool.name)) return null

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

    const mode: 'single' | 'multi' = questions[clampedStep]?.multiSelect ? 'multi' : 'single'

    const validateQuestion = (idx: number): string[] | null => {
        if (questions.length === 0) {
            const text = fallbackText.trim()
            return text.length > 0 ? [text] : null
        }

        const question = questions[idx]
        if (!question) return null
        const answers = computeAnswersForQuestion(
            question,
            selectedByQuestion[idx] ?? [],
            otherSelectedByQuestion[idx] ?? false,
            otherTextByQuestion[idx] ?? ''
        )
        return answers.length > 0 ? answers : null
    }

    const submit = async () => {
        if (loading) return

        const answers: Record<string, string[]> = {}
        if (questions.length === 0) {
            const a0 = validateQuestion(0)
            if (!a0) {
                setError(t('tool.selectOption'))
                return
            }
            answers['0'] = a0
        } else {
            for (let i = 0; i < questions.length; i += 1) {
                const a = validateQuestion(i)
                if (!a) {
                    setError(t('tool.selectOption'))
                    setStep(i)
                    return
                }
                answers[String(i)] = a
            }
        }

        setLoading(true)
        await run(() => props.api.approvePermission(props.sessionId, permission.id, { answers }), 'success')
        setLoading(false)
    }

    const next = () => {
        if (questions.length === 0) return
        const a = validateQuestion(clampedStep)
        if (!a) {
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

    const toggleOption = (qIdx: number, optIdx: number) => {
        const q = questions[qIdx]
        if (!q) return
        haptic.selection()

        setSelectedByQuestion((prevSelected) => {
            const nextSelected = prevSelected.slice()
            const cur = new Set(nextSelected[qIdx] ?? [])
            if (q.multiSelect) {
                if (cur.has(optIdx)) cur.delete(optIdx)
                else cur.add(optIdx)
                nextSelected[qIdx] = Array.from(cur).sort((a, b) => a - b)
                return nextSelected
            }

            nextSelected[qIdx] = [optIdx]
            return nextSelected
        })

        if (!q.multiSelect) {
            setOtherSelectedByQuestion((prevOther) => {
                const nextOther = prevOther.slice()
                nextOther[qIdx] = false
                return nextOther
            })
        }
    }

    const toggleOther = (qIdx: number) => {
        const q = questions[qIdx]
        if (!q) return
        haptic.selection()

        if (!q.multiSelect) {
            setSelectedByQuestion((prevSelected) => {
                const nextSelected = prevSelected.slice()
                nextSelected[qIdx] = []
                return nextSelected
            })
            setOtherSelectedByQuestion((prevOther) => {
                const nextOther = prevOther.slice()
                nextOther[qIdx] = true
                return nextOther
            })
            return
        }

        setOtherSelectedByQuestion((prevOther) => {
            const nextOther = prevOther.slice()
            nextOther[qIdx] = !nextOther[qIdx]
            return nextOther
        })
    }

    const updateOtherText = (qIdx: number, value: string) => {
        setOtherTextByQuestion((prevText) => {
            const nextText = prevText.slice()
            nextText[qIdx] = value
            return nextText
        })
        if (value.trim().length > 0) {
            setOtherSelectedByQuestion((prevOther) => {
                const nextOther = prevOther.slice()
                nextOther[qIdx] = true
                return nextOther
            })
        }
    }

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

            {questions.length === 0 ? (
                <div className="mt-3">
                    <div className="text-sm text-[var(--app-hint)]">
                        {t('tool.askUserQuestion.fallback')}
                    </div>
                    <textarea
                        value={fallbackText}
                        onChange={(e) => setFallbackText(e.target.value)}
                        disabled={props.disabled || loading}
                        placeholder={t('tool.askUserQuestion.placeholder')}
                        className="mt-2 w-full min-h-[88px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                    />
                </div>
            ) : (
                <div className="mt-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            {questions[clampedStep]?.header ? (
                                <div className="flex items-center gap-2">
                                    <Badge variant="default">
                                        {questions[clampedStep].header}
                                    </Badge>
                                </div>
                            ) : null}
                            {questions[clampedStep]?.question ? (
                                <div className={cn(
                                    "text-sm text-[var(--app-fg)] break-words",
                                    questions[clampedStep]?.header ? "mt-2" : ""
                                )}>
                                    {questions[clampedStep].question}
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="mt-3 flex flex-col gap-1">
                        {questions[clampedStep].options.map((opt, optIdx) => {
                            const selected = (selectedByQuestion[clampedStep] ?? []).includes(optIdx)
                            return (
                                <OptionRow
                                    key={optIdx}
                                    checked={selected}
                                    mode={mode}
                                    disabled={props.disabled || loading}
                                    title={opt.label}
                                    description={opt.description}
                                    onClick={() => toggleOption(clampedStep, optIdx)}
                                />
                            )
                        })}

                        <OptionRow
                            checked={otherSelectedByQuestion[clampedStep] ?? false}
                            mode={mode}
                            disabled={props.disabled || loading}
                            title={t('tool.other')}
                            description={t('tool.otherDescription')}
                            onClick={() => toggleOther(clampedStep)}
                        />

                        {(otherSelectedByQuestion[clampedStep] ?? false) ? (
                            <textarea
                                value={otherTextByQuestion[clampedStep] ?? ''}
                                onChange={(e) => updateOtherText(clampedStep, e.target.value)}
                                disabled={props.disabled || loading}
                                placeholder={t('tool.askUserQuestion.otherPlaceholder')}
                                className="mt-2 w-full min-h-[88px] resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent disabled:opacity-50"
                            />
                        ) : null}
                    </div>
                </div>
            )}

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
