import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { useMessages } from '@/hooks/queries/useMessages'
import { useDshModels } from '@/hooks/queries/useDshModels'
import { useDshSkills } from '@/hooks/queries/useDshSkills'
import { useDshAction } from '@/hooks/mutations/useDshAction'
import { useSession } from '@/hooks/queries/useSession'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useTranslation } from '@/lib/use-translation'
import {
    dshMessageId,
    dshMessageSeq,
    messageText,
    useDshSessionState
} from '@/lib/dshSessionState'
import type { DecryptedMessage } from '@/types/api'
import type { DshAction, DshStateSnapshot } from '@hapi/protocol'
import {
    DshApprovalPanel,
    DshGoalBar,
    DshJobsDock,
    DshModelPicker,
    DshPresetPicker,
    DshQueueDock,
    DshQuestionsDialog,
    DshSkillsPalette,
    DshSubagentsPanel
} from './DshPanels'
import { DshComposer } from './DshComposer'
import { DshToolCard } from './DshToolCard'

type DshSessionViewProps = {
    session: Session
    api: ApiClient | null
}

function isRawDshPayload(data: unknown): boolean {
    return typeof data === 'object' && data !== null
        && ((data as { type?: unknown }).type === 'dsh_native' || (data as { type?: unknown }).type === 'dsh_state')
}

function ConversationMessage({ message, onFork }: {
    message: DecryptedMessage
    onFork: (seq: number) => void
}) {
    const { t } = useTranslation()
    const record = message.content as { role?: string; content?: unknown } | null
    const role = record?.role ?? 'user'
    const content = record?.content
    const data = (typeof content === 'object' && content !== null && 'data' in (content as object))
        ? (content as { data?: unknown }).data
        : content
    const isUser = role === 'user'
    const seq = dshMessageSeq(message)

    if (isRawDshPayload(data)) {
        return null
    }

    const dataType = typeof data === 'object' && data !== null ? (data as { type?: string }).type : undefined

    if (dataType === 'error') {
        return (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {(data as { message?: string }).message ?? t('dsh.error.unknown')}
            </div>
        )
    }
    if (dataType === 'turn_complete') {
        return null
    }
    if (dataType === 'tool_call' || dataType === 'tool-call') {
        return (
            <DshToolCard
                id={(data as { id?: string; callId?: string }).id ?? (data as { callId?: string }).callId ?? 'unknown'}
                name={(data as { name?: string }).name ?? 'unknown'}
                input={(data as { input?: unknown }).input}
                status={(data as { status?: string }).status}
            />
        )
    }
    if (dataType === 'tool_result' || dataType === 'tool-call-result') {
        return (
            <DshToolCard
                id={(data as { id?: string }).id ?? (data as { callId?: string }).callId ?? 'unknown'}
                name=""
                output={(data as { output?: unknown }).output}
                isResult
                status={(data as { status?: string }).status ?? ((data as { is_error?: boolean }).is_error ? 'failed' : 'completed')}
            />
        )
    }
    if (dataType === 'reasoning') {
        const text = (data as { text?: string }).text ?? (data as { message?: string }).message ?? ''
        return (
            <details className="group rounded-md border border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-hint)]">
                <summary className="cursor-pointer select-none font-medium">
                    {t('dsh.reasoning')}
                </summary>
                <div className="mt-2 whitespace-pre-wrap font-mono">{text}</div>
            </details>
        )
    }
    const text = messageText(message)
    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--app-accent)] px-3 py-2 text-sm text-white">
                    <MarkdownRenderer content={text} />
                </div>
            </div>
        )
    }
    return (
        <div className="group relative">
            <div className="rounded-2xl rounded-bl-sm border border-[var(--app-border)] bg-[var(--app-card-bg)] px-3 py-2 text-sm">
                <MarkdownRenderer content={text} />
            </div>
            {typeof seq === 'number' ? (
                <button
                    type="button"
                    onClick={() => onFork(seq)}
                    className="absolute -right-2 -top-2 hidden rounded-full border border-[var(--app-border)] bg-[var(--app-card-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)] hover:text-[var(--app-fg)] group-hover:block"
                    title={t('dsh.forkAtMessage')}
                >
                    {t('dsh.fork')}
                </button>
            ) : null}
        </div>
    )
}

export function DshSessionView({ session, api }: DshSessionViewProps) {
    const { t } = useTranslation()
    const messages = useMessages(api, session.id)
    const { snapshot, latestNativeSeq } = useDshSessionState(messages.messages)
    const dshAction = useDshAction(api, session.id)
    const sessionQuery = useSession(api, session.id)
    const liveSession = sessionQuery.session ?? session
    const agentState = liveSession.agentState ?? {}

    const dispatch = (action: DshAction): Promise<unknown> => {
        return dshAction.mutateAsync(action).catch((error: unknown) => {
            // Surface dispatch failures through the dsh_state error path is
            // handled by the CLI error message; rethrow for button-level
            // feedback via alert-free inline state.
            console.error('[dsh] action failed', action.type, error)
            throw error
        })
    }

    const [forking, setForking] = useState<string | null>(null)
    const onFork = (seq: number) => {
        if (!api) return
        void dispatch({ type: 'fork', atSeq: seq }).then((result) => {
            const sessionId = (result as { result?: { sessionId?: string } }).result?.sessionId
            if (sessionId) {
                setForking(sessionId)
                // Navigate to the forked session after a short settle.
                window.setTimeout(() => {
                    window.location.href = `/sessions/${sessionId}`
                }, 300)
            }
        })
    }

    const questions = snapshot.questions ?? null
    const [composerText, setComposerText] = useState('')

    const visibleMessages = useMemo(
        () => messages.messages.filter((m) => !isRawDshPayload(m.content)),
        [messages.messages]
    )

    return (
        <div className="flex h-full flex-col">
            <DshSessionHeader
                session={liveSession}
                api={api}
                snapshot={snapshot}
                agentState={agentState}
            />
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 lg:flex-row lg:overflow-hidden">
                <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
                    {snapshot.goal?.objective ? <DshGoalBar snapshot={snapshot} dispatch={dispatch} /> : null}
                    <div className="flex flex-col gap-3">
                        {visibleMessages.map((message) => (
                            <ConversationMessage key={message.id} message={message} onFork={onFork} />
                        ))}
                    </div>
                    {visibleMessages.length === 0 ? (
                        <div className="py-10 text-center text-sm text-[var(--app-hint)]">
                            {t('dsh.emptyConversation')}
                        </div>
                    ) : null}
                    <DshApprovalPanel agentState={agentState} api={api} sessionId={session.id} />
                </div>
                <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
                    <DshModelPicker sessionId={session.id} api={api} snapshot={snapshot} dispatch={dispatch} />
                    <DshPresetPicker sessionId={session.id} api={api} dispatch={dispatch} />
                    <DshSkillsPalette sessionId={session.id} api={api} onInsert={(name) => setComposerText((prev) => `${prev}${prev ? ' ' : ''}/${name} `)} />
                    <DshQueueDock snapshot={snapshot} dispatch={dispatch} />
                    <DshJobsDock snapshot={snapshot} />
                    <DshSubagentsPanel sessionId={session.id} api={api} dispatch={dispatch} latestNativeSeq={latestNativeSeq} />
                </div>
            </div>
            <DshComposer
                api={api}
                sessionId={session.id}
                text={composerText}
                onTextChange={setComposerText}
                modelLabel={snapshot.model ? `${snapshot.model.model}` : undefined}
            />
            {questions ? (
                <DshQuestionsDialog
                    questions={questions}
                    dispatch={dispatch}
                    onClose={() => {/* resolved frames clear it */}}
                />
            ) : null}
            {forking ? (
                <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-sm text-white">
                    {t('dsh.forkingTo')} {forking}
                </div>
            ) : null}
        </div>
    )
}

function DshSessionHeader({ session, api, snapshot, agentState }: {
    session: Session
    api: ApiClient | null
    snapshot: DshStateSnapshot
    agentState: Record<string, unknown>
}) {
    const { t } = useTranslation()
    const requests = (agentState.requests ?? {}) as Record<string, { tool?: string }>
    const pendingCount = Object.keys(requests).length
    return (
        <div className="flex items-center gap-3 border-b border-[var(--app-border)] px-4 py-2 text-xs">
            <span className="font-medium">{t('dsh.sessionLabel')}</span>
            {snapshot.model ? (
                <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[var(--app-hint)]">
                    {snapshot.model.model}
                    {snapshot.model.reasoningEffort ? ` · ${snapshot.model.reasoningEffort}` : ''}
                </span>
            ) : null}
            <span className={`flex items-center gap-1 ${snapshot.running ? 'text-green-600 dark:text-green-400' : 'text-[var(--app-hint)]'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${snapshot.running ? 'bg-green-500' : 'bg-[var(--app-hint)]'}`} />
                {snapshot.running ? t('dsh.running') : t('dsh.idle')}
            </span>
            {pendingCount > 0 ? (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                    {t('dsh.pendingApprovals', { count: pendingCount })}
                </span>
            ) : null}
            {typeof snapshot.title === 'string' && snapshot.title.length > 0 ? (
                <span className="truncate text-[var(--app-hint)]">{snapshot.title}</span>
            ) : null}
        </div>
    )
}

export { dshMessageId }
