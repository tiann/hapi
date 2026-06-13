import { useTranslation } from '@/lib/use-translation'

/**
 * tiann/hapi#893 (scratchlist v2): one-time banner shown the first time
 * a v2-aware client encounters localStorage entries on a session and
 * pushes them up to the hub silently.
 *
 * Visibility contract:
 *   - Renders only when `migrationStatus === 'completed'` (the hook's
 *     signal that the migration just ran in this session).
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
        | 'pre-migrated'
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
