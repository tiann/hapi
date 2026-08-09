import { useNavigate } from '@tanstack/react-router'
import {
    SESSION_MENTION_CHIP_CLASSNAME,
    formatSessionMentionChipLabel,
} from '@/lib/sessionMentionChip'
import { formatSessionMentionTooltip } from '@/lib/sessionReference'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export type PeerSenderChipProps = {
    sourceSessionId?: string | null
    sourceName?: string | null
}

/**
 * Peer-delivery sender identity — same `@title` chip chrome as rich-composer
 * session mentions so "who sent this" matches @ referencing (#1203).
 */
export function PeerSenderChip({ sourceSessionId, sourceName }: PeerSenderChipProps) {
    const navigate = useNavigate()
    const { t } = useTranslation()
    const id = sourceSessionId?.trim() || ''
    const title = sourceName?.trim() || ''

    if (!id) {
        return (
            <span
                className={cn(SESSION_MENTION_CHIP_CLASSNAME, 'text-[var(--app-hint)]')}
                data-hapi-peer-delivery="true"
                data-hapi-peer-unknown="true"
                title={t('message.peerFromUnknown')}
            >
                {t('message.peerUnknownChip')}
            </span>
        )
    }

    const label = formatSessionMentionChipLabel(title, id)
    const tip = formatSessionMentionTooltip(null, title, id)

    return (
        <button
            type="button"
            className={SESSION_MENTION_CHIP_CLASSNAME}
            data-hapi-peer-delivery="true"
            data-session-id={id}
            data-session-title={title || undefined}
            aria-label={tip.ariaLabel}
            title={tip.lines.join('\n')}
            onClick={() => {
                void navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: id },
                })
            }}
        >
            {label}
        </button>
    )
}
