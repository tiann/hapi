import { PwaUpdateBanner } from '@/components/PwaUpdateBanner'
import { RunnerVersionSkewBanner } from '@/components/RunnerVersionSkewBanner'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useVoiceOptional } from '@/lib/voice-context'

/**
 * Single fixed stack for fleet-facing top banners so PWA-update and runner-skew
 * never occupy the same coordinates (z-50 covering z-40). Status banners
 * (sync/reconnect/voice) still use their own fixed slots; this stack offsets
 * below them when they are active.
 */
export function topFleetBannersOffsetClass(options: {
    isOnline: boolean
    hasTopStatusBanner: boolean
}): string {
    if (options.hasTopStatusBanner) {
        return 'top-[calc(env(safe-area-inset-top)+3rem)]'
    }
    return options.isOnline
        ? 'top-[calc(env(safe-area-inset-top)+0.5rem)]'
        : 'top-[calc(env(safe-area-inset-top)+2.5rem)]'
}

export function TopFleetBanners({
    isSyncing,
    isReconnecting,
}: {
    isSyncing: boolean
    isReconnecting: boolean
}) {
    const isOnline = useOnlineStatus()
    const voice = useVoiceOptional()
    const hasTopStatusBanner =
        isSyncing
        || isReconnecting
        || Boolean(voice && voice.status === 'error' && voice.errorMessage)
    const offsetClass = topFleetBannersOffsetClass({ isOnline, hasTopStatusBanner })

    return (
        <div
            data-testid="top-fleet-banners"
            className={`fixed left-4 right-4 z-50 flex flex-col gap-2 ${offsetClass}`}
        >
            <PwaUpdateBanner stacked />
            <RunnerVersionSkewBanner stacked />
        </div>
    )
}
