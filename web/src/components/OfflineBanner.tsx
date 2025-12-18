import { useOnlineStatus } from '@/hooks/useOnlineStatus'

export function OfflineBanner() {
    const isOnline = useOnlineStatus()

    if (isOnline) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-2 text-sm font-medium z-50">
            You're offline. Some features may be unavailable.
        </div>
    )
}
