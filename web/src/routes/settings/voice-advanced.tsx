import { useTranslation } from '@/lib/use-translation'
import { VoiceDiagnosticsControls, VoicePersonaControls, VoiceSoundsControls } from '@/components/settings/VoiceAdvancedControls'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useVoiceSettings } from './useVoiceSettings'

export default function SettingsVoiceAdvancedPage() {
    const { t } = useTranslation()
    const { backend } = useVoiceSettings()
    return (
        <SettingsPageContent title={t('settings.voice.advanced.title')} description={t('settings.voice.advanced.hint')}>
            <SettingsSection title={t('settings.voice.persona.title')}>
                <VoicePersonaControls t={t} voiceBackend={backend} />
            </SettingsSection>
            <SettingsSection title={t('settings.voice.sounds.title')}>
                <VoiceSoundsControls t={t} voiceBackend={backend} />
            </SettingsSection>
            <SettingsSection title={t('settings.voice.advanced.section.title')}>
                <VoiceDiagnosticsControls t={t} voiceBackend={backend} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
