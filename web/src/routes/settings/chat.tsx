import { useTranslation } from '@/lib/use-translation'
import { getComposerEnterBehaviorOptions, useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { getTerminalToolDisplayModeOptions, useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import {
    getChatSurfaceColorPickerValue,
    getChatSurfaceColorPresetOptions,
    toCustomChatSurfaceColorPreference,
    toPresetChatSurfaceColorPreference,
    useChatSurfaceColors,
    type ChatSurfaceColorPreference,
    type ChatSurfaceColorPreset,
} from '@/hooks/useChatSurfaceColors'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { ComposerToolbarLayoutControl } from '@/components/settings/ComposerToolbarLayoutControl'

function ChatSurfaceColorControl(props: {
    label: string
    preference: ChatSurfaceColorPreference
    onPresetChange: (preset: ChatSurfaceColorPreset) => void
    onCustomChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const pickerValue = getChatSurfaceColorPickerValue(props.preference)
    return (
        <fieldset className="px-3 py-3">
            <legend className="mb-2 text-[var(--app-fg)]">{props.label}</legend>
            <div role="radiogroup" aria-label={props.label} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {getChatSurfaceColorPresetOptions().map((option) => {
                    const preference = toPresetChatSurfaceColorPreference(option.value)
                    const selected = props.preference === preference
                    return (
                        <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => props.onPresetChange(option.value)} className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${selected ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'border-[var(--app-border)] text-[var(--app-fg)]'}`}>
                            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: getChatSurfaceColorPickerValue(preference) }} />
                            <span className="truncate">{t(option.labelKey)}</span>
                        </button>
                    )
                })}
            </div>
            <label className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--app-hint)]">
                {t('settings.chat.surfaceColor.custom')}
                <input type="color" value={pickerValue} onChange={(event) => props.onCustomChange(event.target.value)} className="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" />
            </label>
        </fieldset>
    )
}

export default function SettingsChatPage() {
    const { t } = useTranslation()
    const { composerEnterBehavior, setComposerEnterBehavior } = useComposerEnterBehavior()
    const { terminalToolDisplayMode, setTerminalToolDisplayMode } = useTerminalToolDisplayMode()
    const { toolGroupBackground, userMessageBackground, setToolGroupBackground, setUserMessageBackground } = useChatSurfaceColors()
    return (
        <SettingsPageContent title={t('settings.chat.title')} description={t('settings.chat.description')}>
            <SettingsSection title={t('settings.chat.input')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.enterBehavior')}
                    value={composerEnterBehavior}
                    options={getComposerEnterBehaviorOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setComposerEnterBehavior}
                />
                <ComposerToolbarLayoutControl />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.tools')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.terminalToolDisplay')}
                    value={terminalToolDisplayMode}
                    options={getTerminalToolDisplayModeOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setTerminalToolDisplayMode}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.colors')}>
                <ChatSurfaceColorControl label={t('settings.chat.groupedToolBackground')} preference={toolGroupBackground} onPresetChange={(preset) => setToolGroupBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setToolGroupBackground(toCustomChatSurfaceColorPreference(value))} />
                <ChatSurfaceColorControl label={t('settings.chat.userMessageBackground')} preference={userMessageBackground} onPresetChange={(preset) => setUserMessageBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setUserMessageBackground(toCustomChatSurfaceColorPreference(value))} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
