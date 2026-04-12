import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { openClawMessagesToChatBlocks } from '@/chat/openclaw'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { LoadingState } from '@/components/LoadingState'
import { OpenClawApprovalCard } from '@/components/OpenClawChat/OpenClawApprovalCard'
import { useResolveOpenClawApproval } from '@/hooks/mutations/useResolveOpenClawApproval'
import { useSendOpenClawMessage } from '@/hooks/mutations/useSendOpenClawMessage'
import { useOpenClawConversation } from '@/hooks/queries/useOpenClawConversation'
import { useOpenClawMessages } from '@/hooks/queries/useOpenClawMessages'
import { useOpenClawState } from '@/hooks/queries/useOpenClawState'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerVoiceHooksStore } from '@/realtime'

const noop = () => {}
const noopAsync = async () => {}

export function OpenClawChatPage() {
    const navigate = useNavigate()
    const { api } = useAppContext()
    const { t } = useTranslation()
    const voice = useVoiceOptional()
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const { conversation, isLoading: conversationLoading, error: conversationError } = useOpenClawConversation(api)
    const conversationId = conversation?.id ?? null
    const {
        messages,
        hasMore,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        messagesVersion,
        error: messagesError,
        loadMore,
        refetch: refetchMessages
    } = useOpenClawMessages(api, conversationId)
    const { state, isLoading: stateLoading, error: stateError, refetch: refetchState } = useOpenClawState(api, conversationId)
    const { sendMessage, isPending: isSending, error: sendError } = useSendOpenClawMessage(api)
    const {
        approve,
        deny,
        isPending: isResolvingApproval,
        error: approvalError
    } = useResolveOpenClawApproval(api)

    const handleSend = useCallback(async (text: string) => {
        if (!conversationId) return
        await sendMessage(conversationId, text)
        setForceScrollToken((token) => token + 1)
    }, [conversationId, sendMessage])

    const handleApprove = useCallback((requestId: string) => {
        if (!conversationId) return
        void approve(conversationId, requestId)
    }, [approve, conversationId])

    const handleDeny = useCallback((requestId: string) => {
        if (!conversationId) return
        void deny(conversationId, requestId)
    }, [conversationId, deny])

    useEffect(() => {
        registerVoiceHooksStore(
            () => null,
            () => []
        )
    }, [])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice || !conversationId) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(conversationId)
        }
    }, [voice, conversationId])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    const refreshOpenClaw = useCallback(() => {
        void refetchMessages()
        void refetchState()
    }, [refetchMessages, refetchState])

    const blocks = useMemo(
        () => openClawMessagesToChatBlocks(messages),
        [messages]
    )

    const runtime = useHappyRuntime({
        blocks,
        isSending,
        active: state?.connected ?? false,
        isRunning: state?.thinking ?? false,
        onSendMessage: handleSend,
        allowSendWhenInactive: false
    })

    const loading = conversationLoading || messagesLoading || stateLoading
    const error = conversationError ?? messagesError ?? stateError ?? sendError ?? approvalError

    if (loading && !conversationId) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <LoadingState label="Loading OpenClaw…" className="text-sm" />
            </div>
        )
    }

    if (!api) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <LoadingState label="Loading OpenClaw…" className="text-sm" />
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="mx-auto flex w-full max-w-content items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="text-xs uppercase tracking-[0.16em] text-[var(--app-hint)]">OpenClaw Channel</div>
                        <div className="truncate text-base font-semibold text-[var(--app-fg)]">
                            {conversation?.title ?? 'OpenClaw'}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions' })}
                            className="rounded-full border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)]"
                        >
                            Sessions
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/settings' })}
                            className="rounded-full border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)]"
                        >
                            {t('chat.settings')}
                        </button>
                    </div>
                </div>
                {error ? (
                    <div className="mx-auto mt-2 w-full max-w-content text-sm text-red-600">
                        {error}
                    </div>
                ) : null}
            </div>

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        api={api}
                        sessionId={conversationId ?? 'openclaw'}
                        metadata={null}
                        disabled={!state?.connected}
                        onRefresh={refreshOpenClaw}
                        onFlushPending={noop}
                        onAtBottomChange={noop}
                        isLoadingMessages={messagesLoading}
                        messagesWarning={null}
                        hasMoreMessages={hasMore}
                        isLoadingMoreMessages={messagesLoadingMore}
                        onLoadMore={loadMore}
                        pendingCount={0}
                        rawMessagesCount={messages.length}
                        normalizedMessagesCount={blocks.length}
                        messagesVersion={messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    {(state?.pendingApprovals?.length ?? 0) > 0 ? (
                        <div className="border-t border-[var(--app-border)] px-3 py-3">
                            <div className="mx-auto flex w-full max-w-content flex-col gap-3">
                                {state?.pendingApprovals?.map((approval) => (
                                    <OpenClawApprovalCard
                                        key={approval.id}
                                        approval={approval}
                                        disabled={isResolvingApproval}
                                        onApprove={() => handleApprove(approval.id)}
                                        onDeny={() => handleDeny(approval.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : null}

                    <HappyComposer
                        disabled={!conversationId || isSending || !state?.connected}
                        active={state?.connected ?? false}
                        thinking={state?.thinking ?? false}
                        agentState={null}
                        attachmentsEnabled={false}
                        enableAbort={false}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice && conversationId ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                    />
                </div>
            </AssistantRuntimeProvider>

            {voice ? (
                <RealtimeVoiceSession
                    api={api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                    getSession={() => null}
                    sendMessage={(_sessionId, message) => {
                        void handleSend(message)
                    }}
                    approvePermission={noopAsync}
                    denyPermission={noopAsync}
                />
            ) : null}
        </div>
    )
}
