import { useId, useState } from 'react'
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
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const contentId = useId()
    const requests = Object.entries(props.requests ?? {})
        .filter(([, request]) => isAsyncRequestUserInput(request.tool, request.arguments))
        .sort(([aId, a], [bId, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || aId.localeCompare(bId))

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
                            className="mt-2 rounded-lg border border-[var(--app-border)] p-2"
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
