import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { VOICE_BACKEND_LABELS } from '@hapi/protocol/voicePickerCatalog'
import { getLanguageDisplayName } from '@/lib/languages'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { VoiceRespondsControls } from '@/components/settings/VoiceAdvancedControls'
import { TranscriptionProviderOnboard } from '@/components/settings/TranscriptionProviderOnboard'
import { SettingsChoiceGroup, SettingsLinkRow, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { SelectControl } from '@/components/ui/select-control'
import { getNamespaceFromToken } from '@/components/settings/SettingsNav'
import { useVoiceSettings } from './useVoiceSettings'

export default function SettingsVoicePage() {
    const { t } = useTranslation()
    const { api, token } = useAppContext()
    const navigate = useNavigate()
    const voice = useVoiceSettings()
    const [opening, setOpening] = useState<'greet' | 'brief'>(() => localStorage.getItem('hapi-voice-proactive') === 'true' ? 'brief' : 'greet')
    const [showCredentials, setShowCredentials] = useState(false)
    const selectedLanguage = voice.voiceLanguages.find((language) => language.code === voice.voiceLanguage)
    const selectedVoice = voice.voices.find((option) => option.id === voice.voiceId)
    const hubProviders = voice.providers.filter((provider) => provider.id !== 'browser-local')
    const canManageCredentials = getNamespaceFromToken(token) === 'default'
    const needsDictationOnboard = voice.voiceMode === 'dictation' && hubProviders.length === 0
    const needsAssistantOnboard = voice.voiceMode === 'assistant' && voice.configuredBackends.length === 0
    const credentialsOpen = canManageCredentials && (showCredentials || needsDictationOnboard || needsAssistantOnboard)

    const setVoiceOpening = (value: 'greet' | 'brief') => {
        setOpening(value)
        if (value === 'brief') localStorage.setItem('hapi-voice-proactive', 'true')
        else localStorage.removeItem('hapi-voice-proactive')
    }

    const onCredentialsConfigured = () => {
        voice.refreshProviders()
        voice.refreshBackends()
        setShowCredentials(false)
    }

    return (
        <SettingsPageContent description={t('settings.voice.description')}>
            <SettingsSection title={t('settings.voice.inputMode.title')} description={t('settings.voice.inputMode.hint')}>
                <SettingsChoiceGroup
                    hideLabel
                    label={t('settings.voice.inputMode.title')}
                    value={voice.voiceMode}
                    options={[
                        { value: 'assistant', label: t('settings.voice.inputMode.assistant'), description: t('settings.voice.inputMode.assistant.hint') },
                        { value: 'dictation', label: t('settings.voice.inputMode.dictation'), description: t('settings.voice.inputMode.dictation.hint') }
                    ]}
                    onChange={(value) => {
                        voice.setVoiceMode(value)
                        setShowCredentials(false)
                    }}
                />
            </SettingsSection>

            <SettingsSection title={t('settings.voice.connection.title')} description={t('settings.voice.group.hint')}>
                {voice.voiceMode === 'assistant' && voice.configuredBackends.length > 1 && voice.backend ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.backend')}
                        value={voice.backend}
                        options={voice.configuredBackends.map((backend) => ({ value: backend, label: VOICE_BACKEND_LABELS[backend] }))}
                        onChange={voice.setBackend}
                    />
                ) : null}
                {voice.voiceMode === 'assistant' && voice.configuredBackends.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                        {t('settings.voice.noVoiceBackend')}
                    </div>
                ) : null}
                {voice.voiceMode === 'dictation' && voice.provider ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.transcriptionProvider')}
                        value={voice.provider}
                        options={voice.providers.map((provider) => ({ value: provider.id, label: provider.label }))}
                        onChange={voice.setProvider}
                    />
                ) : null}
                {voice.voiceMode === 'dictation' && hubProviders.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                        {t('settings.voice.noTranscriptionProvider')}
                    </div>
                ) : null}
                {voice.voiceMode === 'dictation' && voice.provider && voice.modes.length > 1 ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.transcriptionMode')}
                        value={voice.transcriptionMode}
                        options={voice.modes.map((mode) => ({
                            value: mode,
                            label: t(`settings.voice.transcriptionMode.${mode}`),
                            description: t(`settings.voice.transcriptionMode.${mode}.hint`)
                        }))}
                        onChange={voice.setTranscriptionMode}
                    />
                ) : null}
                {api && canManageCredentials ? (
                    <>
                        {!credentialsOpen ? (
                            <SettingsLinkRow
                                label={t('settings.voice.credentials.manage')}
                                description={
                                    voice.voiceMode === 'assistant'
                                        ? t('settings.voice.credentials.manageAssistantHint')
                                        : t('settings.voice.credentials.manageHint')
                                }
                                onClick={() => setShowCredentials(true)}
                            />
                        ) : null}
                        {credentialsOpen ? (
                            <TranscriptionProviderOnboard
                                api={api}
                                mode={voice.voiceMode === 'assistant' ? 'assistant' : 'dictation'}
                                onConfigured={onCredentialsConfigured}
                            />
                        ) : null}
                    </>
                ) : null}
                <label className="flex min-h-12 items-center justify-between gap-3 px-3 py-3">
                    <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.language')}</span>
                    <SelectControl
                        value={voice.voiceLanguage ?? ''}
                        onChange={(event) => {
                            const language = voice.voiceLanguages.find((option) => (option.code ?? '') === event.target.value)
                            if (language) voice.setVoiceLanguage(language)
                        }}
                        containerClassName="w-full max-w-[55%]"
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-2 text-sm text-[var(--app-fg)]"
                    >
                        {voice.voiceLanguages.map((language) => <option key={language.code ?? 'auto'} value={language.code ?? ''}>{language.code === null ? t('settings.voice.autoDetect') : getLanguageDisplayName(language)}</option>)}
                    </SelectControl>
                </label>
                {voice.voiceMode === 'assistant' ? (
                    <SettingsLinkRow
                        label={t('settings.voice.voice')}
                        value={selectedVoice?.name ?? t('settings.voice.voiceDefault')}
                        description={selectedLanguage?.code ? getLanguageDisplayName(selectedLanguage) : t('settings.voice.autoDetect')}
                        onClick={() => navigate({ to: '/settings/voice/voices' })}
                    />
                ) : null}
            </SettingsSection>

            {voice.voiceMode === 'assistant' ? (
                <>
                    <SettingsSection title={t('settings.voice.behaves.title')}>
                        <SettingsChoiceGroup
                            label={t('settings.voice.opening.label')}
                            value={opening}
                            options={(['greet', 'brief'] as const).map((value) => ({ value, label: t(`settings.voice.opening.${value}`), description: t(`settings.voice.opening.${value}.hint`) }))}
                            onChange={setVoiceOpening}
                        />
                        <VoiceRespondsControls t={t} voiceBackend={voice.backend} />
                    </SettingsSection>
                    <SettingsSection>
                        <SettingsLinkRow label={t('settings.voice.advanced.title')} description={t('settings.voice.advanced.hint')} onClick={() => navigate({ to: '/settings/voice/advanced' })} />
                    </SettingsSection>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
