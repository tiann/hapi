import { useMemo } from 'react'
import { getTelegramWebApp } from './useTelegram'

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
export type HapticNotification = 'error' | 'success' | 'warning'

export type PlatformHaptic = {
    /** Trigger impact feedback */
    impact: (style: HapticStyle) => void
    /** Trigger notification feedback */
    notification: (type: HapticNotification) => void
    /** Trigger selection changed feedback */
    selection: () => void
}

export type Platform = {
    /** Whether running in Telegram Mini App */
    isTelegram: boolean
    /** Haptic feedback (no-op on browser) */
    haptic: PlatformHaptic
}

function createHaptic(): PlatformHaptic {
    return {
        impact: (style: HapticStyle) => {
            getTelegramWebApp()?.HapticFeedback?.impactOccurred(style)
        },
        notification: (type: HapticNotification) => {
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred(type)
        },
        selection: () => {
            getTelegramWebApp()?.HapticFeedback?.selectionChanged()
        }
    }
}

// Singleton haptic instance (functions are stable)
const haptic = createHaptic()

export function usePlatform(): Platform {
    const isTelegram = useMemo(() => getTelegramWebApp() !== null, [])

    return {
        isTelegram,
        haptic
    }
}

// Non-hook version for use outside React components
export function getPlatform(): Platform {
    return {
        isTelegram: getTelegramWebApp() !== null,
        haptic
    }
}
