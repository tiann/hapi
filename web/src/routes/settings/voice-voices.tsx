import { useTranslation } from '@/lib/use-translation'
import { CheckIcon, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useVoiceSettings } from './useVoiceSettings'

function PlayIcon() {
    return <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true"><path d="m6 4 14 8-14 8V4Z" /></svg>
}

function StopIcon() {
    return <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true"><path d="M5 5h14v14H5z" /></svg>
}

export default function SettingsVoiceVoicesPage() {
    const { t } = useTranslation()
    const voice = useVoiceSettings()
    return (
        <SettingsPageContent title={t('settings.voice.voice')} description={t('settings.voice.voices.description')}>
            <SettingsSection>
                <div role="radiogroup" aria-label={t('settings.voice.voice')} className="divide-y divide-[var(--app-divider)]">
                    <button type="button" role="radio" aria-checked={voice.voiceId === null} onClick={() => voice.setVoice(null)} className={`flex min-h-12 w-full items-center justify-between px-3 py-3 text-left ${voice.voiceId === null ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}>
                        {t('settings.voice.voiceDefault')}
                        {voice.voiceId === null ? <CheckIcon className="h-4 w-4" /> : null}
                    </button>
                    {voice.voices.map((option) => {
                        const selected = voice.voiceId === option.id
                        const playing = voice.playingVoiceId === option.id
                        const canPreview = voice.backend === 'elevenlabs' && Boolean(option.previewUrl)
                        return (
                            <div key={option.id} className={`flex min-h-14 items-center ${selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}>
                                <button type="button" role="radio" aria-checked={selected} onClick={() => voice.setVoice(option.id)} className={`min-w-0 flex-1 px-3 py-2.5 text-left ${selected ? 'text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}>
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="min-w-0">
                                            <span className="block truncate font-medium">{option.name}</span>
                                            {option.description ? <span className="mt-0.5 block text-xs leading-snug text-[var(--app-hint)]">{option.description}</span> : null}
                                        </span>
                                        {selected ? <CheckIcon className="h-4 w-4 shrink-0" /> : null}
                                    </span>
                                </button>
                                <button type="button" disabled={!canPreview} onClick={() => voice.previewVoice(option)} aria-label={playing ? t('settings.voice.preview.stop') : t('settings.voice.preview.play')} title={canPreview ? (playing ? t('settings.voice.preview.stop') : t('settings.voice.preview.play')) : t(voice.backend === 'elevenlabs' ? 'settings.voice.preview.unavailable' : 'settings.voice.preview.elevenlabsOnly')} className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--app-hint)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30">
                                    {playing ? <StopIcon /> : <PlayIcon />}
                                </button>
                            </div>
                        )
                    })}
                </div>
            </SettingsSection>
        </SettingsPageContent>
    )
}
