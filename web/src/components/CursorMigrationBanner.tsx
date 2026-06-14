/**
 * CursorMigrationBanner
 *
 * Surfaces the in-progress automatic legacy-stream-json → ACP migration to
 * the user, so the 15-20s "dark wait" while the migrator transplants the
 * store.db, spawns `agent acp`, replays notifications, and tears down the
 * verify probe doesn't read as "broken / nothing is happening".
 *
 * Visibility contract:
 *   - Renders when `session.metadata.cursorMigrationState === 'in_progress'`
 *   - Hub flips the flag → SSE `session-updated` → React Query cache → this
 *     re-renders within milliseconds (no client-side polling needed; the
 *     hub's session-updated channel is already real-time).
 *   - Hub clears the flag in the SAME metadata write that flips
 *     `cursorSessionProtocol` to 'acp' on success, so the banner disappears
 *     in the same render tick the chat re-renders as ACP — no flicker.
 *   - On failure / exception the hub clears the flag explicitly in the
 *     auto-migrate helper's finally, so the banner never gets stuck.
 *
 * Deliberately minimal — no fake progress bar (we don't have phase data and
 * a fake percentage would lie); just an indeterminate spinner + a short
 * explanation. UX A++ design notes are in PR #34's body.
 */

import type { Metadata } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

export function isCursorMigrationInProgress(metadata: Metadata | undefined | null): boolean {
    if (!metadata) return false
    return metadata.cursorMigrationState === 'in_progress'
}

/**
 * tiann/hapi#873: the migrator refused to transplant a legacy store -
 * either because the same cursorSessionId exists in multiple workspace-hash
 * drawers (`ambiguous_legacy_store`) or because the candidate's blob count
 * is dramatically lower than HAPI's known history (`size_mismatch`). The
 * hub promotes `cursorMigrationState` from 'in_progress' to 'ambiguous' so
 * this banner can switch from "Upgrading..." to a "manual review needed"
 * surface instead of disappearing silently.
 */
export function isCursorMigrationAmbiguous(metadata: Metadata | undefined | null): boolean {
    if (!metadata) return false
    return metadata.cursorMigrationState === 'ambiguous'
}

export function CursorMigrationBanner({ metadata }: { metadata: Metadata | undefined | null }) {
    const { t } = useTranslation()
    if (isCursorMigrationInProgress(metadata)) {
        return (
            <div className="px-3 pt-3" data-testid="cursor-migration-banner">
                <div
                    role="status"
                    aria-live="polite"
                    className="mx-auto flex w-full max-w-content items-start gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-text)]"
                >
                    <span
                        aria-hidden="true"
                        className="mt-0.5 inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="font-medium">{t('session.cursorMigration.banner.title')}</div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('session.cursorMigration.banner.body')}
                        </div>
                    </div>
                </div>
            </div>
        )
    }
    if (isCursorMigrationAmbiguous(metadata)) {
        return (
            <div className="px-3 pt-3" data-testid="cursor-migration-banner-ambiguous">
                <div
                    role="alert"
                    aria-live="polite"
                    className="mx-auto flex w-full max-w-content items-start gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-text)]"
                >
                    <span
                        aria-hidden="true"
                        className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-current"
                    >!</span>
                    <div className="min-w-0 flex-1">
                        <div className="font-medium">{t('session.cursorMigration.bannerAmbiguous.title')}</div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('session.cursorMigration.bannerAmbiguous.body')}
                        </div>
                    </div>
                </div>
            </div>
        )
    }
    return null
}
