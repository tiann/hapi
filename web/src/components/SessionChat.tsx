import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, ModelMode, PermissionMode, Session } from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { Button } from '@/components/ui/button'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { SessionHeader } from '@/components/SessionHeader'
import { usePlatform } from '@/hooks/usePlatform'

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
    const { haptic } = usePlatform()
    const controlsDisabled = !props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
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

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await props.api.setPermissionMode(props.session.id, mode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan')
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [props.api, props.session.id, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await props.api.setModelMode(props.session.id, mode as 'default' | 'sonnet' | 'opus')
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [props.api, props.session.id, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await props.api.abortSession(props.session.id)
        props.onRefresh()
    }, [props.api, props.session.id, props.onRefresh])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: props.onSend,
        onAbort: handleAbort
    })

    const threadHeader = useMemo(() => {
        if (props.isLoadingMessages) {
            return (
                <div className="text-sm text-[var(--app-hint)]">
                    Loading…
                </div>
            )
        }

        return (
            <>
                {props.messagesWarning ? (
                    <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
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

                {import.meta.env.DEV && normalizedMessages.length === 0 && props.messages.length > 0 ? (
                    <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                        Message normalization returned 0 items for {props.messages.length} messages (see `web/src/chat/normalize.ts`).
                    </div>
                ) : null}
            </>
        )
    }, [
        props.isLoadingMessages,
        props.messagesWarning,
        props.hasMoreMessages,
        props.isLoadingMoreMessages,
        props.onLoadMore,
        props.messages.length,
        normalizedMessages.length
    ])

    return (
        <div className="flex h-full flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
            />

            {controlsDisabled ? (
                <div className="bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    Session is inactive. Controls are disabled.
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={controlsDisabled}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        header={threadHeader}
                    />

                    <HappyComposer
                        disabled={props.isSending || controlsDisabled}
                        permissionMode={props.session.permissionMode}
                        modelMode={props.session.modelMode}
                        active={props.session.active}
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        contextSize={reduced.latestUsage?.contextSize}
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelModeChange={handleModelModeChange}
                    />
                </div>
            </AssistantRuntimeProvider>
        </div>
    )
}
