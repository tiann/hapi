import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

export function SyncingBanner({ isSyncing }: { isSyncing: boolean }) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    // Don't show syncing banner when offline (OfflineBanner takes precedence)
    if (!isSyncing || !isOnline) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 bg-[var(--app-banner-bg)] text-[var(--app-banner-text)] text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2 border-b border-[var(--app-divider)]">
            <Spinner size="sm" label={null} className="text-[var(--app-banner-text)]" />
            {t('syncing.title')}
        </div>
    )
}
