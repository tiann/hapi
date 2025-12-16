import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { Button } from '@/components/ui/button'
import { SessionHeader } from '@/components/SessionHeader'
import { MessageBubble } from '@/components/MessageBubble'
import { ChatBlockList } from '@/components/ChatBlockList'
import { ChatInput } from '@/components/ChatInput'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'

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
    const controlsDisabled = !props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())

    useEffect(() => {
        normalizedCacheRef.current.clear()
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [props.messages])

    const reduced = useMemo(() => reduceChatBlocks(normalizedMessages, props.session.agentState), [normalizedMessages, props.session.agentState])

    const [debugViewMode, setDebugViewMode] = useState<'reduced' | 'raw'>('reduced')
    const viewMode = import.meta.env.DEV ? debugViewMode : 'reduced'
    const scrollRef = useScrollToBottom([props.messages.length, reduced.blocks.length, viewMode])

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

            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[720px] p-3">
                    {props.messagesWarning ? (
                        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                            {props.messagesWarning}
                        </div>
                    ) : null}

                    {import.meta.env.DEV ? (
                        <div className="mb-2 flex items-center gap-2">
                            <Button
                                variant={viewMode === 'reduced' ? 'default' : 'secondary'}
                                size="sm"
                                onClick={() => setDebugViewMode('reduced')}
                            >
                                Reduced
                            </Button>
                            <Button
                                variant={viewMode === 'raw' ? 'default' : 'secondary'}
                                size="sm"
                                onClick={() => setDebugViewMode('raw')}
                            >
                                Raw
                            </Button>
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
                        <>
                            {import.meta.env.DEV && viewMode === 'reduced' && normalizedMessages.length === 0 && props.messages.length > 0 ? (
                                <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                                    Message normalization returned 0 items for {props.messages.length} messages (see `hapi/web/src/chat/normalize.ts`).
                                </div>
                            ) : null}

                            {viewMode === 'raw' ? (
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
                            ) : (
                                <ChatBlockList
                                    api={props.api}
                                    sessionId={props.session.id}
                                    metadata={props.session.metadata}
                                    disabled={controlsDisabled}
                                    onRefresh={props.onRefresh}
                                    blocks={reduced.blocks}
                                    onRetryMessage={props.onRetryMessage}
                                />
                            )}
                        </>
                    )}
                </div>
            </div>

            <ChatInput
                disabled={props.isSending || controlsDisabled}
                onSend={props.onSend}
            />
        </div>
    )
}
