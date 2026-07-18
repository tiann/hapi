import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { getExecutionControl, isCodexDesktopMirrorSession } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type {
    AttachmentMetadata,
    CodexCollaborationMode,
    DecryptedMessage,
    PermissionMode,
    Session,
    SlashCommand
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad } from '@/lib/codexSlashCommands'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { SessionHeader } from '@/components/SessionHeader'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useVoiceOptional } from '@/lib/voice-context'
import { shouldMountRealtimeVoiceSession } from '@/lib/voice-mount'
import { canChangeSessionPermissionMode } from '@/lib/session-config-controls'
import { registerSessionStore } from '@/realtime/realtimeClientTools'
import { registerVoiceHooksStore, voiceHooks } from '@/realtime/hooks/voiceHooks'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'

const LazyRealtimeVoiceSession = lazy(() => (
    import('@/realtime/RealtimeVoiceSession').then((mod) => ({ default: mod.RealtimeVoiceSession }))
))

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasNewerMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isLoadingNewerMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onLoadNewer: () => Promise<unknown>
    onReturnToLatest: () => Promise<unknown>
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void | Promise<void>
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    autocompleteSuggestionsVersion?: unknown
    availableSlashCommands?: readonly SlashCommand[]
    resolveAvailableSlashCommands?: () => Promise<readonly SlashCommand[]>
}) {
    const { haptic } = usePlatform()
    const { addToast } = useToast()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const [voiceSessionRequested, setVoiceSessionRequested] = useState(false)
    const voiceSessionReadyRef = useRef(false)
    const pendingVoiceStartSessionIdRef = useRef<string | null>(null)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const desktopMirrorSession = agentFlavor === 'codex' && isCodexDesktopMirrorSession({
        metadata: props.session.metadata,
        messages: props.messages
    })
    const executionControl = getExecutionControl(props.session.metadata)
    const desktopMirrorTakeoverRequired = desktopMirrorSession && executionControl?.owner !== 'hapi-runner'
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const {
        abortSession,
        switchSession,
        setPermissionMode,
        setCollaborationMode,
        setModel,
        setModelReasoningEffort,
        setServiceTier,
        setEffort
    } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor,
        codexCollaborationModeSupported
    )

    // Voice assistant integration
    const voice = useVoiceOptional()

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const startPendingVoice = useCallback(async () => {
        voiceSessionReadyRef.current = true
        const pendingSessionId = pendingVoiceStartSessionIdRef.current
        if (!voice || !pendingSessionId) {
            return
        }
        pendingVoiceStartSessionIdRef.current = null
        await voice.startVoice(pendingSessionId)
    }, [voice])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            pendingVoiceStartSessionIdRef.current = null
            await voice.stopVoice()
        } else {
            if (voiceSessionReadyRef.current) {
                await voice.startVoice(props.session.id)
                return
            }
            pendingVoiceStartSessionIdRef.current = props.session.id
            voice.setStatus('connecting')
            setVoiceSessionRequested(true)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
        }
        prevSessionIdRef.current = props.session.id

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
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleCollaborationModeChange = useCallback(async (mode: CodexCollaborationMode) => {
        try {
            await setCollaborationMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set collaboration mode:', e)
        }
    }, [setCollaborationMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelChange = useCallback(async (model: string | null) => {
        try {
            await setModel(model)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model:', e)
        }
    }, [setModel, props.onRefresh, haptic])

    const handleModelReasoningEffortChange = useCallback(async (modelReasoningEffort: string | null) => {
        try {
            await setModelReasoningEffort(modelReasoningEffort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model reasoning effort:', e)
        }
    }, [setModelReasoningEffort, props.onRefresh, haptic])

    const handleServiceTierChange = useCallback(async (serviceTier: string | null) => {
        try {
            await setServiceTier(serviceTier)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set service tier:', e)
        }
    }, [setServiceTier, props.onRefresh, haptic])

    const handleEffortChange = useCallback(async (effort: string | null) => {
        try {
            await setEffort(effort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort:', e)
        }
    }, [setEffort, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleViewFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleLoadRecentUserMessages = useCallback(async () => {
        const response = await props.api.getRecentUserMessages(props.session.id, { limit: 10 })
        return response.messages
    }, [props.api, props.session.id])

    const handleSend = useCallback(async (text: string, attachments?: AttachmentMetadata[]) => {
        if (agentFlavor === 'codex') {
            const unsupportedCommand = await findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad(
                text,
                props.availableSlashCommands ?? [],
                props.resolveAvailableSlashCommands
            )
            if (unsupportedCommand) {
                haptic.notification('error')
                addToast({
                    title: t('composer.codexSlashUnsupported.title'),
                    body: t('composer.codexSlashUnsupported.body', { command: `/${unsupportedCommand}` }),
                    sessionId: props.session.id,
                    url: `/sessions/${props.session.id}`
                })
                return
            }
        }

        await props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [
        agentFlavor,
        props.availableSlashCommands,
        props.resolveAvailableSlashCommands,
        props.onSend,
        props.session.id,
        addToast,
        haptic,
        t
    ])

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
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onViewFiles={props.session.metadata?.path ? handleViewFiles : undefined}
                api={props.api}
                onSessionDeleted={props.onBack}
            />

            {props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            {desktopMirrorTakeoverRequired ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        <div className="font-medium text-[var(--app-text)]">
                            {t('composer.codexDesktopSyncReadonly.title')}
                        </div>
                        <div className="mt-1">
                            {t('composer.codexDesktopSyncReadonly.body')}
                        </div>
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
                        hasNewerMessages={props.hasNewerMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        isLoadingNewerMessages={props.isLoadingNewerMessages}
                        onLoadMore={props.onLoadMore}
                        onLoadNewer={props.onLoadNewer}
                        onReturnToLatest={props.onReturnToLatest}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    <HappyComposer
                        key={props.session.id}
                        sessionId={props.session.id}
                        disabled={props.isSending}
                        permissionMode={props.session.permissionMode}
                        collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                        model={props.session.model}
                        modelReasoningEffort={agentFlavor === 'codex' ? props.session.modelReasoningEffort : undefined}
                        serviceTier={agentFlavor === 'codex' ? props.session.serviceTier : undefined}
                        effort={props.session.effort}
                        agentFlavor={agentFlavor}
                        grokModels={props.session.metadata?.grokCapabilities?.models}
                        grokEfforts={props.session.metadata?.grokCapabilities?.models
                            ?.find((model) => model.id === (props.session.model
                                ?? props.session.metadata?.grokCapabilities?.currentModel))?.efforts}
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        backgroundTaskCount={props.session.backgroundTaskCount}
                        contextSize={reduced.latestUsage?.contextSize}
                        controlledByUser={controlledByUser}
                        onCollaborationModeChange={
                            codexCollaborationModeSupported && props.session.active && !controlledByUser
                                ? handleCollaborationModeChange
                                : undefined
                        }
                        onPermissionModeChange={
                            canChangeSessionPermissionMode(props.session)
                                ? handlePermissionModeChange
                                : undefined
                        }
                        onModelChange={handleModelChange}
                        onModelReasoningEffortChange={
                            agentFlavor === 'codex' && props.session.active && !controlledByUser
                                ? handleModelReasoningEffortChange
                                : undefined
                        }
                        onServiceTierChange={
                            agentFlavor === 'codex' && props.session.active && !controlledByUser
                                ? handleServiceTierChange
                                : undefined
                        }
                        onEffortChange={handleEffortChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active && terminalSupported ? handleViewTerminal : undefined}
                        terminalUnsupported={props.session.active && !terminalSupported}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        autocompleteSuggestionsVersion={props.autocompleteSuggestionsVersion}
                        loadRecentUserMessages={handleLoadRecentUserMessages}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                    />
                </div>
            </AssistantRuntimeProvider>

            {/* Voice session component - renders nothing but initializes ElevenLabs */}
            {voice && shouldMountRealtimeVoiceSession(voice.status, voiceSessionRequested) && (
                <Suspense fallback={null}>
                    <LazyRealtimeVoiceSession
                        api={props.api}
                        micMuted={voice.micMuted}
                        onStatusChange={voice.setStatus}
                        onReady={startPendingVoice}
                    />
                </Suspense>
            )}
        </div>
    )
}
