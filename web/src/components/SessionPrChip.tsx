import { useId } from 'react'
import type { ExternalRef, GithubPrExternalRef } from '@/types/api'
import {
    DEFAULT_PR_CHIP_DISPLAY,
    formatGithubPrChipLabel,
    getPrimaryGithubPrRef,
    resolveGithubPrChipDisplay,
    type PrChipDisplayProfile,
    type PrChipTone,
    type ResolvedPrChipDisplay
} from '@hapi/protocol'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'
import { HoverTooltip } from '@/components/HoverTooltip'

type TFunc = (key: string, params?: Record<string, string | number>) => string

export type SessionPrChipProps = {
    refs: readonly ExternalRef[] | null | undefined
    className?: string
    /** Injectable clock for tests (ms since epoch). */
    nowMs?: number
    /** Estate-overridable display profile (from GET /api/features). */
    displayProfile?: PrChipDisplayProfile
}

export { formatGithubPrChipLabel, resolveGithubPrChipDisplay }

function toneClass(tone: PrChipTone | undefined): string {
    switch (tone) {
        case 'ok':
            return 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
        case 'needs_work':
            return 'border-amber-500/50 text-amber-800 dark:text-amber-200'
        case 'pending':
            return 'border-sky-500/40 text-sky-700 dark:text-sky-300'
        case 'merged':
            return 'border-violet-500/40 text-violet-700 dark:text-violet-300'
        case 'unknown':
            return 'border-dashed border-[var(--app-border)] text-[var(--app-muted-fg)]'
        case 'muted':
            return 'border-[var(--app-border)] text-[var(--app-muted-fg)]'
        default:
            return 'border-[var(--app-border)] text-[var(--app-link)]'
    }
}

/**
 * Glyph + status body shared by chip tooltip and session action menus.
 * Tooltip uses `formatGithubPrChipTitle`; menus render glyph separately then body.
 */
export function formatGithubPrChipDetailParts(
    ref: GithubPrExternalRef,
    display: ResolvedPrChipDisplay,
    t: TFunc
): { glyph: string; detail: string } {
    const glyph = formatGithubPrChipLabel(ref, display)
    const identity = `${ref.repo}#${ref.number}`
    if (!display.hasSnapshot) return { glyph, detail: identity }
    const relative = typeof ref.statusCheckedAt === 'number'
        ? formatRelativeTime(ref.statusCheckedAt, t)
        : null
    const checked = relative ? ` · checked ${relative}` : ''
    const staleNote = display.stale ? ' · stale' : ''
    const shown = display.label ?? ref.estateCode ?? 'linked'
    const action = !display.stale && display.action ? ` — ${display.action}` : ''
    return { glyph, detail: `${identity} · ${shown}${checked}${staleNote}${action}` }
}

/** Same string as chip mouseover tooltip: `glyph owner/repo#N · status…`. */
export function formatGithubPrChipTitle(
    ref: GithubPrExternalRef,
    display: ResolvedPrChipDisplay,
    t: TFunc
): string {
    const { glyph, detail } = formatGithubPrChipDetailParts(ref, display, t)
    return `${glyph} ${detail}`
}

/**
 * Compact primary GitHub PR chip for session list rows.
 * Glyph stays compact; mouseover/focus on *this chip* reveals the same
 * detail string as the session action menu (emoji + status explanation).
 */
export function SessionPrChip(props: SessionPrChipProps) {
    const { t } = useTranslation()
    const tooltipId = useId()

    const primary = getPrimaryGithubPrRef(props.refs)
    if (!primary) return null

    const nowMs = props.nowMs ?? Date.now()
    const profile = props.displayProfile ?? DEFAULT_PR_CHIP_DISPLAY
    const display = resolveGithubPrChipDisplay(primary, profile, nowMs)
    const glyph = formatGithubPrChipLabel(primary, display)
    const detail = formatGithubPrChipTitle(primary, display, t)

    return (
        <HoverTooltip
            id={tooltipId}
            side="bottom"
            align="end"
            // Isolate hover to the chip — not the whole session row.
            hoverGroup="help"
            className={cn('relative z-20 shrink-0 overflow-visible', props.className)}
            tooltipClassName="max-w-[18rem] whitespace-normal"
            target={(
                <a
                    href={primary.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="session-pr-chip"
                    data-pr-tone={display.tone ?? 'unset'}
                    data-pr-stale={display.stale ? '1' : '0'}
                    aria-describedby={tooltipId}
                    title={detail}
                    aria-label={
                        display.label
                            ? t('session.item.prChipWithStatus', {
                                number: primary.number,
                                status: display.label
                            })
                            : t('session.item.prChip', { number: primary.number })
                    }
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    className={cn(
                        'inline-flex min-w-[1.35rem] shrink-0 items-center justify-center rounded-md border',
                        'bg-[var(--app-subtle-bg)] px-1 py-0.5 text-[12px] font-medium leading-none',
                        'hover:opacity-90 focus-visible:outline-none',
                        'focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        toneClass(display.tone)
                    )}
                >
                    {glyph}
                </a>
            )}
        >
            <span className="block font-medium">{detail}</span>
        </HoverTooltip>
    )
}
