export type TelegramWebAppThemeParams = {
    bg_color?: string
    text_color?: string
    hint_color?: string
    link_color?: string
    button_color?: string
    button_text_color?: string
    secondary_bg_color?: string
}

export type TelegramWebAppUser = {
    id: number
    username?: string
    first_name: string
    last_name?: string
}

export type TelegramWebAppInitDataUnsafe = {
    start_param?: string
    user?: TelegramWebAppUser
}

export type TelegramWebApp = {
    initData: string
    initDataUnsafe?: TelegramWebAppInitDataUnsafe
    themeParams: TelegramWebAppThemeParams
    colorScheme?: 'light' | 'dark'
    ready: () => void
    expand: () => void
    close?: () => void
    onEvent?: (eventType: string, callback: () => void) => void
    offEvent?: (eventType: string, callback: () => void) => void
    BackButton?: {
        show: () => void
        hide: () => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
    MainButton?: {
        text: string
        color: string
        textColor: string
        isVisible: boolean
        isActive: boolean
        show: () => void
        hide: () => void
        enable: () => void
        disable: () => void
        setText: (text: string) => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
    HapticFeedback?: {
        impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
        notificationOccurred: (type: 'error' | 'success' | 'warning') => void
        selectionChanged: () => void
    }
    SettingsButton?: {
        isVisible: boolean
        show: () => void
        hide: () => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
}

declare global {
    interface Window {
        Telegram?: {
            WebApp?: TelegramWebApp
        }
    }
}

export function getTelegramWebApp(): TelegramWebApp | null {
    return window.Telegram?.WebApp ?? null
}
