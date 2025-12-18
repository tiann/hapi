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
    /** Haptic feedback (falls back to Vibration API on browser) */
    haptic: PlatformHaptic
}

function createHaptic(): PlatformHaptic {
    const tg = getTelegramWebApp()

    // Vibration patterns for web fallback (in ms)
    const vibrationPatterns = {
        light: 10,
        medium: 20,
        heavy: 30,
        rigid: 15,
        soft: 10,
        success: 20,
        warning: [20, 50, 20] as number | number[],
        error: [30, 50, 30] as number | number[],
        selection: 5,
    }

    const vibrate = (pattern: number | number[]) => {
        navigator.vibrate?.(pattern)
    }

    return {
        impact: (style: HapticStyle) => {
            if (tg?.HapticFeedback) {
                tg.HapticFeedback.impactOccurred(style)
            } else {
                vibrate(vibrationPatterns[style])
            }
        },
        notification: (type: HapticNotification) => {
            if (tg?.HapticFeedback) {
                tg.HapticFeedback.notificationOccurred(type)
            } else {
                vibrate(vibrationPatterns[type])
            }
        },
        selection: () => {
            if (tg?.HapticFeedback) {
                tg.HapticFeedback.selectionChanged()
            } else {
                vibrate(vibrationPatterns.selection)
            }
        }
    }
}

// Singleton haptic instance (functions are stable)
const haptic = createHaptic()

function checkIsTelegram(): boolean {
    const tg = getTelegramWebApp()
    // SDK is always loaded, but initData is only present in actual Telegram environment
    return tg !== null && Boolean(tg.initData)
}

export function usePlatform(): Platform {
    const isTelegram = useMemo(() => checkIsTelegram(), [])

    return {
        isTelegram,
        haptic
    }
}

// Non-hook version for use outside React components
export function getPlatform(): Platform {
    return {
        isTelegram: checkIsTelegram(),
        haptic
    }
}
