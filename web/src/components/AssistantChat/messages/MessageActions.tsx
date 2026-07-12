import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CopyIcon, InfoIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import { MessageMetadata, buildMessageMetadataLabels, type MessageMetadataProps } from './MessageMetadata'
import { MessageTimestamp } from './MessageTimestamp'
import { cn } from '@/lib/utils'

type MessageActionsProps = {
    align: 'start' | 'end'
    copyText?: string
    metadata?: Omit<MessageMetadataProps, 'className'>
}

export function MessageActions({ align, copyText, metadata }: MessageActionsProps) {
    const { copied, copy } = useCopyToClipboard()
    const { t } = useTranslation()
    const canCopy = Boolean(copyText)
    const hasMetadata = metadata ? buildMessageMetadataLabels(metadata).length > 0 : false

    return (
        <div
            className={cn(
                'happy-message-actions mt-1 flex h-5 items-center gap-1',
                align === 'end' ? 'justify-end' : 'justify-start',
                !canCopy && 'happy-message-actions-desktop-only-row'
            )}
        >
            {align === 'end' ? <DesktopTimestamp /> : null}
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
            {hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
            {align === 'start' ? <DesktopTimestamp /> : null}
        </div>
    )
}

function DesktopTimestamp() {
    return (
        <span className="happy-message-actions-desktop-only ml-1 items-center">
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
                    className="happy-message-actions-desktop-only h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
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
