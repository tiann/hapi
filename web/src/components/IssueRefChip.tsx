import type { ExternalRef } from '@hapi/protocol/types'
import { chipBaseClass, chipIdleClass } from '@/components/filterChipStyles'
import { cn } from '@/lib/utils'
import { BoardIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import type { BoardItemMatch } from '@/lib/externalRefs'

/**
 * Always-on chip linking a session to the GitHub issue it was spawned from or
 * linked to (hapi#235/#238). The `#N` link always opens GitHub directly,
 * unchanged — `boardMatch` adds a second, small in-app affordance alongside
 * it when that same issue is also tracked on a configured board (operator
 * follow-up to hapi#238, via Fekko: the board -> session jump already
 * existed; a session's issue chip gave no indication the issue was on a
 * board at all, let alone a way back). A separate button rather than
 * repurposing the `#N` link's own click, so "open on GitHub" stays exactly
 * as reliable as it always was for anyone not using Boards.
 */
export function IssueRefChip(props: {
    ref: ExternalRef
    className?: string
    boardMatch?: BoardItemMatch | null
    onOpenBoardItem?: (match: BoardItemMatch) => void
}) {
    const { ref, boardMatch, onOpenBoardItem } = props
    const { t } = useTranslation()
    return (
        <span className={cn('inline-flex shrink-0 items-center gap-1', props.className)}>
            <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${ref.repo}#${ref.number}`}
                data-testid="issue-ref-chip"
                className={cn(chipBaseClass, chipIdleClass, 'h-5 shrink-0 px-1.5 font-mono text-[11px] leading-none')}
            >
                #{ref.number}
            </a>
            {boardMatch && onOpenBoardItem ? (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation()
                        onOpenBoardItem(boardMatch)
                    }}
                    title={t('sessions.issueChip.openOnBoard', { board: boardMatch.boardLabel })}
                    aria-label={t('sessions.issueChip.openOnBoard', { board: boardMatch.boardLabel })}
                    data-testid="issue-ref-chip-board-link"
                    className={cn(chipBaseClass, chipIdleClass, 'h-5 w-5 shrink-0 p-0.5')}
                >
                    <BoardIcon className="h-3 w-3" />
                </button>
            ) : null}
        </span>
    )
}
