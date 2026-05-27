import { useState, useRef, useEffect } from 'react'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName, type Language } from '@/lib/languages'
import { VOICES, getFallbackVoices } from '@/lib/voices'
import { useAppContext } from '@/lib/app-context'
import { fetchVoices, type VoiceInfo } from '@/api/voice'
import { getFontScaleOptions, useFontScale, type FontScale } from '@/hooks/useFontScale'
import { getTerminalFontSizeOptions, useTerminalFontSize, type TerminalFontSize } from '@/hooks/useTerminalFontSize'
import { getComposerEnterBehaviorOptions, useComposerEnterBehavior, type ComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { getTerminalToolDisplayModeOptions, useTerminalToolDisplayMode, type TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import {
    MAX_SESSION_PREVIEW_LIMIT,
    MIN_SESSION_PREVIEW_LIMIT,
    normalizeSessionPreviewLimit,
    useSessionPreviewLimit,
} from '@/hooks/useSessionPreviewLimit'
import {
    getChatSurfaceColorPickerValue,
    getChatSurfaceColorPresetOptions,
    toCustomChatSurfaceColorPreference,
    toPresetChatSurfaceColorPreference,
    useChatSurfaceColors,
    type ChatSurfaceColorPreference,
    type ChatSurfaceColorPreset,
} from '@/hooks/useChatSurfaceColors'
import { useAppearance, getAppearanceOptions, type AppearancePreference } from '@/hooks/useTheme'
import { PROTOCOL_VERSION } from '@hapi/protocol'

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

function PlayIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
    )
}

function StopIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
    )
}

function MinusIcon(props: { className?: string }) {
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
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function SessionPreviewLimitControl(props: {
    label: string
    value: number
    onChange: (value: number) => void
    decreaseLabel: string
    increaseLabel: string
}) {
    const [draft, setDraft] = useState(String(props.value))

    useEffect(() => {
        setDraft(String(props.value))
    }, [props.value])

    const commitDraft = () => {
        const parsed = draft.trim() === '' ? props.value : Number(draft)
        const next = normalizeSessionPreviewLimit(parsed)
        props.onChange(next)
        setDraft(String(next))
    }

    const step = (delta: number) => {
        const next = normalizeSessionPreviewLimit(props.value + delta)
        props.onChange(next)
        setDraft(String(next))
    }

    return (
        <div className="flex w-full items-center justify-between gap-3 px-3 py-3">
            <label htmlFor="session-preview-limit" className="text-[var(--app-fg)]">
                {props.label}
            </label>
            <div className="flex h-9 shrink-0 items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                <button
                    type="button"
                    onClick={() => step(-1)}
                    disabled={props.value <= MIN_SESSION_PREVIEW_LIMIT}
                    aria-label={props.decreaseLabel}
                    title={props.decreaseLabel}
                    className="flex h-8 w-8 items-center justify-center rounded-l-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <MinusIcon className="h-3.5 w-3.5" />
                </button>
                <input
                    id="session-preview-limit"
                    type="number"
                    inputMode="numeric"
                    min={MIN_SESSION_PREVIEW_LIMIT}
                    max={MAX_SESSION_PREVIEW_LIMIT}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commitDraft}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault()
                            commitDraft()
                            event.currentTarget.blur()
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault()
                            setDraft(String(props.value))
                            event.currentTarget.blur()
                        }
                    }}
                    className="h-8 w-14 border-x border-[var(--app-border)] bg-transparent text-center text-sm font-medium tabular-nums text-[var(--app-fg)] outline-none focus:bg-[var(--app-subtle-bg)]"
                />
                <button
                    type="button"
                    onClick={() => step(1)}
                    disabled={props.value >= MAX_SESSION_PREVIEW_LIMIT}
                    aria-label={props.increaseLabel}
                    title={props.increaseLabel}
                    className="flex h-8 w-8 items-center justify-center rounded-r-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <PlusIcon className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    )
}

function ChatSurfaceColorControl(props: {
    label: string
    preference: ChatSurfaceColorPreference
    onPresetChange: (preset: ChatSurfaceColorPreset) => void
    onCustomChange: (value: string) => void
    t: (key: string) => string
}) {
    const presetOptions = getChatSurfaceColorPresetOptions()
    const pickerValue = getChatSurfaceColorPickerValue(props.preference)
    const isCustomSelected = props.preference.startsWith('custom:')

    return (
        <div className="border-t border-[var(--app-divider)] px-3 py-3">
            <div className="mb-2 text-[var(--app-fg)]">{props.label}</div>
            <div className="flex flex-wrap gap-2">
                {presetOptions.map((option) => {
                    const selected = props.preference === toPresetChatSurfaceColorPreference(option.value)
                    const swatchColor = getChatSurfaceColorPickerValue(toPresetChatSurfaceColorPreference(option.value))
                    return (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => props.onPresetChange(option.value)}
                            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                                selected
                                    ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                                    : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                            }`}
                        >
                            <span className="h-2.5 w-2.5 rounded-full opacity-80" style={{ backgroundColor: swatchColor }} />
                            <span>{props.t(option.labelKey)}</span>
                        </button>
                    )
                })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--app-hint)]">{props.t('settings.chat.surfaceColor.custom')}</span>
                <label
                    className={`inline-flex items-center rounded-xl border px-2 py-1 transition-colors ${
                        isCustomSelected
                            ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                            : 'border-[var(--app-border)] bg-[var(--app-bg)]'
                    }`}
                >
                    <input
                        aria-label={props.t('settings.chat.surfaceColor.custom')}
                        type="color"
                        value={pickerValue}
                        onChange={(event) => props.onCustomChange(event.target.value)}
                        className="h-8 w-11 cursor-pointer appearance-none border-0 bg-transparent p-0"
                    />
                </label>
            </div>
        </div>
    )
}

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const [isOpen, setIsOpen] = useState(false)
    const [isAppearanceOpen, setIsAppearanceOpen] = useState(false)
    const [isFontOpen, setIsFontOpen] = useState(false)
    const [isTerminalFontOpen, setIsTerminalFontOpen] = useState(false)
    const [isChatOpen, setIsChatOpen] = useState(false)
    const [isTerminalToolDisplayOpen, setIsTerminalToolDisplayOpen] = useState(false)
    const [isVoiceOpen, setIsVoiceOpen] = useState(false)
    const [isVoicePickerOpen, setIsVoicePickerOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const appearanceContainerRef = useRef<HTMLDivElement>(null)
    const fontContainerRef = useRef<HTMLDivElement>(null)
    const terminalFontContainerRef = useRef<HTMLDivElement>(null)
    const chatContainerRef = useRef<HTMLDivElement>(null)
    const terminalToolDisplayContainerRef = useRef<HTMLDivElement>(null)
    const voiceContainerRef = useRef<HTMLDivElement>(null)
    const voicePickerContainerRef = useRef<HTMLDivElement>(null)
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { sessionPreviewLimit, setSessionPreviewLimit } = useSessionPreviewLimit()
    const { composerEnterBehavior, setComposerEnterBehavior } = useComposerEnterBehavior()
    const { terminalToolDisplayMode, setTerminalToolDisplayMode } = useTerminalToolDisplayMode()
    const {
        toolGroupBackground,
        userMessageBackground,
        setToolGroupBackground,
        setUserMessageBackground,
    } = useChatSurfaceColors()
    const { appearance, setAppearance } = useAppearance()

    // Voice language state - read from localStorage
    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-lang')
    })

    // Voice ID state - read from localStorage
    const [voiceId, setVoiceId] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-id')
    })

    // Dynamic voice list fetched from hub (includes user's cloned voices)
    const [dynamicVoices, setDynamicVoices] = useState<VoiceInfo[] | null>(null)
    const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null)
    const currentAudioRef = useRef<HTMLAudioElement | null>(null)

    const fontScaleOptions = getFontScaleOptions()
    const terminalFontSizeOptions = getTerminalFontSizeOptions()
    const composerEnterBehaviorOptions = getComposerEnterBehaviorOptions()
    const terminalToolDisplayModeOptions = getTerminalToolDisplayModeOptions()
    const appearanceOptions = getAppearanceOptions()
    const currentLocale = locales.find((loc) => loc.value === locale)
    const currentAppearanceLabel = appearanceOptions.find((opt) => opt.value === appearance)?.labelKey ?? 'settings.display.appearance.system'
    const currentFontScaleLabel = fontScaleOptions.find((opt) => opt.value === fontScale)?.label ?? '100%'
    const currentTerminalFontSizeLabel = terminalFontSizeOptions.find((opt) => opt.value === terminalFontSize)?.label ?? '13px'
    const currentComposerEnterBehaviorLabel = composerEnterBehaviorOptions.find((opt) => opt.value === composerEnterBehavior)?.labelKey ?? 'settings.chat.enterBehavior.send'
    const currentTerminalToolDisplayModeLabel = terminalToolDisplayModeOptions.find((opt) => opt.value === terminalToolDisplayMode)?.labelKey ?? 'settings.chat.terminalToolDisplay.compact'
    const currentVoiceLanguage = voiceLanguages.find((lang) => lang.code === voiceLanguage)

    // Voice list: dynamic (from ElevenLabs API, includes clones) or static fallback
    const fallbackVoices = getFallbackVoices(locale)
    const voiceOptions: VoiceInfo[] = dynamicVoices && dynamicVoices.length > 0
        ? dynamicVoices
        : fallbackVoices.map(v => ({ id: v.id, name: v.name, previewUrl: '', category: 'premade' }))

    const currentVoiceName = voiceId
        ? (voiceOptions.find(v => v.id === voiceId)?.name ?? fallbackVoices.find(v => v.id === voiceId)?.name ?? voiceId)
        : null

    const handleLocaleChange = (newLocale: Locale) => {
        setLocale(newLocale)
        setIsOpen(false)
    }

    const handleAppearanceChange = (pref: AppearancePreference) => {
        setAppearance(pref)
        setIsAppearanceOpen(false)
    }

    const handleFontScaleChange = (newScale: FontScale) => {
        setFontScale(newScale)
        setIsFontOpen(false)
    }

    const handleTerminalFontSizeChange = (newSize: TerminalFontSize) => {
        setTerminalFontSize(newSize)
        setIsTerminalFontOpen(false)
    }

    const handleComposerEnterBehaviorChange = (newBehavior: ComposerEnterBehavior) => {
        setComposerEnterBehavior(newBehavior)
        setIsChatOpen(false)
    }

    const handleTerminalToolDisplayModeChange = (newMode: TerminalToolDisplayMode) => {
        setTerminalToolDisplayMode(newMode)
        setIsTerminalToolDisplayOpen(false)
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

    const handleVoiceChange = (id: string | null) => {
        setVoiceId(id)
        if (id === null) {
            localStorage.removeItem('hapi-voice-id')
        } else {
            localStorage.setItem('hapi-voice-id', id)
        }
        setIsVoicePickerOpen(false)
    }

    // Fetch available voices from hub on mount
    useEffect(() => {
        fetchVoices(api).then(voices => {
            if (voices.length > 0) setDynamicVoices(voices)
        })
    }, [api])

    const handleVoicePreview = (previewUrl: string, voiceId: string, event: React.MouseEvent) => {
        event.stopPropagation()
        if (!previewUrl) return

        if (playingVoiceId === voiceId) {
            currentAudioRef.current?.pause()
            currentAudioRef.current = null
            setPlayingVoiceId(null)
            return
        }

        currentAudioRef.current?.pause()
        const audio = new Audio(previewUrl)
        currentAudioRef.current = audio
        setPlayingVoiceId(voiceId)
        audio.play().catch(() => setPlayingVoiceId(null))
        audio.addEventListener('ended', () => {
            setPlayingVoiceId(null)
            currentAudioRef.current = null
        })
    }

    useEffect(() => {
        return () => {
            currentAudioRef.current?.pause()
            currentAudioRef.current = null
            setPlayingVoiceId(null)
        }
    }, [])

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen && !isAppearanceOpen && !isFontOpen && !isTerminalFontOpen && !isChatOpen && !isTerminalToolDisplayOpen && !isVoiceOpen && !isVoicePickerOpen) return

        const handleClickOutside = (event: MouseEvent) => {
            if (isOpen && containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
            if (isAppearanceOpen && appearanceContainerRef.current && !appearanceContainerRef.current.contains(event.target as Node)) {
                setIsAppearanceOpen(false)
            }
            if (isFontOpen && fontContainerRef.current && !fontContainerRef.current.contains(event.target as Node)) {
                setIsFontOpen(false)
            }
            if (isTerminalFontOpen && terminalFontContainerRef.current && !terminalFontContainerRef.current.contains(event.target as Node)) {
                setIsTerminalFontOpen(false)
            }
            if (isChatOpen && chatContainerRef.current && !chatContainerRef.current.contains(event.target as Node)) {
                setIsChatOpen(false)
            }
            if (isTerminalToolDisplayOpen && terminalToolDisplayContainerRef.current && !terminalToolDisplayContainerRef.current.contains(event.target as Node)) {
                setIsTerminalToolDisplayOpen(false)
            }
            if (isVoiceOpen && voiceContainerRef.current && !voiceContainerRef.current.contains(event.target as Node)) {
                setIsVoiceOpen(false)
            }
            if (isVoicePickerOpen && voicePickerContainerRef.current && !voicePickerContainerRef.current.contains(event.target as Node)) {
                setIsVoicePickerOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen, isAppearanceOpen, isFontOpen, isTerminalFontOpen, isChatOpen, isTerminalToolDisplayOpen, isVoiceOpen, isVoicePickerOpen])

    // Close on escape key
    useEffect(() => {
        if (!isOpen && !isAppearanceOpen && !isFontOpen && !isTerminalFontOpen && !isChatOpen && !isTerminalToolDisplayOpen && !isVoiceOpen && !isVoicePickerOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
                setIsAppearanceOpen(false)
                setIsFontOpen(false)
                setIsTerminalFontOpen(false)
                setIsChatOpen(false)
                setIsTerminalToolDisplayOpen(false)
                setIsVoiceOpen(false)
                setIsVoicePickerOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, isAppearanceOpen, isFontOpen, isTerminalFontOpen, isChatOpen, isTerminalToolDisplayOpen, isVoiceOpen, isVoicePickerOpen])

    return (
        <div className="flex h-full min-h-0 flex-col">
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

            <div className="app-scroll-y flex-1 min-h-0">
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
                        <div ref={appearanceContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsAppearanceOpen(!isAppearanceOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isAppearanceOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.display.appearance')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{t(currentAppearanceLabel)}</span>
                                    <ChevronDownIcon className={`transition-transform ${isAppearanceOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isAppearanceOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[160px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.display.appearance')}
                                >
                                    {appearanceOptions.map((opt) => {
                                        const isSelected = appearance === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleAppearanceChange(opt.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{t(opt.labelKey)}</span>
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
                        <div ref={terminalFontContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsTerminalFontOpen(!isTerminalFontOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isTerminalFontOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.display.terminalFontSize')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentTerminalFontSizeLabel}</span>
                                    <ChevronDownIcon className={`transition-transform ${isTerminalFontOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isTerminalFontOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[140px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.display.terminalFontSize')}
                                >
                                    {terminalFontSizeOptions.map((opt) => {
                                        const isSelected = terminalFontSize === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleTerminalFontSizeChange(opt.value)}
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
                        <SessionPreviewLimitControl
                            label={t('settings.display.sessionPreviewLimit')}
                            value={sessionPreviewLimit}
                            onChange={setSessionPreviewLimit}
                            decreaseLabel={t('settings.display.sessionPreviewLimit.decrease')}
                            increaseLabel={t('settings.display.sessionPreviewLimit.increase')}
                        />
                    </div>

                    {/* Chat section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.chat.title')}
                        </div>
                        <div ref={chatContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsChatOpen(!isChatOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isChatOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.chat.enterBehavior')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{t(currentComposerEnterBehaviorLabel)}</span>
                                    <ChevronDownIcon className={`transition-transform ${isChatOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isChatOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[170px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.chat.enterBehavior')}
                                >
                                    {composerEnterBehaviorOptions.map((opt) => {
                                        const isSelected = composerEnterBehavior === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleComposerEnterBehaviorChange(opt.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{t(opt.labelKey)}</span>
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
                        <div ref={terminalToolDisplayContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsTerminalToolDisplayOpen(!isTerminalToolDisplayOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isTerminalToolDisplayOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.chat.terminalToolDisplay')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{t(currentTerminalToolDisplayModeLabel)}</span>
                                    <ChevronDownIcon className={`transition-transform ${isTerminalToolDisplayOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isTerminalToolDisplayOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[230px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.chat.terminalToolDisplay')}
                                >
                                    {terminalToolDisplayModeOptions.map((opt) => {
                                        const isSelected = terminalToolDisplayMode === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleTerminalToolDisplayModeChange(opt.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{t(opt.labelKey)}</span>
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
                        <ChatSurfaceColorControl
                            label={t('settings.chat.groupedToolBackground')}
                            preference={toolGroupBackground}
                            onPresetChange={(preset) => setToolGroupBackground(toPresetChatSurfaceColorPreference(preset))}
                            onCustomChange={(value) => setToolGroupBackground(toCustomChatSurfaceColorPreference(value))}
                            t={t}
                        />
                        <ChatSurfaceColorControl
                            label={t('settings.chat.userMessageBackground')}
                            preference={userMessageBackground}
                            onPresetChange={(preset) => setUserMessageBackground(toPresetChatSurfaceColorPreference(preset))}
                            onCustomChange={(value) => setUserMessageBackground(toCustomChatSurfaceColorPreference(value))}
                            t={t}
                        />
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

                        <div ref={voicePickerContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsVoicePickerOpen(!isVoicePickerOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isVoicePickerOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.voice.voice')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentVoiceName ?? t('settings.voice.voiceDefault')}</span>
                                    <ChevronDownIcon className={`transition-transform ${isVoicePickerOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isVoicePickerOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[220px] max-h-[300px] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg z-50"
                                    role="listbox"
                                    aria-label={t('settings.voice.voice')}
                                >
                                    <div
                                        role="option"
                                        aria-selected={voiceId === null}
                                        className={`flex items-center w-full text-base transition-colors ${
                                            voiceId === null
                                                ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                        }`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => handleVoiceChange(null)}
                                            className="flex flex-1 items-center justify-between px-3 py-2 text-left"
                                        >
                                            <span>{t('settings.voice.voiceDefault')}</span>
                                            {voiceId === null && <span className="ml-2"><CheckIcon /></span>}
                                        </button>
                                    </div>
                                    {voiceOptions.map((voice) => {
                                        const isSelected = voiceId === voice.id
                                        const isPlaying = playingVoiceId === voice.id
                                        return (
                                            <div
                                                key={voice.id}
                                                role="option"
                                                aria-selected={isSelected}
                                                className={`flex items-center w-full text-base transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => handleVoiceChange(voice.id)}
                                                    className="flex flex-1 items-center justify-between px-3 py-2 text-left min-w-0"
                                                >
                                                    <span className="truncate">
                                                        {voice.name}
                                                        {voice.category === 'cloned' && (
                                                            <span className="ml-2 text-xs text-[var(--app-hint)]">clone</span>
                                                        )}
                                                    </span>
                                                    {isSelected && <span className="ml-2 shrink-0"><CheckIcon /></span>}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => handleVoicePreview(voice.previewUrl, voice.id, e)}
                                                    aria-label={isPlaying ? 'Stop preview' : 'Preview voice'}
                                                    title={voice.previewUrl ? (isPlaying ? 'Stop preview' : 'Preview voice') : 'Preview unavailable without an ElevenLabs API key'}
                                                    disabled={!voice.previewUrl}
                                                    className={`flex h-full shrink-0 items-center px-3 py-2 ${
                                                        voice.previewUrl
                                                            ? 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                                            : 'text-[var(--app-divider)] cursor-not-allowed'
                                                    }`}
                                                >
                                                    {isPlaying ? <StopIcon /> : <PlayIcon />}
                                                </button>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
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
