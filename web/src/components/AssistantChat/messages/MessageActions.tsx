import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import { useAuiState } from '@assistant-ui/react'
import { CheckIcon, CopyIcon, ForkIcon, InfoIcon, RewindIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import { MessageMetadata, buildMessageMetadataLabels, type MessageMetadataProps } from './MessageMetadata'
import { MessageTimestamp } from './MessageTimestamp'
import { cn } from '@/lib/utils'
import { ShareTurnButton } from './ShareTurnButton'
import type { HappyRuntimeExtras } from '@/lib/assistant-runtime'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export type MessageHistoryAction = {
    kind: 'forkCurrent' | 'forkAtMessage' | 'rewind'
    messageLocalId?: string
}

type MessageActionsProps = {
    align: 'start' | 'end'
    copyText?: string
    metadata?: Omit<MessageMetadataProps, 'className'>
    messageElementId?: string
    showFork?: boolean
    showRewind?: boolean
    historyActionPending?: boolean
    onFork?: () => Promise<void>
    onRewind?: () => Promise<void>
}

type MessageActionsAuiState = {
    message: { id: string }
    thread?: {
        isRunning?: boolean
        extras?: unknown
    } | null
}

/**
 * Primitive selectors for `useAuiState` / `useSyncExternalStore`.
 * Must return booleans (or other Object.is-stable values) — never a fresh
 * object — or React hits max update depth (#185). See issue #1380 / #1306.
 *
 * @internal Exported for unit testing.
 */
export function selectHideShareButton(state: MessageActionsAuiState): boolean {
    const extras = state.thread?.extras as HappyRuntimeExtras | undefined
    const isRunning = state.thread?.isRunning ?? false
    return extras?.shareHiddenByMessageId.has(state.message.id) ?? isRunning
}

/** @internal Exported for unit testing. */
export function selectThreadIsRunning(state: MessageActionsAuiState): boolean {
    return state.thread?.isRunning ?? false
}

export function MessageActions({
    align,
    copyText,
    metadata,
    messageElementId,
    showFork = false,
    showRewind = false,
    historyActionPending = false,
    onFork,
    onRewind
}: MessageActionsProps) {
    const { copied, copy } = useCopyToClipboard()
    const { t } = useTranslation()
    // Split into two primitive selectors. A single object-returning selector
    // allocates a new snapshot every call and trips React #185 via
    // useSyncExternalStore (issue #1380, regression from #1306).
    const hideShareButton = useAuiState((state) => selectHideShareButton(state))
    const threadIsRunning = useAuiState((state) => selectThreadIsRunning(state))
    const canCopy = Boolean(copyText)
    const hasMetadata = metadata ? buildMessageMetadataLabels(metadata).length > 0 : false
    const [forkOpen, setForkOpen] = useState(false)
    const [rewindOpen, setRewindOpen] = useState(false)
    const [forkPending, setForkPending] = useState(false)
    const [rewindPending, setRewindPending] = useState(false)
    const actionsLocked = historyActionPending || forkPending || rewindPending || threadIsRunning

    const shareButton = messageElementId && !hideShareButton ? (
        <ShareTurnButton
            messageElementId={messageElementId}
            fallbackText={copyText}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
        />
    ) : null

    const historyButtons = (
        <>
            {showFork && onFork ? (
                <button
                    type="button"
                    title={t('message.fork')}
                    aria-label={t('message.fork')}
                    disabled={actionsLocked}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                    onClick={() => setForkOpen(true)}
                >
                    <ForkIcon className="h-3.5 w-3.5" />
                </button>
            ) : null}
            {showRewind && onRewind ? (
                <button
                    type="button"
                    title={t('message.rewind')}
                    aria-label={t('message.rewind')}
                    disabled={actionsLocked}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                    onClick={() => setRewindOpen(true)}
                >
                    <RewindIcon className="h-3.5 w-3.5" />
                </button>
            ) : null}
        </>
    )

    return (
        <>
            <div
                className={cn(
                    'happy-message-actions mt-1 flex h-5 items-center gap-1',
                    align === 'end' ? 'justify-end' : 'justify-start'
                )}
            >
                {align === 'end' ? <DesktopTimestamp /> : null}
                {align === 'end' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
                {align === 'end' ? shareButton : null}
                {canCopy ? (
                    <button
                        type="button"
                        title={copied ? t('message.copied') : t('message.copy')}
                        aria-label={copied ? t('message.copied') : t('message.copy')}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        onClick={() => copy(copyText!)}
                    >
                        {copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                ) : null}
                {historyButtons}
                {align === 'start' ? shareButton : null}
                {align === 'start' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
                {align === 'start' ? <DesktopTimestamp /> : null}
            </div>

            <ConfirmDialog
                isOpen={forkOpen}
                onClose={() => {
                    if (!forkPending) setForkOpen(false)
                }}
                title={t('message.fork.confirmTitle')}
                description={t('message.fork.confirmDescription')}
                confirmLabel={t('message.fork')}
                confirmingLabel={t('message.fork.confirming')}
                isPending={forkPending}
                onConfirm={async () => {
                    if (!onFork) return
                    setForkPending(true)
                    try {
                        await onFork()
                        setForkOpen(false)
                    } finally {
                        setForkPending(false)
                    }
                }}
            />

            <ConfirmDialog
                isOpen={rewindOpen}
                onClose={() => {
                    if (!rewindPending) setRewindOpen(false)
                }}
                title={t('message.rewind.confirmTitle')}
                description={t('message.rewind.confirmDescription')}
                confirmLabel={t('message.rewind')}
                confirmingLabel={t('message.rewind.confirming')}
                isPending={rewindPending}
                destructive
                onConfirm={async () => {
                    if (!onRewind) return
                    setRewindPending(true)
                    try {
                        await onRewind()
                        setRewindOpen(false)
                    } finally {
                        setRewindPending(false)
                    }
                }}
            />
        </>
    )
}

function DesktopTimestamp() {
    return (
        <span className="inline-flex ml-1 items-center">
            <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
        </span>
    )
}

function MessageInfoPopover({ metadata }: { metadata: Omit<MessageMetadataProps, 'className'> }) {
    const { t } = useTranslation()
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    title={t('message.info')}
                    aria-label={t('message.info')}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    <InfoIcon className="h-3.5 w-3.5" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                >
                    <MessageMetadata {...metadata} />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
