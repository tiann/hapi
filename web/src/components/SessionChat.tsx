import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, ModelMode, PermissionMode, Session } from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/shared/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'

type NormalizedCacheEntry = {
    source: DecryptedMessage
    normalized: NormalizedMessage | null
}

function normalizeMessagesWithCache(
    messages: DecryptedMessage[],
    cache: Map<string, NormalizedCacheEntry>
): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = []
    const seen = new Set<string>()

    for (const message of messages) {
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
    pendingCount: number
    messagesVersion: number
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    onSlashEntry?: () => void
    isFetchingSlashCommands?: boolean
}) {
    const { haptic } = usePlatform()
    const sessionInactive = !props.session.active
    const normalizedCacheRef = useRef<Map<string, NormalizedCacheEntry>>(new Map())

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const { abortSession, switchSession, setPermissionMode, setModelMode } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor
    )

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
        }
        prevSessionIdRef.current = props.session.id

        return normalizeMessagesWithCache(props.messages, normalizedCacheRef.current)
    }, [props.messages, props.session.id])

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

    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await setModelMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [setModelMode, props.onRefresh, haptic])

    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleSend = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [props.onSend])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full flex-col">
            {props.session.teamState ? <TeamPanel teamState={props.session.teamState} /> : null}

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    <HappyComposer
                        disabled={props.isSending}
                        permissionMode={props.session.permissionMode}
                        modelMode={props.session.modelMode}
                        agentFlavor={agentFlavor}
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        contextSize={reduced.latestUsage?.contextSize}
                        controlledByUser={props.session.agentState?.controlledByUser === true}
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelModeChange={handleModelModeChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        sessionId={props.session.id}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        onSlashEntry={props.onSlashEntry}
                        isFetchingSlashCommands={props.isFetchingSlashCommands}
                    />
                </div>
            </AssistantRuntimeProvider>
        </div>
    )
}
