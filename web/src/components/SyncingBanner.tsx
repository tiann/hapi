import { useOnlineStatus } from '@/hooks/useOnlineStatus'

export function SyncingBanner({ isSyncing }: { isSyncing: boolean }) {
    const isOnline = useOnlineStatus()

    // Don't show syncing banner when offline (OfflineBanner takes precedence)
    if (!isSyncing || !isOnline) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 bg-[var(--app-button)] text-[var(--app-button-text)] text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2">
            <span className="inline-block animate-spin">&#8635;</span>
            Syncing...
        </div>
    )
}
