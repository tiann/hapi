import { SessionLinkedIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

/**
 * The "a session already exists for this" affordance — shared between a
 * board card's compact badge and the detail pane's full-size "Open session"
 * action (hapi#238 operator audit: these used to look completely different
 * depending on where you clicked, same action, two identities). Not
 * pixel-identical (the card's row and the detail footer's button bar have
 * different layouts), but the same icon/accent/shape at both sizes so it
 * reads as the same affordance wherever it appears.
 */
export function SessionLinkedBadge(props: {
    onClick: () => void
    title: string
    ariaLabel: string
    label: string
    size?: 'sm' | 'md'
}) {
    const isSmall = props.size !== 'md'
    return (
        <button
            type="button"
            onClick={props.onClick}
            title={props.title}
            aria-label={props.ariaLabel}
            className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-link)] bg-[var(--app-link)]/10 font-medium text-[var(--app-link)] transition-colors hover:bg-[var(--app-link)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                isSmall ? 'h-6 px-2 text-[10px]' : 'h-9 px-4 text-sm'
            )}
        >
            <SessionLinkedIcon className={isSmall ? 'h-3 w-3' : 'h-4 w-4'} />
            {props.label}
        </button>
    )
}
