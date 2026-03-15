import { useOnlineStatus } from '@/shared/hooks/useOnlineStatus'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function getReasonLabel(reason: string, t: (key: string) => string): string {
    if (reason === 'heartbeat-timeout') {
        return t('reconnecting.reason.heartbeatTimeout')
    }
    if (reason === 'closed') {
        return t('reconnecting.reason.closed')
    }
    if (reason === 'error') {
        return t('reconnecting.reason.error')
    }
    return reason
}

export type SystemStatusProps = {
    isReconnecting: boolean
    reconnectReason?: string | null
    isSyncing: boolean
}

export function SystemStatus({ isReconnecting, reconnectReason, isSyncing }: SystemStatusProps) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    // Priority: Offline > Reconnecting > Syncing
    if (!isOnline) {
        return (
            <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-2 text-sm font-medium z-50">
                {t('offline.message')}
            </div>
        )
    }

    if (isReconnecting) {
        const reasonLabel = reconnectReason ? getReasonLabel(reconnectReason, t) : null
        return (
            <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2">
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                {t('reconnecting.message')}
                {reasonLabel ? <span className="opacity-90">({reasonLabel})</span> : null}
            </div>
        )
    }

    if (isSyncing) {
        return (
            <div className="fixed top-0 left-0 right-0 bg-[var(--app-banner-bg)] text-[var(--app-banner-text)] text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2 border-b border-[var(--app-divider)]">
                <Spinner size="sm" label={null} className="text-[var(--app-banner-text)]" />
                {t('syncing.title')}
            </div>
        )
    }

    return null
}
