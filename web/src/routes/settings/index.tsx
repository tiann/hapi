import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import type { SessionProfile } from '@hapi/protocol'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useUpdateMachineSessionProfiles } from '@/hooks/mutations/useUpdateMachineSessionProfiles'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineSessionProfiles } from '@/hooks/queries/useMachineSessionProfiles'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName, type Language } from '@/lib/languages'
import { getFontScaleOptions, useFontScale, type FontScale } from '@/hooks/useFontScale'
import { getTerminalFontSizeOptions, useTerminalFontSize, type TerminalFontSize } from '@/hooks/useTerminalFontSize'
import { useAppearance, getAppearanceOptions, type AppearancePreference } from '@/hooks/useTheme'
import { MODEL_OPTIONS } from '@/components/NewSession/types'
import { PROTOCOL_VERSION } from '@hapi/protocol'

const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

const voiceLanguages = getElevenLabsSupportedLanguages()

type ProfileFormState = {
    sourceId: string | null
    id: string
    label: string
    model: string
    modelReasoningEffort: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    permissionMode: '' | 'default' | 'read-only' | 'safe-yolo' | 'yolo'
    collaborationMode: '' | 'default' | 'plan'
    sessionType: '' | 'simple' | 'worktree'
}

const codexModelOptions = MODEL_OPTIONS.codex
const codexReasoningEffortValues: Array<ProfileFormState['modelReasoningEffort']> = [
    '',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
]
const codexCollaborationModeValues: Array<ProfileFormState['collaborationMode']> = ['', 'default', 'plan']
const codexSessionTypeValues: Array<ProfileFormState['sessionType']> = ['', 'simple', 'worktree']

function createEmptyProfileForm(): ProfileFormState {
    return {
        sourceId: null,
        id: '',
        label: '',
        model: '',
        modelReasoningEffort: '',
        permissionMode: '',
        collaborationMode: '',
        sessionType: ''
    }
}

function toProfileForm(profile: SessionProfile): ProfileFormState {
    return {
        sourceId: profile.id,
        id: profile.id,
        label: profile.label,
        model: profile.defaults.model ?? '',
        modelReasoningEffort: profile.defaults.modelReasoningEffort ?? '',
        permissionMode: profile.defaults.permissionMode ?? '',
        collaborationMode: profile.defaults.collaborationMode ?? '',
        sessionType: profile.defaults.sessionType ?? ''
    }
}

function buildProfileFromForm(form: ProfileFormState): SessionProfile {
    return {
        id: form.id.trim(),
        label: form.label.trim(),
        agent: 'codex',
        defaults: {
            ...(form.model ? { model: form.model } : {}),
            ...(form.modelReasoningEffort ? { modelReasoningEffort: form.modelReasoningEffort } : {}),
            ...(form.permissionMode ? { permissionMode: form.permissionMode } : {}),
            ...(form.collaborationMode ? { collaborationMode: form.collaborationMode } : {}),
            ...(form.sessionType ? { sessionType: form.sessionType } : {}),
        }
    }
}

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
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const [isOpen, setIsOpen] = useState(false)
    const [isAppearanceOpen, setIsAppearanceOpen] = useState(false)
    const [isFontOpen, setIsFontOpen] = useState(false)
    const [isTerminalFontOpen, setIsTerminalFontOpen] = useState(false)
    const [isVoiceOpen, setIsVoiceOpen] = useState(false)
    const [machineId, setMachineId] = useState<string | null>(null)
    const [profileForm, setProfileForm] = useState<ProfileFormState>(createEmptyProfileForm)
    const [profileFormError, setProfileFormError] = useState<string | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const appearanceContainerRef = useRef<HTMLDivElement>(null)
    const fontContainerRef = useRef<HTMLDivElement>(null)
    const terminalFontContainerRef = useRef<HTMLDivElement>(null)
    const voiceContainerRef = useRef<HTMLDivElement>(null)
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { appearance, setAppearance } = useAppearance()
    const { machines, isLoading: isMachinesLoading, error: machinesError } = useMachines(api, true)
    const {
        profiles,
        defaults,
        isLoading: isProfilesLoading,
        error: profilesError
    } = useMachineSessionProfiles(api, machineId)
    const {
        updateMachineSessionProfiles,
        isPending: isProfilesSaving,
        error: updateProfilesError
    } = useUpdateMachineSessionProfiles(api)

    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-lang')
    })

    const fontScaleOptions = getFontScaleOptions()
    const terminalFontSizeOptions = getTerminalFontSizeOptions()
    const appearanceOptions = getAppearanceOptions()
    const currentLocale = locales.find((loc) => loc.value === locale)
    const currentAppearanceLabel = appearanceOptions.find((opt) => opt.value === appearance)?.labelKey ?? 'settings.display.appearance.system'
    const currentFontScaleLabel = fontScaleOptions.find((opt) => opt.value === fontScale)?.label ?? '100%'
    const currentTerminalFontSizeLabel = terminalFontSizeOptions.find((opt) => opt.value === terminalFontSize)?.label ?? '13px'
    const currentVoiceLanguage = voiceLanguages.find((lang) => lang.code === voiceLanguage)

    useEffect(() => {
        if (machines.length === 0) {
            setMachineId(null)
            return
        }

        if (machineId && machines.some((machine) => machine.id === machineId)) {
            return
        }

        setMachineId(machines[0]?.id ?? null)
    }, [machineId, machines])

    useEffect(() => {
        setProfileForm(createEmptyProfileForm())
        setProfileFormError(null)
    }, [machineId])

    useEffect(() => {
        if (!profileForm.sourceId) {
            return
        }

        if (!profiles.some((profile) => profile.id === profileForm.sourceId)) {
            setProfileForm(createEmptyProfileForm())
        }
    }, [profiles, profileForm.sourceId])

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

    const handleVoiceLanguageChange = (language: Language) => {
        setVoiceLanguage(language.code)
        if (language.code === null) {
            localStorage.removeItem('hapi-voice-lang')
        } else {
            localStorage.setItem('hapi-voice-lang', language.code)
        }
        setIsVoiceOpen(false)
    }

    useEffect(() => {
        if (!isOpen && !isAppearanceOpen && !isFontOpen && !isTerminalFontOpen && !isVoiceOpen) return

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
            if (isVoiceOpen && voiceContainerRef.current && !voiceContainerRef.current.contains(event.target as Node)) {
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen, isAppearanceOpen, isFontOpen, isTerminalFontOpen, isVoiceOpen])

    useEffect(() => {
        if (!isOpen && !isAppearanceOpen && !isFontOpen && !isTerminalFontOpen && !isVoiceOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
                setIsAppearanceOpen(false)
                setIsFontOpen(false)
                setIsTerminalFontOpen(false)
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, isAppearanceOpen, isFontOpen, isTerminalFontOpen, isVoiceOpen])

    function updateProfileField<Key extends keyof ProfileFormState>(key: Key, value: ProfileFormState[Key]) {
        setProfileForm((current) => ({
            ...current,
            [key]: value
        }))
        setProfileFormError(null)
    }

    async function persistProfiles(nextProfiles: SessionProfile[], nextDefaultProfileId: string | null): Promise<boolean> {
        if (!machineId) {
            return false
        }

        setProfileFormError(null)

        try {
            await updateMachineSessionProfiles({
                machineId,
                payload: {
                    profiles: nextProfiles,
                    defaults: {
                        codexProfileId: nextDefaultProfileId
                    }
                }
            })
            return true
        } catch (error) {
            setProfileFormError(error instanceof Error ? error.message : t('settings.codexProfiles.form.saveError'))
            return false
        }
    }

    async function handleDefaultProfileChange(event: ChangeEvent<HTMLSelectElement>) {
        const nextDefaultProfileId = event.target.value || null
        await persistProfiles(profiles, nextDefaultProfileId)
    }

    function handleEditProfile(profile: SessionProfile) {
        setProfileForm(toProfileForm(profile))
        setProfileFormError(null)
    }

    function handleNewProfile() {
        setProfileForm(createEmptyProfileForm())
        setProfileFormError(null)
    }

    async function handleDeleteProfile(profileIdToDelete: string) {
        const nextProfiles = profiles.filter((profile) => profile.id !== profileIdToDelete)
        const nextDefaultProfileId = defaults.codexProfileId === profileIdToDelete
            ? null
            : defaults.codexProfileId ?? null

        const saved = await persistProfiles(nextProfiles, nextDefaultProfileId)
        if (!saved) {
            return
        }

        if (profileForm.sourceId === profileIdToDelete) {
            setProfileForm(createEmptyProfileForm())
        }
    }

    async function handleSaveProfile() {
        const trimmedId = profileForm.id.trim()
        const trimmedLabel = profileForm.label.trim()

        if (!trimmedId) {
            setProfileFormError(t('settings.codexProfiles.form.validation.idRequired'))
            return
        }

        if (!trimmedLabel) {
            setProfileFormError(t('settings.codexProfiles.form.validation.labelRequired'))
            return
        }

        const duplicateProfile = profiles.find((profile) => (
            profile.id === trimmedId && profile.id !== profileForm.sourceId
        ))
        if (duplicateProfile) {
            setProfileFormError(t('settings.codexProfiles.form.validation.idDuplicate'))
            return
        }

        const nextProfile = buildProfileFromForm({
            ...profileForm,
            id: trimmedId,
            label: trimmedLabel
        })

        const nextProfiles = profileForm.sourceId
            ? profiles.map((profile) => profile.id === profileForm.sourceId ? nextProfile : profile)
            : [...profiles, nextProfile]
        const nextDefaultProfileId = defaults.codexProfileId === profileForm.sourceId
            ? nextProfile.id
            : defaults.codexProfileId ?? null

        const saved = await persistProfiles(nextProfiles, nextDefaultProfileId)
        if (!saved) {
            return
        }

        setProfileForm(toProfileForm(nextProfile))
    }

    const isProfileSectionDisabled = isProfilesSaving || isMachinesLoading || !machineId
    const combinedProfilesError = profileFormError ?? updateProfilesError ?? profilesError

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
                    </div>

                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.codexProfiles.title')}
                        </div>
                        <div className="flex flex-col gap-3 px-3 py-3">
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="settings-codex-machine" className="text-sm text-[var(--app-fg)]">
                                    {t('settings.codexProfiles.machine')}
                                </label>
                                <select
                                    id="settings-codex-machine"
                                    aria-label={t('settings.codexProfiles.machine')}
                                    value={machineId ?? ''}
                                    onChange={(event) => setMachineId(event.target.value || null)}
                                    disabled={isMachinesLoading || machines.length === 0}
                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                >
                                    {machines.map((machine) => (
                                        <option key={machine.id} value={machine.id}>
                                            {machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {machinesError ? (
                                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                                    {machinesError}
                                </div>
                            ) : null}

                            {machineId ? (
                                <>
                                    <div className="flex flex-col gap-1.5">
                                        <label htmlFor="settings-codex-default-profile" className="text-sm text-[var(--app-fg)]">
                                            {t('settings.codexProfiles.default')}
                                        </label>
                                        <select
                                            id="settings-codex-default-profile"
                                            aria-label={t('settings.codexProfiles.default')}
                                            value={defaults.codexProfileId ?? ''}
                                            onChange={handleDefaultProfileChange}
                                            disabled={isProfileSectionDisabled || isProfilesLoading}
                                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                        >
                                            <option value="">{t('settings.codexProfiles.default.none')}</option>
                                            {profiles.map((profile) => (
                                                <option key={profile.id} value={profile.id}>
                                                    {profile.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {isProfilesLoading ? (
                                        <div className="rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">
                                            {t('settings.codexProfiles.loading')}
                                        </div>
                                    ) : null}

                                    {profiles.length === 0 && !isProfilesLoading ? (
                                        <div className="rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">
                                            {t('settings.codexProfiles.empty')}
                                        </div>
                                    ) : null}

                                    {profiles.length > 0 ? (
                                        <div className="overflow-hidden rounded-lg border border-[var(--app-divider)]">
                                            {profiles.map((profile) => (
                                                <div
                                                    key={profile.id}
                                                    className="flex items-start justify-between gap-3 border-b border-[var(--app-divider)] px-3 py-3 last:border-b-0"
                                                >
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="font-medium text-[var(--app-fg)]">{profile.label}</span>
                                                            {defaults.codexProfileId === profile.id ? (
                                                                <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]">
                                                                    {t('settings.codexProfiles.default.badge')}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                        <div className="mt-1 text-xs text-[var(--app-hint)]">{profile.id}</div>
                                                        <div className="mt-2 flex flex-wrap gap-1">
                                                            {Object.entries(profile.defaults).map(([key, value]) => (
                                                                <span
                                                                    key={`${profile.id}-${key}`}
                                                                    className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
                                                                >
                                                                    {String(value)}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                    <div className="flex shrink-0 gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleEditProfile(profile)}
                                                            disabled={isProfileSectionDisabled}
                                                            className="rounded-md border border-[var(--app-divider)] px-3 py-1.5 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                                        >
                                                            {t('settings.codexProfiles.form.editAction')}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleDeleteProfile(profile.id)}
                                                            disabled={isProfileSectionDisabled}
                                                            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/40 dark:text-red-400 dark:hover:bg-red-900/20"
                                                        >
                                                            {t('settings.codexProfiles.form.deleteAction')}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : null}

                                    <div className="rounded-lg border border-[var(--app-divider)] px-3 py-3">
                                        <div className="mb-3 flex items-center justify-between gap-2">
                                            <div className="font-medium text-[var(--app-fg)]">
                                                {profileForm.sourceId
                                                    ? t('settings.codexProfiles.form.edit')
                                                    : t('settings.codexProfiles.form.new')}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleNewProfile}
                                                disabled={isProfileSectionDisabled}
                                                className="rounded-md border border-[var(--app-divider)] px-3 py-1.5 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                            >
                                                {t('settings.codexProfiles.form.new')}
                                            </button>
                                        </div>

                                        <div className="grid gap-3 md:grid-cols-2">
                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-id" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.id')}
                                                </label>
                                                <input
                                                    id="settings-codex-profile-id"
                                                    aria-label={t('settings.codexProfiles.form.id')}
                                                    value={profileForm.id}
                                                    onChange={(event) => updateProfileField('id', event.target.value)}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                />
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-label" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.label')}
                                                </label>
                                                <input
                                                    id="settings-codex-profile-label"
                                                    aria-label={t('settings.codexProfiles.form.label')}
                                                    value={profileForm.label}
                                                    onChange={(event) => updateProfileField('label', event.target.value)}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                />
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-model" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.model')}
                                                </label>
                                                <select
                                                    id="settings-codex-profile-model"
                                                    aria-label={t('settings.codexProfiles.form.model')}
                                                    value={profileForm.model}
                                                    onChange={(event) => updateProfileField('model', event.target.value)}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                >
                                                    <option value="">{t('settings.codexProfiles.form.unset')}</option>
                                                    {codexModelOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-reasoning" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.reasoningEffort')}
                                                </label>
                                                <select
                                                    id="settings-codex-profile-reasoning"
                                                    aria-label={t('settings.codexProfiles.form.reasoningEffort')}
                                                    value={profileForm.modelReasoningEffort}
                                                    onChange={(event) => updateProfileField('modelReasoningEffort', event.target.value as ProfileFormState['modelReasoningEffort'])}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                >
                                                    {codexReasoningEffortValues.map((value) => (
                                                        <option key={value || 'unset'} value={value}>
                                                            {value
                                                                ? t(`settings.codexProfiles.form.reasoningEffort.${value}`)
                                                                : t('settings.codexProfiles.form.unset')}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-permission" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.permissionMode')}
                                                </label>
                                                <select
                                                    id="settings-codex-profile-permission"
                                                    aria-label={t('settings.codexProfiles.form.permissionMode')}
                                                    value={profileForm.permissionMode}
                                                    onChange={(event) => updateProfileField('permissionMode', event.target.value as ProfileFormState['permissionMode'])}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                >
                                                    <option value="">{t('settings.codexProfiles.form.unset')}</option>
                                                    <option value="default">{t('newSession.permissionMode.default')}</option>
                                                    <option value="read-only">{t('newSession.permissionMode.readOnly')}</option>
                                                    <option value="safe-yolo">{t('newSession.permissionMode.safeYolo')}</option>
                                                    <option value="yolo">{t('newSession.permissionMode.yolo')}</option>
                                                </select>
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-collaboration" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.collaborationMode')}
                                                </label>
                                                <select
                                                    id="settings-codex-profile-collaboration"
                                                    aria-label={t('settings.codexProfiles.form.collaborationMode')}
                                                    value={profileForm.collaborationMode}
                                                    onChange={(event) => updateProfileField('collaborationMode', event.target.value as ProfileFormState['collaborationMode'])}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                >
                                                    {codexCollaborationModeValues.map((value) => (
                                                        <option key={value || 'unset'} value={value}>
                                                            {value
                                                                ? t(`settings.codexProfiles.form.collaborationMode.${value}`)
                                                                : t('settings.codexProfiles.form.unset')}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div className="flex flex-col gap-1.5">
                                                <label htmlFor="settings-codex-profile-session-type" className="text-sm text-[var(--app-fg)]">
                                                    {t('settings.codexProfiles.form.sessionType')}
                                                </label>
                                                <select
                                                    id="settings-codex-profile-session-type"
                                                    aria-label={t('settings.codexProfiles.form.sessionType')}
                                                    value={profileForm.sessionType}
                                                    onChange={(event) => updateProfileField('sessionType', event.target.value as ProfileFormState['sessionType'])}
                                                    disabled={isProfileSectionDisabled}
                                                    className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                                                >
                                                    {codexSessionTypeValues.map((value) => (
                                                        <option key={value || 'unset'} value={value}>
                                                            {value
                                                                ? t(`newSession.type.${value}`)
                                                                : t('settings.codexProfiles.form.unset')}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>

                                        {combinedProfilesError ? (
                                            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                                                {combinedProfilesError}
                                            </div>
                                        ) : null}

                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleSaveProfile()}
                                                disabled={isProfileSectionDisabled}
                                                className="rounded-md bg-[var(--app-link)] px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                            >
                                                {profileForm.sourceId
                                                    ? t('settings.codexProfiles.form.update')
                                                    : t('settings.codexProfiles.form.create')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleNewProfile}
                                                disabled={isProfileSectionDisabled}
                                                className="rounded-md border border-[var(--app-divider)] px-4 py-2 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                            >
                                                {t('settings.codexProfiles.form.cancel')}
                                            </button>
                                        </div>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </div>

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
