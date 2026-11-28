import { useState } from 'react'
import { MessagePrimitive, useAuiState, type TextMessagePart } from '@assistant-ui/react'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { PeerSenderChip } from '@/components/AssistantChat/messages/PeerSenderChip'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageActions, isConversationHistoryBlocked } from '@/components/AssistantChat/messages/MessageActions'
import { useTranslation } from '@/lib/use-translation'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const { t } = useTranslation()
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const threadIsRunning = useAuiState((s) => s.thread.isRunning)
    const elementId = getConversationMessageAnchorId(messageId)
    const sourceMessageIds = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.sourceMessageIds
    })
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
    const invokedAt = useAuiState((s) => (
        s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.invokedAt)
    const sourceMessageId = useAuiState((s) => (
        s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.sourceMessageId)
    const isTranscriptEcho = useAuiState((s) => (
        s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.isTranscriptEcho === true)
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
    const isSystemNote = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'system-note'
    })
    const translatedFrom = useAuiState((s) => (
        s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.translatedFrom)
    const translationFailed = useAuiState((s) => (
        s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.translationFailed === true)
    const [showSentText, setShowSentText] = useState(false)
    const steered = useAuiState(({ message }) => (
        message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    )?.steered === true)
    const cliText = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    if (role !== 'user') return null
    if (isSystemNote) {
        return (
            <MessagePrimitive.Root
                id={elementId}
                data-hapi-message-role="system-note"
                className="happy-message scroll-mt-4 px-1"
            >
                <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                    <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true">•</span>
                        <span className="whitespace-pre-wrap text-left">{text}</span>
                        <MessageTimestamp className="text-[10px]" />
                    </span>
                </div>
            </MessagePrimitive.Root>
        )
    }
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined
    const showStatus = shouldShowMessageStatus(status)

    const historyLocked = isConversationHistoryBlocked(ctx.metadata)
    const history = historyLocked
        ? undefined
        : ctx.allowInactiveFork
            ? { forkCurrent: true, forkAtMessage: true, rewindToMessage: false }
            : ctx.metadata?.capabilities?.conversationHistory
    const hasNativePoint = typeof localId === 'string'
        && localId.length > 0
        && ctx.metadata?.conversationHistoryPoints?.[localId] === true
    const isLatestBoundary = ctx.isLatestCompletedBoundary?.(messageId) === true
    const forkEnabled = !ctx.disabled || ctx.allowInactiveFork === true
    // A user-only finished turn can be the latest completed boundary while
    // another turn runs. Branch before that user turn, never from the live tail.
    const runningCodex = threadIsRunning && ctx.metadata?.flavor === 'codex'
    const showCurrentFork = Boolean(
        history?.forkCurrent
        && isLatestBoundary
        && !runningCodex
        && forkEnabled
        && ctx.onForkConversation
    )
    const showHistoricalFork = Boolean(
        history?.forkAtMessage
        && hasNativePoint
        && (!isLatestBoundary || runningCodex)
        && forkEnabled
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
                data-hapi-source-message-ids={sourceMessageIds?.join(' ') || undefined}
                className="happy-message scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-hidden"
            >
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                    <MessageActions align="end" copyText={cliText} messageElementId={elementId} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const importMarker = '\n\nNEW_USER_INSTRUCTION:\n\n'
    const importIndex = ctx.metadata?.conversationBranch && localId?.startsWith('branch-')
        ? text.indexOf(importMarker) : -1
    const importedReference = importIndex >= 0 ? text.slice(0, importIndex) : null
    const sentText = importIndex >= 0 ? text.slice(importIndex + importMarker.length) : text
    // Translated prompts show what the user typed by default; the English that
    // actually reached the agent is one tap away.
    const isTranslated = typeof translatedFrom === 'string' && importIndex < 0
    const visibleText = isTranslated && !showSentText ? translatedFrom : sentText
    const hasText = visibleText.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <MessagePrimitive.Root
            id={elementId}
            data-hapi-message-role="user"
            data-hapi-source-message-ids={sourceMessageIds?.join(' ') || undefined}
            className="happy-message flex flex-col items-end scroll-mt-4"
        >
            <div className={getUserBubbleClassName(status)}>
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {isPeerDelivery ? (
                            <div className="mb-1.5">
                                <PeerSenderChip
                                    sourceSessionId={peerSourceId ?? undefined}
                                    sourceName={peerSourceName ?? undefined}
                                />
                            </div>
                        ) : null}
                        {hasText ? <UserBubbleContent text={visibleText} /> : null}
                        {importedReference ? <details className="mt-2 text-xs">
                            <summary className="cursor-pointer">{t('branch.importedReference')}</summary>
                            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{importedReference}</pre>
                        </details> : null}
                        {hasAttachments ? <MessageAttachments attachments={attachments} /> : null}
                    </div>
                    {showStatus && (
                        <div className="happy-message-actions-first-line flex shrink-0 items-center gap-1">
                            {showStatus ? <MessageStatusIndicator status={status} onRetry={onRetry} /> : null}
                        </div>
                    )}
                </div>
                {isTranslated ? (
                    <button
                        type="button"
                        aria-pressed={showSentText}
                        onClick={() => setShowSentText((value) => !value)}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] leading-none text-[var(--app-hint)] hover:underline"
                    >
                        <span>{t('chat.translated.label')}</span>
                        <span aria-hidden="true">·</span>
                        <span>{t(showSentText ? 'chat.translated.showOriginal' : 'chat.translated.showSent')}</span>
                    </button>
                ) : translationFailed ? (
                    <span
                        title={t('chat.translated.failedTitle')}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] leading-none text-[var(--app-hint)]"
                    >
                        {t('chat.translated.failed')}
                    </span>
                ) : status === 'sending' && ctx.inputTranslationEnabled && !text.trimStart().startsWith('/') ? (
                    <span
                        role="status"
                        className="mt-1 inline-flex items-center gap-1 text-[10px] leading-none text-[var(--app-hint)]"
                    >
                        {t('chat.translated.pending')}
                    </span>
                ) : null}
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
                copyText={hasText ? (isTranslated ? visibleText : text) : undefined}
                messageElementId={elementId}
                onBranch={!historyLocked && ctx.onBranchConversation && !isTranscriptEcho && (localId || sourceMessageId) && invokedAt != null
                    ? () => localId ? ctx.onBranchConversation?.(localId) : ctx.onBranchConversation?.(undefined, sourceMessageId) : undefined}
                showFork={showFork}
                allowForkWhileRunning={showHistoricalFork && ctx.metadata?.flavor === 'codex'}
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
