import { MessagePrimitive, useAuiState, type TextMessagePart } from '@assistant-ui/react'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { PeerSenderChip } from '@/components/AssistantChat/messages/PeerSenderChip'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const elementId = getConversationMessageAnchorId(messageId)
    const text = useAuiState((s) => {
        if (s.message.role !== 'user') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    const status = useAuiState((s) => {
        if (s.message.role !== 'user') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.status
    })
    const localId = useAuiState((s) => {
        if (s.message.role !== 'user') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const attachments = useAuiState((s) => {
        if (s.message.role !== 'user') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const peerDelivery = useAuiState((s) => {
        if (s.message.role !== 'user') {
            return { isPeer: false, sourceId: null as string | null, sourceName: null as string | null }
        }
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.sentFrom !== 'peer') {
            return { isPeer: false, sourceId: null, sourceName: null }
        }
        const id = custom.peer?.sourceSessionId
        const name = custom.peer?.sourceName
        return {
            isPeer: true,
            sourceId: typeof id === 'string' && id.trim() ? id.trim() : null,
            sourceName: typeof name === 'string' && name.trim() ? name.trim() : null
        }
    })
    const isPeerDelivery = peerDelivery.isPeer
    const peerSourceId = peerDelivery.sourceId
    const peerSourceName = peerDelivery.sourceName
    const isCliOutput = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const steered = useAuiState(({ message }) => (
        message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.steered === true)
    const cliText = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined
    const showStatus = shouldShowMessageStatus(status)

    const history = ctx.metadata?.capabilities?.conversationHistory
    const hasNativePoint = typeof localId === 'string'
        && localId.length > 0
        && ctx.metadata?.conversationHistoryPoints?.[localId] === true
    const isLatestBoundary = ctx.isLatestCompletedBoundary?.(messageId) === true
    const showCurrentFork = Boolean(
        history?.forkCurrent
        && isLatestBoundary
        && !ctx.disabled
        && ctx.onForkConversation
    )
    const showHistoricalFork = Boolean(
        history?.forkAtMessage
        && hasNativePoint
        && !isLatestBoundary
        && !ctx.disabled
        && ctx.onForkConversation
    )
    const showFork = showCurrentFork || showHistoricalFork
    const showRewind = Boolean(
        history?.rewindToMessage
        && hasNativePoint
        && !ctx.disabled
        && ctx.onRewindConversation
    )

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root
                id={elementId}
                data-hapi-message-role="user"
                className="happy-message scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-hidden"
            >
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                    <MessageActions align="end" copyText={cliText} messageElementId={elementId} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <MessagePrimitive.Root
            id={elementId}
            data-hapi-message-role="user"
            className="happy-message flex flex-col items-end scroll-mt-4"
        >
            <div className={getUserBubbleClassName(status)}>
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {isPeerDelivery ? (
                            <div className="mb-1.5">
                                <PeerSenderChip
                                    sourceSessionId={peerSourceId}
                                    sourceName={peerSourceName}
                                />
                            </div>
                        ) : null}
                        {hasText ? <UserBubbleContent text={text} /> : null}
                        {hasAttachments ? <MessageAttachments attachments={attachments} /> : null}
                    </div>
                    {showStatus && (
                        <div className="happy-message-actions-first-line flex shrink-0 items-center gap-1">
                            {showStatus ? <MessageStatusIndicator status={status} onRetry={onRetry} /> : null}
                        </div>
                    )}
                </div>
                {steered ? (
                    <span
                        title={t('queuedMessages.steeredBadgeTitle')}
                        className="mt-1 inline-flex items-center gap-0.5 text-[10px] leading-none text-[var(--app-hint)]"
                    >
                        {t('queuedMessages.steeredBadge')}
                    </span>
                ) : null}
            </div>
            <MessageActions
                align="end"
                copyText={hasText ? text : undefined}
                messageElementId={elementId}
                showFork={showFork}
                showRewind={showRewind}
                historyActionPending={ctx.historyActionPending}
                onFork={showCurrentFork
                    ? () => ctx.onForkConversation!()
                    : showHistoricalFork && localId
                        ? () => ctx.onForkConversation!(localId)
                        : undefined}
                onRewind={showRewind && localId
                    ? () => ctx.onRewindConversation!(localId)
                    : undefined}
            />
        </MessagePrimitive.Root>
    )
}
