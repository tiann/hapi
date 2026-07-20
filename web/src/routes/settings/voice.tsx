import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { VOICE_BACKEND_LABELS } from '@hapi/protocol/voicePickerCatalog'
import { getLanguageDisplayName } from '@/lib/languages'
import { useTranslation } from '@/lib/use-translation'
import { VoiceRespondsControls } from '@/components/settings/VoiceAdvancedControls'
import { SettingsChoiceGroup, SettingsLinkRow, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useVoiceSettings } from './useVoiceSettings'

export default function SettingsVoicePage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const voice = useVoiceSettings()
    const [opening, setOpening] = useState<'greet' | 'brief'>(() => localStorage.getItem('hapi-voice-proactive') === 'true' ? 'brief' : 'greet')
    const selectedLanguage = voice.voiceLanguages.find((language) => language.code === voice.voiceLanguage)
    const selectedVoice = voice.voices.find((option) => option.id === voice.voiceId)

    const setVoiceOpening = (value: 'greet' | 'brief') => {
        setOpening(value)
        if (value === 'brief') localStorage.setItem('hapi-voice-proactive', 'true')
        else localStorage.removeItem('hapi-voice-proactive')
    }

    return (
        <SettingsPageContent title={t('settings.voice.title')} description={t('settings.voice.description')}>
            <SettingsSection title={t('settings.voice.connection.title')} description={t('settings.voice.group.hint')}>
                {voice.configuredBackends.length > 1 && voice.backend ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.backend')}
                        value={voice.backend}
                        options={voice.configuredBackends.map((backend) => ({ value: backend, label: VOICE_BACKEND_LABELS[backend] }))}
                        onChange={voice.setBackend}
                    />
                ) : null}
                <label className="flex min-h-12 items-center justify-between gap-3 px-3 py-3">
                    <span className="text-[var(--app-fg)]">{t('settings.voice.language')}</span>
                    <select
                        value={voice.voiceLanguage ?? ''}
                        onChange={(event) => {
                            const language = voice.voiceLanguages.find((option) => (option.code ?? '') === event.target.value)
                            if (language) voice.setVoiceLanguage(language)
                        }}
                        className="max-w-[55%] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                    >
                        {voice.voiceLanguages.map((language) => <option key={language.code ?? 'auto'} value={language.code ?? ''}>{language.code === null ? t('settings.voice.autoDetect') : getLanguageDisplayName(language)}</option>)}
                    </select>
                </label>
                <SettingsLinkRow
                    label={t('settings.voice.voice')}
                    value={selectedVoice?.name ?? t('settings.voice.voiceDefault')}
                    description={selectedLanguage?.code ? getLanguageDisplayName(selectedLanguage) : t('settings.voice.autoDetect')}
                    onClick={() => navigate({ to: '/settings/voice/voices' })}
                />
            </SettingsSection>

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
        </SettingsPageContent>
    )
}
