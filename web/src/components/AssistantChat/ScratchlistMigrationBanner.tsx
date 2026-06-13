import { useTranslation } from '@/lib/use-translation'

/**
 * tiann/hapi#893 (scratchlist v2): one-time banner shown after a v2-
 * aware client migrates a session's localStorage entries to the hub.
 *
 * Visibility contract:
 *   - Renders whenever `migrationStatus === 'completed'`, which is
 *     sticky across reloads until the operator clicks dismiss (HAPI
 *     Bot, PR #896 follow-up - the previous behavior swallowed the
 *     banner if the user reloaded before clicking).
 *   - Operator-affirmative dismissal: clicking the dismiss button writes
 *     the per-session `hapi.scratchlist.v2.banner-dismissed.${id}` flag
 *     so the banner does not reappear on reload.
 *   - Mirrors the dismissal pattern of `CursorMigrationBanner.tsx` so
 *     the surface is familiar to operators.
 *
 * Copy explains what was migrated and confirms nothing was lost. We
 * deliberately do not show entry counts - the banner is informational,
 * not transactional, and a count would imply the operator should
 * verify, which we don't want them to feel they need to do.
 */
export function ScratchlistMigrationBanner({
    migrationStatus,
    onDismiss
}: {
    migrationStatus:
        | 'idle'
        | 'migrating'
        | 'completed'
        | 'dismissed'
    onDismiss: () => void
}) {
    const { t } = useTranslation()
    if (migrationStatus !== 'completed') {
        return null
    }
    return (
        <div className="px-3 pt-3" data-testid="scratchlist-migration-banner">
            <div
                role="status"
                aria-live="polite"
                className="mx-auto flex w-full max-w-content items-start gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-text)]"
            >
                <div className="min-w-0 flex-1">
                    <div className="font-medium">
                        {t('scratchlist.migrationBanner.title')}
                    </div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('scratchlist.migrationBanner.body')}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                    data-testid="scratchlist-migration-banner-dismiss"
                >
                    {t('scratchlist.migrationBanner.dismiss')}
                </button>
            </div>
        </div>
    )
}
