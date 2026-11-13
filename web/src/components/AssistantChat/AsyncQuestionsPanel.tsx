import { useEffect, useId, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AgentState } from '@/types/api'
import type { ChatToolCall } from '@/chat/types'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAsyncRequestUserInput, parseRequestUserInputInput } from '@/components/ToolCard/requestUserInput'
import { useTranslation } from '@/lib/use-translation'

/** Read live requests, not the paginated transcript: old questions remain reachable. */
export function AsyncQuestionsPanel(props: {
    api: ApiClient
    sessionId: string
    requests: AgentState['requests']
    disabled: boolean
    onRefresh: () => void
    targetRequestId?: string
    targetVersion?: number
    onTargetConsumed?: () => void
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const [highlightedRequestId, setHighlightedRequestId] = useState<string | null>(null)
    const contentId = useId()
    const requestRefs = useRef(new Map<string, HTMLDetailsElement>())
    const highlightTimerRef = useRef<number | null>(null)
    const requests = Object.entries(props.requests ?? {})
        .filter(([, request]) => isAsyncRequestUserInput(request.tool, request.arguments))
        .sort(([aId, a], [bId, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || aId.localeCompare(bId))
    const requestIds = requests.map(([id]) => id).join('\u0000')

    useEffect(() => () => {
        if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current)
        }
    }, [])

    useEffect(() => {
        const targetRequestId = props.targetRequestId
        if (!targetRequestId || !requests.some(([id]) => id === targetRequestId)) return
        setExpanded(true)
        setHighlightedRequestId(targetRequestId)
        const openTimer = window.setTimeout(() => {
            const target = requestRefs.current.get(targetRequestId)
            if (!target) return
            target.open = true
            target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
            target.focus({ preventScroll: true })
            props.onTargetConsumed?.()
        }, 0)
        if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current)
        }
        highlightTimerRef.current = window.setTimeout(() => {
            setHighlightedRequestId(null)
            highlightTimerRef.current = null
        }, 1_800)
        return () => {
            window.clearTimeout(openTimer)
        }
    }, [props.onTargetConsumed, props.targetRequestId, props.targetVersion, requestIds])

    if (requests.length === 0) return null

    return (
        <section className="mx-auto mb-2 w-full max-w-content rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]" aria-label={t('chat.asyncQuestions.title')}>
            <button
                type="button"
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => setExpanded((value) => !value)}
            >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                <span className="min-w-0 flex-1 font-medium">{t('chat.asyncQuestions.title')}</span>
                <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 text-xs tabular-nums">{requests.length}</span>
            </button>
            {/* Keep forms mounted so collapsing never discards a draft. */}
            <div id={contentId} hidden={!expanded} className="max-h-[35dvh] overflow-y-auto overscroll-contain px-3 pb-3">
                <p className="text-xs text-[var(--app-hint)]">{t('chat.asyncQuestions.hint')}</p>
                {requests.map(([id, request]) => {
                    const tool: ChatToolCall = {
                        id,
                        name: request.tool,
                        input: request.arguments,
                        state: 'pending',
                        createdAt: request.createdAt ?? 0,
                        startedAt: null,
                        completedAt: null,
                        execStartedAt: null,
                        execCompletedAt: null,
                        description: null,
                        // Replies must use the request key, not the correlated toolCallId.
                        permission: { id, status: 'pending' }
                    }
                    return (
                        <details
                            key={`${props.sessionId}:${id}`}
                            ref={(element) => {
                                if (element) requestRefs.current.set(id, element)
                                else requestRefs.current.delete(id)
                            }}
                            data-pending-request-id={id}
                            tabIndex={-1}
                            className={`mt-2 rounded-lg border p-2 outline-none transition-shadow ${highlightedRequestId === id
                                ? 'border-[#FF9500] ring-2 ring-[#FF9500]/40'
                                : 'border-[var(--app-border)]'}`}
                        >
                            <summary className="cursor-pointer break-words text-sm font-medium">
                                {parseRequestUserInputInput(request.arguments).questions.map((question) => question.question).filter(Boolean).join(' · ') || t('tool.question')}
                            </summary>
                            <RequestUserInputFooter
                                api={props.api}
                                sessionId={props.sessionId}
                                tool={tool}
                                disabled={props.disabled}
                                onDone={props.onRefresh}
                            />
                        </details>
                    )
                })}
            </div>
        </section>
    )
}
