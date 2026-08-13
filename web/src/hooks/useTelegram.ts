import {
    backButton,
    hapticFeedback,
    init as initTma,
    initData,
    isTMA,
    miniApp,
    off as offTmaEvent,
    on as onTmaEvent,
    retrieveLaunchParams,
    retrieveRawInitData,
    swipeBehavior,
    themeParams,
    viewport,
} from '@tma.js/sdk'

const TMA_INIT_RETRY_DELAY_MS = 500
const TELEGRAM_RESTORE_REPAIR_DELAYS_MS = [0, 50, 250, 600] as const

/**
 * Detects if the current environment is Telegram Mini App
 * by checking URL hash/query parameters that Telegram passes.
 * This works BEFORE the SDK is loaded.
 */
export function isTelegramEnvironment(): boolean {
    if (typeof window === 'undefined') return false

    if (window.Telegram?.WebApp) return true
    if (isTmaEnvironment()) return true

    // Telegram passes launch params via window.location.hash
    // Format: #tgWebAppVersion=...&tgWebAppData=...&tgWebAppPlatform=...
    const hash = window.location.hash.slice(1)
    const hashParams = new URLSearchParams(hash)

    // Primary detection: check hash parameters
    if (hashParams.has('tgWebAppVersion') || hashParams.has('tgWebAppData')) {
        return true
    }

    // Fallback: check query parameters (alternative flow)
    const search = window.location.search
    if (search.includes('tgWebApp') || search.includes('initData')) {
        return true
    }

    return hasTelegramHostBridge() || isTelegramUserAgent()
}

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
    platform?: string
    version?: string
    headerColor?: string
    backgroundColor?: string
    bottomBarColor?: string
    isVersionAtLeast?: (version: string) => boolean
    ready: () => void
    expand: () => void
    disableVerticalSwipes?: () => void
    setHeaderColor?: (color: string) => void
    setBackgroundColor?: (color: string) => void
    setBottomBarColor?: (color: string) => void
    close?: () => void
    onEvent?: (eventType: string, callback: (event?: unknown) => void) => void
    offEvent?: (eventType: string, callback: (event?: unknown) => void) => void
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

let lastHapticFeedbackAt = 0
let removeTelegramInteractionHaptics: (() => void) | null = null
let tmaInitialized = false
let tmaInitAttempted = false
let lastTmaInitAttemptAt = 0
let tmaThemeCssVarsCleanup: (() => void) | null = null
let tmaViewportCssVarsCleanup: (() => void) | null = null
let removeTelegramRestoreRepair: (() => void) | null = null
let telegramRestoreRepairTimers: number[] = []
let telegramRestoreRepairWebApp: TelegramWebApp | null = null

type TelegramAppChromeMethod =
    | 'setHeaderColor'
    | 'setBackgroundColor'
    | 'setBottomBarColor'

type TelegramBridgeMethod =
    | 'web_app_set_header_color'
    | 'web_app_set_background_color'
    | 'web_app_set_bottom_bar_color'
    | 'web_app_ready'
    | 'web_app_setup_swipe_behavior'

declare global {
    interface Window {
        Telegram?: {
            WebApp?: TelegramWebApp
        }
        TelegramGameProxy?: unknown
        TelegramWebviewProxy?: {
            postEvent?: (eventType: string, eventData: string) => void
        }
        TelegramWebviewProxyProto?: unknown
    }
}

export function getTelegramWebApp(): TelegramWebApp | null {
    const nativeWebApp = window.Telegram?.WebApp
    if (nativeWebApp) return nativeWebApp

    if (!isTelegramEnvironment()) return null
    if (!initializeTmaSdk()) return null
    const rawInitData = safeRead(() => retrieveRawInitData()) ?? ''
    const launchParams = safeRead(() => retrieveLaunchParams())

    return {
        initData: rawInitData,
        initDataUnsafe: {
            start_param: initData.startParam() ?? launchParams?.tgWebAppStartParam,
            user: normalizeTelegramUser(initData.user()),
        },
        themeParams: normalizeTelegramThemeParams(themeParams.state()),
        colorScheme: themeParams.isDark() ? 'dark' : 'light',
        platform: launchParams?.tgWebAppPlatform,
        version: launchParams?.tgWebAppVersion,
        headerColor: String(miniApp.headerColor()),
        backgroundColor: String(miniApp.bgColor()),
        bottomBarColor: String(miniApp.bottomBarColor()),
        isVersionAtLeast: (version) => compareVersions(launchParams?.tgWebAppVersion ?? '0', version) >= 0,
        ready: () => miniApp.ready.ifAvailable(),
        expand: () => viewport.expand.ifAvailable(),
        disableVerticalSwipes: () => swipeBehavior.disableVertical.ifAvailable(),
        setHeaderColor: (color) => setTmaChromeColor('setHeaderColor', color),
        setBackgroundColor: (color) => setTmaChromeColor('setBackgroundColor', color),
        setBottomBarColor: (color) => setTmaChromeColor('setBottomBarColor', color),
        close: () => miniApp.close.ifAvailable(),
        onEvent: (eventType, callback) => {
            if (eventType === 'themeChanged') onTmaEvent('theme_changed', callback)
        },
        offEvent: (eventType, callback) => {
            if (eventType === 'themeChanged') offTmaEvent('theme_changed', callback)
        },
        BackButton: {
            show: () => backButton.show.ifAvailable(),
            hide: () => backButton.hide.ifAvailable(),
            onClick: (callback) => {
                backButton.onClick.ifAvailable(callback)
            },
            offClick: (callback) => {
                backButton.offClick.ifAvailable(callback)
            },
        },
        HapticFeedback: {
            impactOccurred: (style) => hapticFeedback.impactOccurred.ifAvailable(style),
            notificationOccurred: (type) => hapticFeedback.notificationOccurred.ifAvailable(type),
            selectionChanged: () => hapticFeedback.selectionChanged.ifAvailable(),
        },
    }
}

/**
 * Checks if running inside a real Telegram Mini App.
 * Requires SDK to be loaded. Returns true only if initData is present.
 */
export function isTelegramApp(): boolean {
    const tg = getTelegramWebApp()
    return tg !== null && Boolean(tg.initData)
}

export function configureTelegramWebApp(options: { syncThemeColors?: boolean } = {}): void {
    const tg = getTelegramWebApp()
    if (!tg) {
        if (configureTelegramChromeViaBridge() && (options.syncThemeColors ?? true)) {
            syncTelegramWebAppThemeColors()
        }
        installTelegramRestoreRepair()
        return
    }

    tg.ready()
    tg.expand()
    tg.disableVerticalSwipes?.()
    if (options.syncThemeColors ?? true) {
        syncTelegramWebAppThemeColors()
    }
    installTelegramInteractionHaptics()
    installTelegramRestoreRepair()
}

export function syncTelegramWebAppThemeColors(color = getResolvedAppBackgroundColor()): void {
    const tg = getTelegramWebApp()
    if (!color) return

    if (tg) {
        setTelegramHeaderColor(tg, color)
        setTelegramChromeColor(tg, 'setBackgroundColor', color, ['bg_color'])
        setTelegramChromeColor(tg, 'setBottomBarColor', color, ['bottom_bar_bg_color', 'bg_color'])
    } else {
        syncTelegramChromeColorsViaBridge(color)
    }
    resetTelegramDocumentDrift()
}

function setTelegramHeaderColor(tg: TelegramWebApp, color: string): void {
    if (!tg.setHeaderColor) return

    if (!tg.isVersionAtLeast || tg.isVersionAtLeast('6.9')) {
        if (setTelegramChromeColor(tg, 'setHeaderColor', color)) return
    }

    setTelegramChromeColor(tg, 'setHeaderColor', color, ['bg_color', 'secondary_bg_color'])
}

function setTelegramChromeColor(
    tg: TelegramWebApp,
    method: TelegramAppChromeMethod,
    color: string,
    fallbackColors: string[] = []
): boolean {
    const setter = tg[method]
    if (!setter) return false

    for (const candidate of [color, ...fallbackColors]) {
        try {
            setter.call(tg, candidate)
            return true
        } catch (error) {
            void error
            // Some Telegram clients reject custom hex colors for specific
            // chrome surfaces. Keep the other surfaces independent.
        }
    }

    return false
}

function hasTelegramLaunchParams(): boolean {
    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    if (hashParams.has('tgWebAppVersion') || hashParams.has('tgWebAppData')) return true
    return window.location.search.includes('tgWebApp') || window.location.search.includes('initData')
}

function isTelegramUserAgent(): boolean {
    return typeof navigator !== 'undefined' && /\bTelegram\b/i.test(navigator.userAgent)
}

function hasTelegramHostBridge(): boolean {
    const hostWindow = window as Window & { external?: { notify?: unknown } }
    return Boolean(
        window.TelegramWebviewProxy
        || window.TelegramWebviewProxyProto
        || window.TelegramGameProxy
        || hostWindow.external?.notify
    )
}

function isTmaEnvironment(): boolean {
    try {
        return isTMA()
    } catch {
        return false
    }
}

function initializeTmaSdk(): boolean {
    if (typeof window === 'undefined') return false
    if (tmaInitialized) return true
    const now = Date.now()
    if (tmaInitAttempted && now - lastTmaInitAttemptAt < TMA_INIT_RETRY_DELAY_MS) return false

    tmaInitAttempted = true
    lastTmaInitAttemptAt = now
    try {
        initTma()
        tmaInitialized = true
    } catch (error) {
        void error
        return false
    }

    safeCall(() => initData.restore())
    safeCall(() => {
        if (!themeParams.isMounted()) themeParams.mount()
    })
    bindTmaThemeCssVars()
    safeCall(() => {
        if (!miniApp.isMounted()) miniApp.mount()
    })
    mountTmaViewportAndBindCssVars()
    safeCall(() => {
        if (!swipeBehavior.isMounted()) swipeBehavior.mount()
    })
    safeCall(() => {
        if (!backButton.isMounted()) backButton.mount()
    })

    return true
}

function bindTmaThemeCssVars(): void {
    if (tmaThemeCssVarsCleanup || safeRead(() => themeParams.isCssVarsBound()) === true) return

    try {
        tmaThemeCssVarsCleanup = themeParams.bindCssVars()
    } catch (error) {
        void error
    }
}

function mountTmaViewportAndBindCssVars(): void {
    safeCall(() => {
        if (viewport.isMounted()) {
            scheduleTmaViewportCssVarsBind()
            return
        }

        void viewport.mount()
            .then(scheduleTmaViewportCssVarsBind)
            .catch(() => {
                // Viewport data is platform/version dependent.
            })
    })
}

function scheduleTmaViewportCssVarsBind(): void {
    bindTmaViewportCssVars()
    window.setTimeout(bindTmaViewportCssVars, 0)
    window.setTimeout(bindTmaViewportCssVars, 250)
}

function bindTmaViewportCssVars(): void {
    if (tmaViewportCssVarsCleanup || safeRead(() => viewport.isCssVarsBound()) === true) return

    try {
        const cleanup = viewport.bindCssVars()
        tmaViewportCssVarsCleanup = cleanup
    } catch (error) {
        void error
    }
}

function normalizeTelegramUser(user: ReturnType<typeof initData.user>): TelegramWebAppUser | undefined {
    if (!user) return undefined
    return {
        id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
    }
}

function normalizeTelegramThemeParams(params: ReturnType<typeof themeParams.state>): TelegramWebAppThemeParams {
    return {
        bg_color: params.bgColor,
        text_color: params.textColor,
        hint_color: params.hintColor,
        link_color: params.linkColor,
        button_color: params.buttonColor,
        button_text_color: params.buttonTextColor,
        secondary_bg_color: params.secondaryBgColor,
    }
}

function setTmaChromeColor(method: TelegramAppChromeMethod, color: string): void {
    if (method === 'setHeaderColor') {
        if (miniApp.setHeaderColor.isAvailable()) {
            if (miniApp.setHeaderColor.supports('rgb')) {
                miniApp.setHeaderColor(color)
                return
            }
            miniApp.setHeaderColor('bg_color')
        }
        return
    }

    if (method === 'setBackgroundColor') {
        miniApp.setBgColor.ifAvailable(color)
        return
    }

    miniApp.setBottomBarColor.ifAvailable(color)
}

function configureTelegramChromeViaBridge(): boolean {
    if (!hasTelegramHostBridge()) return false

    postTelegramBridgeEvent('web_app_ready')
    postTelegramBridgeEvent('web_app_setup_swipe_behavior', { allow_vertical_swipe: false })
    resetTelegramDocumentDrift()
    return true
}

function installTelegramRestoreRepair(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const tg = getTelegramWebApp()
    if (tg && tg !== telegramRestoreRepairWebApp) {
        telegramRestoreRepairWebApp?.offEvent?.('viewportChanged', handleTelegramViewportChanged)
        telegramRestoreRepairWebApp?.offEvent?.('visibilityChanged', handleTelegramVisibilityChanged)
        tg.onEvent?.('viewportChanged', handleTelegramViewportChanged)
        tg.onEvent?.('visibilityChanged', handleTelegramVisibilityChanged)
        telegramRestoreRepairWebApp = tg
    }

    if (removeTelegramRestoreRepair) return

    window.addEventListener('focus', handleTelegramRestore)
    window.addEventListener('pageshow', handleTelegramRestore)
    document.addEventListener('visibilitychange', handleTelegramDocumentVisibilityChange)

    removeTelegramRestoreRepair = () => {
        clearTelegramRestoreRepairTimers()
        window.removeEventListener('focus', handleTelegramRestore)
        window.removeEventListener('pageshow', handleTelegramRestore)
        document.removeEventListener('visibilitychange', handleTelegramDocumentVisibilityChange)
        telegramRestoreRepairWebApp?.offEvent?.('viewportChanged', handleTelegramViewportChanged)
        telegramRestoreRepairWebApp?.offEvent?.('visibilityChanged', handleTelegramVisibilityChanged)
        telegramRestoreRepairWebApp = null
        removeTelegramRestoreRepair = null
    }
}

function handleTelegramRestore(): void {
    scheduleTelegramRestoreRepair({ expand: true })
}

function handleTelegramDocumentVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
        scheduleTelegramRestoreRepair({ expand: true })
    }
}

function handleTelegramViewportChanged(): void {
    scheduleTelegramRestoreRepair({ expand: false })
}

function handleTelegramVisibilityChanged(event?: unknown): void {
    if (isTelegramVisibilityHiddenEvent(event)) return
    scheduleTelegramRestoreRepair({ expand: true })
}

function isTelegramVisibilityHiddenEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false
    const visible = (event as { is_visible?: unknown; isVisible?: unknown }).is_visible
        ?? (event as { isVisible?: unknown }).isVisible
    return visible === false
}

function scheduleTelegramRestoreRepair(options: { expand: boolean }): void {
    clearTelegramRestoreRepairTimers()
    telegramRestoreRepairTimers = TELEGRAM_RESTORE_REPAIR_DELAYS_MS.map((delay) => (
        window.setTimeout(() => repairTelegramRestore(options), delay)
    ))
}

function clearTelegramRestoreRepairTimers(): void {
    for (const timer of telegramRestoreRepairTimers) {
        window.clearTimeout(timer)
    }
    telegramRestoreRepairTimers = []
}

function repairTelegramRestore(options: { expand: boolean }): void {
    if (!isTelegramEnvironment()) return

    const tg = getTelegramWebApp()
    if (tg) {
        tg.ready()
        if (options.expand) {
            tg.expand()
        }
        tg.disableVerticalSwipes?.()
        bindTmaThemeCssVars()
        mountTmaViewportAndBindCssVars()
        syncTelegramWebAppThemeColors()
        return
    }

    if (configureTelegramChromeViaBridge()) {
        syncTelegramWebAppThemeColors()
    }
}

function syncTelegramChromeColorsViaBridge(color: string): void {
    if (!hasTelegramHostBridge()) return

    postTelegramBridgeEvent('web_app_set_header_color', { color })
    postTelegramBridgeEvent('web_app_set_background_color', { color })
    postTelegramBridgeEvent('web_app_set_bottom_bar_color', { color })
}

function postTelegramBridgeEvent(
    method: TelegramBridgeMethod,
    params?: Record<string, unknown>
): boolean {
    try {
        postTelegramRawEvent(method, params)
        return true
    } catch (error) {
        void error
        return false
    }
}

function postTelegramRawEvent(method: TelegramBridgeMethod, params: Record<string, unknown> | undefined): void {
    const serializedParams = JSON.stringify(params ?? {})
    if (typeof window.TelegramWebviewProxy?.postEvent === 'function') {
        window.TelegramWebviewProxy.postEvent(method, serializedParams)
        return
    }

    const hostWindow = window as Window & { external?: { notify?: (message: string) => void } }
    if (typeof hostWindow.external?.notify === 'function') {
        hostWindow.external.notify(JSON.stringify({ eventType: method, eventData: params ?? {} }))
        return
    }

    throw new Error('Telegram host bridge is unavailable')
}

function resetTelegramDocumentDrift(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (!isTelegramEnvironment()) return

    const reset = () => {
        document.documentElement.scrollTop = 0
        if (document.body) document.body.scrollTop = 0
        if (window.scrollX !== 0 || window.scrollY !== 0) {
            safeCall(() => window.scrollTo(0, 0))
        }
    }

    window.requestAnimationFrame(reset)
    window.setTimeout(reset, 50)
    window.setTimeout(reset, 250)
}

function safeCall(callback: () => void): void {
    try {
        callback()
    } catch {
        // Telegram features are version/platform dependent.
    }
}

function safeRead<T>(callback: () => T): T | null {
    try {
        return callback()
    } catch {
        return null
    }
}

function compareVersions(a: string, b: string): number {
    const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
    const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
        const delta = (left[index] ?? 0) - (right[index] ?? 0)
        if (delta !== 0) return delta
    }
    return 0
}

export function getResolvedAppBackgroundColor(): string | null {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return null

    const probe = document.createElement('div')
    probe.style.position = 'fixed'
    probe.style.pointerEvents = 'none'
    probe.style.visibility = 'hidden'
    probe.style.backgroundColor = 'var(--app-bg)'

    document.body.appendChild(probe)
    const resolved = window.getComputedStyle(probe).backgroundColor
    probe.remove()

    return normalizeCssColorToHex(resolved)
}

export function normalizeCssColorToHex(color: string): string | null {
    const value = color.trim().toLowerCase()
    if (!value || value === 'transparent') return null

    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    if (hex) {
        const raw = hex[1]!
        if (raw.length === 6) return `#${raw}`
        return `#${raw.split('').map((char) => char + char).join('')}`
    }

    const rgb = value.match(/^rgba?\(([^)]+)\)$/)
    if (!rgb) return null

    const channels = rgb[1]!
        .split(',')
        .slice(0, 3)
        .map((part) => Number.parseInt(part.trim(), 10))

    if (channels.length !== 3 || channels.some((channel) => Number.isNaN(channel))) {
        return null
    }

    return `#${channels.map((channel) => clampColorChannel(channel).toString(16).padStart(2, '0')).join('')}`
}

function clampColorChannel(channel: number): number {
    return Math.min(255, Math.max(0, channel))
}

export function markTelegramHapticFeedback(): void {
    lastHapticFeedbackAt = Date.now()
}

export function hasRecentTelegramHapticFeedback(windowMs = 120): boolean {
    return Date.now() - lastHapticFeedbackAt < windowMs
}

export function installTelegramInteractionHaptics(): void {
    if (removeTelegramInteractionHaptics || typeof document === 'undefined') return

    const onClick = (event: MouseEvent) => {
        if (!event.isTrusted || hasRecentTelegramHapticFeedback()) return

        const target = event.target
        if (!(target instanceof Element)) return

        const interactive = target.closest<HTMLElement>(
            'button, a[href], select, summary, input[type="checkbox"], input[type="radio"], input[type="range"], [role="button"], [role="menuitem"], [role="option"], [data-haptic]'
        )
        if (!interactive || isDisabledInteractiveElement(interactive)) return

        const feedback = getTelegramWebApp()?.HapticFeedback
        if (!feedback) return

        markTelegramHapticFeedback()
        if (isSelectionInteractiveElement(interactive)) {
            feedback.selectionChanged()
            return
        }
        feedback.impactOccurred('light')
    }

    document.addEventListener('click', onClick)
    removeTelegramInteractionHaptics = () => {
        document.removeEventListener('click', onClick)
        removeTelegramInteractionHaptics = null
    }
}

function isDisabledInteractiveElement(element: HTMLElement): boolean {
    if (element.getAttribute('aria-disabled') === 'true') return true
    if (
        element instanceof HTMLButtonElement
        || element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
    ) {
        return element.disabled
    }
    return false
}

function isSelectionInteractiveElement(element: HTMLElement): boolean {
    if (element instanceof HTMLSelectElement) return true
    if (element instanceof HTMLInputElement) {
        return element.type === 'checkbox' || element.type === 'radio'
    }
    const role = element.getAttribute('role')
    return role === 'option' || role === 'menuitemradio' || role === 'menuitemcheckbox'
}

/**
 * Initializes the Telegram Mini Apps SDK. Kept async for the existing bootstrap contract.
 */
export function loadTelegramSdk(timeoutMs = 3000): Promise<void> {
    void timeoutMs
    initializeTmaSdk()
    return Promise.resolve()
}
