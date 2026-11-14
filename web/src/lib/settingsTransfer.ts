import { VOICE_PERSONALITY_STORAGE_KEY } from '@hapi/protocol/voice-personality'
import { LEGACY_ELEVENLABS_VOICE_STORAGE_KEY, VOICE_BACKEND_PREFERENCE_STORAGE_KEY, VOICE_PICKER_STORAGE_KEYS } from '@hapi/protocol/voicePickerCatalog'

/**
 * localStorage keys that hold user settings, i.e. values the user chose to
 * configure the app that make sense on another browser on the same hub,
 * plus legacy keys a setting still falls back to. Only these keys are
 * exported or imported.
 *
 * Adding a `hapi*` storage key? Put it here if it is a setting, otherwise in
 * NOT_SETTINGS_KEYS in settingsTransfer.test.ts. That test fails on unclassified keys.
 */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
    // Display
    'hapi-appearance',
    'hapi-color-theme',
    'hapi-theme-colors',
    'hapi-font-scale',
    'hapi-terminal-font-size',
    'hapi-lang',
    'hapi-code-wrap',
    'hapi-tool-card-display-mode',
    'hapi-tool-grouping-mode', // legacy fallbacks, still read when the key above is unset
    'hapi-terminal-tool-display-mode',
    'hapi-tool-group-bg',
    'hapi-user-message-bg',
    'hapi-concise-chat-mode',
    'hapi-reasoning-collapsed',
    'hapi-codex-exploration-collapsed',
    'hapi-session-header-metadata',
    'hapi.filePreview.markdownMode.v1',
    // Chat and composer
    'hapi-composer-enter-behavior',
    'hapi-composer-toolbar-layout',
    'hapi.composer.richMentions',
    'hapi-open-external-links-in-new-tab',
    'hapi-auto-bridge-transient-model-errors',
    'hapi.sessionExportFormat',
    // Sessions, machines, files
    'hapi-app-badge-enabled',
    'hapi-keep-unread-sessions-visible',
    'hapi-pin-in-progress-sessions',
    'hapi-session-list-status-mode',
    'hapi-session-list-status',
    'hapi-session-list-sort',
    'hapi-session-list-active-first',
    'hapi-session-list-unread-only',
    'hapi-show-active-sessions-only', // legacy fallback for hapi-session-list-status
    'hapi-session-preview-limit',
    'hapi-machine-labels',
    'hapi-directory-sort',
    'hapi:workspaceBrowserShowHidden',
    // Voice
    'hapi-voice-mode',
    'hapi-voice-lang',
    'hapi-voice-proactive',
    'hapi-transcription-provider',
    'hapi-transcription-mode',
    VOICE_BACKEND_PREFERENCE_STORAGE_KEY,
    ...Object.values(VOICE_PICKER_STORAGE_KEYS),
    LEGACY_ELEVENLABS_VOICE_STORAGE_KEY,
    VOICE_PERSONALITY_STORAGE_KEY,
]

const FORMAT = 'hapi-web-settings'

export type SettingsFile = {
    format: typeof FORMAT
    version: 1
    exportedAt: string
    settings: Record<string, string>
}

export function exportSettings(storage: Storage = localStorage): SettingsFile {
    const settings: Record<string, string> = {}
    for (const key of SETTINGS_STORAGE_KEYS) {
        const value = storage.getItem(key)
        if (value !== null) settings[key] = value
    }
    return { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), settings }
}

/**
 * Replaces every settings key with the file's value; keys absent from the file
 * are removed (back to default). Unknown keys and non-string values are ignored.
 * Throws if the text is not a settings file; storage is untouched in that case.
 */
export function importSettings(text: string, storage: Storage = localStorage): number {
    const parsed: unknown = JSON.parse(text)
    const file = parsed as Partial<SettingsFile> | null
    if (
        typeof file !== 'object' || file === null
        || file.format !== FORMAT || file.version !== 1
        || typeof file.settings !== 'object' || file.settings === null || Array.isArray(file.settings)
    ) {
        throw new Error('Not a HAPI settings file')
    }
    const settings = file.settings
    let applied = 0
    for (const key of SETTINGS_STORAGE_KEYS) {
        const value = Object.hasOwn(settings, key) ? settings[key] : undefined
        if (typeof value === 'string') {
            storage.setItem(key, value)
            applied += 1
        } else {
            storage.removeItem(key)
        }
    }
    return applied
}
