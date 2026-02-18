import { useState, useRef, useEffect } from 'react'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName, type Language } from '@/lib/languages'
import { getFontScaleOptions, useFontScale, type FontScale } from '@/hooks/useFontScale'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { VOICE_PROVIDERS, type VoiceProvider } from '@hapi/protocol/voice'

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

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const goBack = useAppGoBack()
    const [isOpen, setIsOpen] = useState(false)
    const [isFontOpen, setIsFontOpen] = useState(false)
    const [isVoiceOpen, setIsVoiceOpen] = useState(false)
    const [isVoiceProviderOpen, setIsVoiceProviderOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const fontContainerRef = useRef<HTMLDivElement>(null)
    const voiceContainerRef = useRef<HTMLDivElement>(null)
    const voiceProviderRef = useRef<HTMLDivElement>(null)
    const { fontScale, setFontScale } = useFontScale()

    // Voice language state - read from localStorage
    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-lang')
    })

    // Voice provider state
    const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>(() => {
        return (localStorage.getItem('hapi-voice-provider') as VoiceProvider) || 'elevenlabs'
    })

    // Gemini config state
    const [geminiApiKey, setGeminiApiKey] = useState(() => {
        return localStorage.getItem('hapi-gemini-api-key') || ''
    })
    const [geminiVoiceUrl, setGeminiVoiceUrl] = useState(() => {
        return localStorage.getItem('hapi-gemini-voice-url') || ''
    })

    const fontScaleOptions = getFontScaleOptions()
    const currentLocale = locales.find((loc) => loc.value === locale)
    const currentFontScaleLabel = fontScaleOptions.find((opt) => opt.value === fontScale)?.label ?? '100%'
    const currentVoiceLanguage = voiceLanguages.find((lang) => lang.code === voiceLanguage)

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

    const handleVoiceProviderChange = (provider: VoiceProvider) => {
        setVoiceProvider(provider)
        localStorage.setItem('hapi-voice-provider', provider)
        setIsVoiceProviderOpen(false)
    }

    const handleGeminiApiKeyChange = (value: string) => {
        setGeminiApiKey(value)
        if (value) {
            localStorage.setItem('hapi-gemini-api-key', value)
        } else {
            localStorage.removeItem('hapi-gemini-api-key')
        }
    }

    const handleGeminiVoiceUrlChange = (value: string) => {
        setGeminiVoiceUrl(value)
        if (value) {
            localStorage.setItem('hapi-gemini-voice-url', value)
        } else {
            localStorage.removeItem('hapi-gemini-voice-url')
        }
    }

    const voiceProviderLabels: Record<VoiceProvider, string> = {
        elevenlabs: 'ElevenLabs',
        gemini: 'Gemini Live'
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen && !isVoiceProviderOpen) return

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
            if (isVoiceProviderOpen && voiceProviderRef.current && !voiceProviderRef.current.contains(event.target as Node)) {
                setIsVoiceProviderOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen, isFontOpen, isVoiceOpen, isVoiceProviderOpen])

    // Close on escape key
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen && !isVoiceProviderOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
                setIsFontOpen(false)
                setIsVoiceOpen(false)
                setIsVoiceProviderOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, isFontOpen, isVoiceOpen, isVoiceProviderOpen])

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

                        {/* Voice Provider selector */}
                        <div ref={voiceProviderRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsVoiceProviderOpen(!isVoiceProviderOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isVoiceProviderOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.voice.provider')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{voiceProviderLabels[voiceProvider]}</span>
                                    <ChevronDownIcon className={`transition-transform ${isVoiceProviderOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isVoiceProviderOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[160px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.voice.provider')}
                                >
                                    {VOICE_PROVIDERS.map((provider) => {
                                        const isSelected = voiceProvider === provider
                                        return (
                                            <button
                                                key={provider}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleVoiceProviderChange(provider)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{voiceProviderLabels[provider]}</span>
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

                        {/* ElevenLabs language selector - only show when ElevenLabs is selected */}
                        {voiceProvider === 'elevenlabs' && (
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
                        )}

                        {/* Gemini config - only show when Gemini is selected */}
                        {voiceProvider === 'gemini' && (
                            <>
                                <div className="px-3 py-3">
                                    <label className="block text-sm text-[var(--app-fg)] mb-1.5">
                                        {t('settings.voice.geminiApiKey')}
                                    </label>
                                    <input
                                        type="password"
                                        value={geminiApiKey}
                                        onChange={(e) => handleGeminiApiKeyChange(e.target.value)}
                                        placeholder={t('settings.voice.geminiApiKeyPlaceholder')}
                                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
                                    />
                                    <p className="mt-1 text-xs text-[var(--app-hint)]">
                                        {t('settings.voice.geminiApiKeyHint')}
                                    </p>
                                </div>
                                <div className="px-3 py-3">
                                    <label className="block text-sm text-[var(--app-fg)] mb-1.5">
                                        {t('settings.voice.geminiUrl')}
                                    </label>
                                    <input
                                        type="text"
                                        value={geminiVoiceUrl}
                                        onChange={(e) => handleGeminiVoiceUrlChange(e.target.value)}
                                        placeholder={t('settings.voice.geminiUrlPlaceholder')}
                                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
                                    />
                                    <p className="mt-1 text-xs text-[var(--app-hint)]">
                                        {t('settings.voice.geminiUrlHint')}
                                    </p>
                                </div>
                            </>
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
