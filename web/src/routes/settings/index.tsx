import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName, type Language } from '@/lib/languages'
import { getFontScaleOptions, useFontScale, type FontScale } from '@/hooks/useFontScale'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useAppContext } from '@/lib/app-context'
import type { TelegramConfigResponse } from '@/types/api'

const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

const voiceLanguages = getElevenLabsSupportedLanguages()

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function TelegramIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
        </svg>
    )
}

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const goBack = useAppGoBack()
    const { api } = useAppContext()
    const [isOpen, setIsOpen] = useState(false)
    const [isFontOpen, setIsFontOpen] = useState(false)
    const [isVoiceOpen, setIsVoiceOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const fontContainerRef = useRef<HTMLDivElement>(null)
    const voiceContainerRef = useRef<HTMLDivElement>(null)
    const { fontScale, setFontScale } = useFontScale()

    // Voice language state - read from localStorage
    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-lang')
    })

    // Telegram config state
    const [telegramConfig, setTelegramConfig] = useState<TelegramConfigResponse | null>(null)
    const [isLoadingTelegram, setIsLoadingTelegram] = useState(true)
    const [isSavingTelegram, setIsSavingTelegram] = useState(false)
    const [showTelegramForm, setShowTelegramForm] = useState(false)
    const [telegramToken, setTelegramToken] = useState('')
    const [telegramUrl, setTelegramUrl] = useState('')
    const [telegramNotifications, setTelegramNotifications] = useState(true)
    const [saveMessage, setSaveMessage] = useState<string | null>(null)
    const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)

    // Web notification state
    const [webNotifications, setWebNotifications] = useState<boolean>(() => {
        const stored = localStorage.getItem('hapi-web-notifications')
        return stored === null ? true : stored === 'true'
    })
    // Load Telegram config
    const loadTelegramConfig = useCallback(async () => {
        try {
            const config = await api.getTelegramConfig()
            setTelegramConfig(config)
            setTelegramUrl(config.publicUrl)
            setTelegramNotifications(config.telegramNotification)
            if (config.telegramBotToken) {
                setTelegramToken(config.telegramBotToken)
            }
        } catch {
            // Silently fail - Telegram config is not critical
        } finally {
            setIsLoadingTelegram(false)
        }
    }, [api])

    useEffect(() => {
        void loadTelegramConfig()
    }, [loadTelegramConfig])

    const handleSaveTelegram = async () => {
        setIsSavingTelegram(true)
        setSaveMessage(null)
        try {
            const result = await api.saveTelegramConfig({
                telegramBotToken: telegramToken || undefined,
                telegramNotification: telegramNotifications,
                publicUrl: telegramUrl || undefined,
            })
            setSaveMessage(result.message)
            await loadTelegramConfig()
        } catch {
            setSaveMessage(t('settings.telegram.saveError'))
        } finally {
            setIsSavingTelegram(false)
        }
    }

    const handleRemoveToken = async () => {
        setIsSavingTelegram(true)
        try {
            const result = await api.deleteTelegramToken()
            setSaveMessage(result.message)
            setTelegramToken('')
            setShowRemoveConfirm(false)
            await loadTelegramConfig()
        } catch {
            setSaveMessage(t('settings.telegram.saveError'))
        } finally {
            setIsSavingTelegram(false)
        }
    }

    const fontScaleOptions = getFontScaleOptions()
    const currentLocale = locales.find((loc) => loc.value === locale)
    const currentFontScaleLabel = fontScaleOptions.find((opt) => opt.value === fontScale)?.label ?? '100%'
    const currentVoiceLanguage = voiceLanguages.find((lang) => lang.code === voiceLanguage)

    // Get token source display text
    const getTokenSourceText = (source: string) => {
        switch (source) {
            case 'env':
                return t('settings.telegram.tokenSource.env')
            case 'file':
                return t('settings.telegram.tokenSource.file')
            default:
                return t('settings.telegram.tokenSource.default')
        }
    }

    const handleLocaleChange = (newLocale: Locale) => {
        setLocale(newLocale)
        setIsOpen(false)
    }

    const handleFontScaleChange = (newScale: FontScale) => {
        setFontScale(newScale)
        setIsFontOpen(false)
    }

    const handleVoiceLanguageChange = (language: Language) => {
        setVoiceLanguage(language.code)
        if (language.code === null) {
            localStorage.removeItem('hapi-voice-lang')
        } else {
            localStorage.setItem('hapi-voice-lang', language.code)
        }
        setIsVoiceOpen(false)
    }

    const handleWebNotificationsChange = (enabled: boolean) => {
        setWebNotifications(enabled)
        localStorage.setItem('hapi-web-notifications', enabled ? 'true' : 'false')
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen) return

        const handleClickOutside = (event: MouseEvent) => {
            if (isOpen && containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
            if (isFontOpen && fontContainerRef.current && !fontContainerRef.current.contains(event.target as Node)) {
                setIsFontOpen(false)
            }
            if (isVoiceOpen && voiceContainerRef.current && !voiceContainerRef.current.contains(event.target as Node)) {
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen, isFontOpen, isVoiceOpen])

    // Close on escape key
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
                setIsFontOpen(false)
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, isFontOpen, isVoiceOpen])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-semibold">{t('settings.title')}</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {/* Language section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.language.title')}
                        </div>
                        <div ref={containerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsOpen(!isOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.language.label')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentLocale?.nativeLabel}</span>
                                    <ChevronDownIcon className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[160px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.language.title')}
                                >
                                    {locales.map((loc) => {
                                        const isSelected = locale === loc.value
                                        return (
                                            <button
                                                key={loc.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleLocaleChange(loc.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{loc.nativeLabel}</span>
                                                {isSelected && (
                                                    <span className="ml-2 text-[var(--app-link)]">
                                                        <CheckIcon />
                                                    </span>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Display section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.display.title')}
                        </div>
                        <div ref={fontContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsFontOpen(!isFontOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isFontOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.display.fontSize')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentFontScaleLabel}</span>
                                    <ChevronDownIcon className={`transition-transform ${isFontOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isFontOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[140px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.display.fontSize')}
                                >
                                    {fontScaleOptions.map((opt) => {
                                        const isSelected = fontScale === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleFontScaleChange(opt.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{opt.label}</span>
                                                {isSelected && (
                                                    <span className="ml-2 text-[var(--app-link)]">
                                                        <CheckIcon />
                                                    </span>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Voice Assistant section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.voice.title')}
                        </div>
                        <div ref={voiceContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsVoiceOpen(!isVoiceOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isVoiceOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.voice.language')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>
                                        {currentVoiceLanguage
                                            ? currentVoiceLanguage.code === null
                                                ? t('settings.voice.autoDetect')
                                                : getLanguageDisplayName(currentVoiceLanguage)
                                            : t('settings.voice.autoDetect')}
                                    </span>
                                    <ChevronDownIcon className={`transition-transform ${isVoiceOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isVoiceOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[200px] max-h-[300px] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg z-50"
                                    role="listbox"
                                    aria-label={t('settings.voice.title')}
                                >
                                    {voiceLanguages.map((lang) => {
                                        const isSelected = voiceLanguage === lang.code
                                        const displayName = lang.code === null
                                            ? t('settings.voice.autoDetect')
                                            : getLanguageDisplayName(lang)
                                        return (
                                            <button
                                                key={lang.code ?? 'auto'}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleVoiceLanguageChange(lang)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{displayName}</span>
                                                {isSelected && (
                                                    <span className="ml-2 text-[var(--app-link)]">
                                                        <CheckIcon />
                                                    </span>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

<<<<<<< HEAD
                    {/* Notifications section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.notifications.title')}
                        </div>
                        <div className="flex items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.notifications.web')}</span>
                            <button
                                type="button"
                                onClick={() => handleWebNotificationsChange(!webNotifications)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${webNotifications ? 'bg-[var(--app-link)]' : 'bg-gray-300'}`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${webNotifications ? 'translate-x-6' : 'translate-x-1'}`}
                                />
                            </button>
                        </div>
                    </div>

=======
>>>>>>> cd2ae32 (feat(telegram): add telegram bot integration and settings UI)
                    {/* Telegram section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.telegram.title')}
                        </div>
                        {isLoadingTelegram ? (
                            <div className="px-3 py-3 text-[var(--app-hint)]">
                                {t('loading')}
                            </div>
                        ) : telegramConfig ? (
                            <div className="px-3 py-3">
                                {/* Status row */}
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[var(--app-fg)]">{t('settings.telegram.status')}</span>
                                    <span className={`flex items-center gap-1.5 text-sm ${telegramConfig.enabled ? 'text-green-600' : 'text-[var(--app-hint)]'}`}>
                                        <span className={`w-2 h-2 rounded-full ${telegramConfig.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                                        {telegramConfig.enabled ? t('settings.telegram.enabled') : t('settings.telegram.disabled')}
                                    </span>
                                </div>

                                {/* Token source info */}
                                <div className="text-xs text-[var(--app-hint)] mb-3">
                                    {getTokenSourceText(telegramConfig.tokenSource)}
                                </div>

                                {/* Toggle form button */}
                                <button
                                    type="button"
                                    onClick={() => setShowTelegramForm(!showTelegramForm)}
                                    className="flex items-center gap-2 text-sm text-[var(--app-link)] hover:underline mb-3"
                                >
                                    <TelegramIcon className="w-4 h-4" />
                                    {showTelegramForm ? t('button.close') : t('settings.telegram.save')}
                                </button>

                                {/* Configuration form */}
                                {showTelegramForm && (
                                    <div className="space-y-3 mt-3 pt-3 border-t border-[var(--app-divider)]">
                                        {/* Bot Token */}
                                        <div>
                                            <label className="block text-sm text-[var(--app-fg)] mb-1">
                                                {t('settings.telegram.botToken')}
                                            </label>
                                            <input
                                                type="password"
                                                value={telegramToken}
                                                onChange={(e) => setTelegramToken(e.target.value)}
                                                placeholder={t('settings.telegram.botToken.placeholder')}
                                                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                            />
                                            <p className="text-xs text-[var(--app-hint)] mt-1">
                                                {t('settings.telegram.botToken.help')}
                                            </p>
                                        </div>

                                        {/* Public URL */}
                                        <div>
                                            <label className="block text-sm text-[var(--app-fg)] mb-1">
                                                {t('settings.telegram.publicUrl')}
                                            </label>
                                            <input
                                                type="url"
                                                value={telegramUrl}
                                                onChange={(e) => setTelegramUrl(e.target.value)}
                                                placeholder={t('settings.telegram.publicUrl.placeholder')}
                                                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                            />
                                        </div>

                                        {/* Notifications toggle */}
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-[var(--app-fg)]">{t('settings.telegram.notifications')}</span>
                                            <button
                                                type="button"
                                                onClick={() => setTelegramNotifications(!telegramNotifications)}
                                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${telegramNotifications ? 'bg-[var(--app-link)]' : 'bg-gray-300'}`}
                                            >
                                                <span
                                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${telegramNotifications ? 'translate-x-6' : 'translate-x-1'}`}
                                                />
                                            </button>
                                        </div>

                                        {/* Save button */}
                                        <button
                                            type="button"
                                            onClick={handleSaveTelegram}
                                            disabled={isSavingTelegram}
                                            className="w-full px-4 py-2 text-sm font-medium text-white bg-[var(--app-link)] rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {isSavingTelegram ? t('settings.telegram.saving') : t('settings.telegram.save')}
                                        </button>

                                        {/* Remove token button (only show if token exists and is from file) */}
                                        {telegramConfig.telegramBotToken && telegramConfig.tokenSource === 'file' && (
                                            <button
                                                type="button"
                                                onClick={() => setShowRemoveConfirm(true)}
                                                disabled={isSavingTelegram}
                                                className="w-full px-4 py-2 text-sm font-medium text-red-600 border border-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isSavingTelegram ? t('settings.telegram.removing') : t('settings.telegram.removeToken')}
                                            </button>
                                        )}

                                        {/* Save message */}
                                        {saveMessage && (
                                            <div className="text-sm text-[var(--app-hint)] bg-[var(--app-subtle-bg)] p-3 rounded-lg">
                                                {saveMessage}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Remove confirmation dialog */}
                                {showRemoveConfirm && (
                                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                                        <div className="bg-[var(--app-bg)] rounded-lg p-4 max-w-sm w-full">
                                            <h3 className="text-lg font-semibold text-[var(--app-fg)] mb-2">
                                                {t('settings.telegram.removeToken')}
                                            </h3>
                                            <p className="text-sm text-[var(--app-hint)] mb-4">
                                                {t('settings.telegram.confirmRemove')}
                                            </p>
                                            <div className="flex gap-2 justify-end">
                                                <button
                                                    type="button"
                                                    onClick={() => setShowRemoveConfirm(false)}
                                                    className="px-4 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] rounded-lg"
                                                >
                                                    {t('button.cancel')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleRemoveToken}
                                                    disabled={isSavingTelegram}
                                                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                                                >
                                                    {isSavingTelegram ? t('settings.telegram.removing') : t('button.confirm')}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="px-3 py-3 text-[var(--app-hint)]">
                                Failed to load Telegram configuration
                            </div>
                        )}
                    </div>

                    {/* About section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.about.title')}
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.website')}</span>
                            <a
                                href="https://hapi.run"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--app-link)] hover:underline"
                            >
                                hapi.run
                            </a>
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.appVersion')}</span>
                            <span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.protocolVersion')}</span>
                            <span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
