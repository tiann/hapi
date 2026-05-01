import { useCallback } from 'react'
import type { ApiClient } from '@/api/client'
import { SessionChat } from '@/components/SessionChat'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSession } from '@/hooks/queries/useSession'
import { useSkills } from '@/hooks/queries/useSkills'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import type { AttachmentMetadata } from '@/types/api'

export function EditorChatPanel(props: {
    api: ApiClient | null
    sessionId: string | null
    pendingDraftText?: string
    onDraftConsumed?: () => void
    onExpandDraft?: (text: string) => string
}) {
    const { session, isLoading, error, refetch: refetchSession } = useSession(props.api, props.sessionId)
    const messagesState = useMessages(props.api, props.sessionId)
    const agentType = session?.metadata?.flavor ?? 'claude'
    const slashCommands = useSlashCommands(props.api, props.sessionId, agentType)
    const skills = useSkills(props.api, props.sessionId)
    const { sendMessage, retryMessage, isSending } = useSendMessage(props.api, props.sessionId, {
        isSessionThinking: session?.thinking ?? false
    })

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) {
            return await skills.getSuggestions(query)
        }
        return await slashCommands.getSuggestions(query)
    }, [skills, slashCommands])

    const refreshSession = useCallback(() => {
        void refetchSession()
        void messagesState.refetch()
    }, [messagesState, refetchSession])

    if (!props.sessionId) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--app-hint)]">
                Select or create a session to chat
            </div>
        )
    }

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--app-hint)]">
                Loading chat...
            </div>
        )
    }

    if (error || !session || !props.api) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-red-500">
                {error ?? 'Chat unavailable'}
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionChat
                key={session.id}
                api={props.api}
                session={session}
                messages={messagesState.messages}
                messagesWarning={messagesState.warning}
                hasMoreMessages={messagesState.hasMore}
                isLoadingMessages={messagesState.isLoading}
                isLoadingMoreMessages={messagesState.isLoadingMore}
                isSending={isSending}
                pendingCount={messagesState.pendingCount}
                messagesVersion={messagesState.messagesVersion}
                onBack={() => {}}
                onRefresh={refreshSession}
                onLoadMore={messagesState.loadMore}
                onSend={(text: string, attachments?: AttachmentMetadata[]) => {
                    const expandedText = props.onExpandDraft ? props.onExpandDraft(text) : text
                    sendMessage(expandedText, attachments)
                }}
                onFlushPending={messagesState.flushPending}
                onAtBottomChange={messagesState.setAtBottom}
                onRetryMessage={retryMessage}
                autocompleteSuggestions={getAutocompleteSuggestions}
                availableSlashCommands={slashCommands.commands}
                compactMode={true}
                hideHeader={true}
                disableVoice={true}
                composerAppendText={props.pendingDraftText}
                onComposerAppendTextConsumed={props.onDraftConsumed}
            />
        </div>
    )
}
