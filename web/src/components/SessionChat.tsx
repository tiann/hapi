import type { ApiClient } from '@/api/client'
import type { AgentStateRequest, DecryptedMessage, Session } from '@/types/api'
import { Button } from '@/components/ui/button'
import { SessionHeader } from '@/components/SessionHeader'
import { PermissionPanel } from '@/components/PermissionPanel'
import { MessageBubble } from '@/components/MessageBubble'
import { ChatInput } from '@/components/ChatInput'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'

function getFirstPendingRequest(session: Session): { requestId: string; request: AgentStateRequest } | null {
    const requests = session.agentState?.requests ?? null
    if (!requests) return null

    const entries = Object.entries(requests)
    if (entries.length === 0) return null

    const [requestId, request] = entries[0]
    return { requestId, request }
}

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => void
    onSend: (text: string) => void
    onRetryMessage?: (localId: string) => void
}) {
    const pending = getFirstPendingRequest(props.session)
    const scrollRef = useScrollToBottom([props.messages.length])
    const controlsDisabled = !props.session.active

    return (
        <div className="flex h-full flex-col">
            <SessionHeader
                api={props.api}
                session={props.session}
                onBack={props.onBack}
                onRefresh={props.onRefresh}
            />

            {controlsDisabled ? (
                <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    Session is inactive. Controls are disabled.
                </div>
            ) : null}

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
                {props.messagesWarning ? (
                    <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                        {props.messagesWarning}
                    </div>
                ) : null}

                {props.hasMoreMessages ? (
                    <div className="mb-3">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                        >
                            {props.isLoadingMoreMessages ? 'Loading…' : 'Load older'}
                        </Button>
                    </div>
                ) : null}

                {props.isLoadingMessages ? (
                    <div className="text-sm text-[var(--app-hint)]">Loading…</div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {props.messages.map((m) => (
                            <MessageBubble
                                key={m.id}
                                message={m}
                                onRetry={m.localId && m.status === 'failed' && props.onRetryMessage
                                    ? () => props.onRetryMessage!(m.localId!)
                                    : undefined
                                }
                            />
                        ))}
                    </div>
                )}
            </div>

            {pending ? (
                <PermissionPanel
                    api={props.api}
                    sessionId={props.session.id}
                    requestId={pending.requestId}
                    request={pending.request}
                    disabled={controlsDisabled}
                    onDone={props.onRefresh}
                />
            ) : null}

            <ChatInput
                disabled={props.isSending || controlsDisabled}
                onSend={props.onSend}
            />
        </div>
    )
}
