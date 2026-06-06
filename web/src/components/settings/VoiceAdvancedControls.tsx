import { useState } from 'react'
import {
    DEFAULT_VOICE_CHARACTER,
    DEFAULT_VOICE_IDENTITY,
    ELEVENLABS_WEBRTC_MAX_MESSAGE_BYTES,
    ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES,
    VOICE_CHARACTER_MAX_LENGTH,
    VOICE_IDENTITY_MAX_LENGTH,
    VOICE_PERSONALITY_PRESETS,
    RESPONSE_LENGTH_OPTIONS,
    getPresetDeliverySnippet,
    getVoicePlatformFixturesPreview,
    getVoicePersonalityPreset,
    getVoiceWireBudgetHint,
    isDefaultVoicePersonality,
    resolveComposedVoiceSystemPrompt,
    type VoiceBackendKind,
    type VoicePersonalityPresetId,
    type ResponseLengthOption
} from '@hapi/protocol/voice-personality'
import { readVoiceContextNotice } from '@/lib/voiceContextStream'
import { useVoicePersonality } from '@/hooks/useVoicePersonality'
import { useMemo } from 'react'

type Translate = (key: string) => string

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}>
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function VoiceSlider(props: {
    label: string
    hint?: string
    value: number
    min: number
    max: number
    step: number
    onChange: (value: number) => void
    formatValue?: (value: number) => string
}) {
    const display = props.formatValue ? props.formatValue(props.value) : props.value.toFixed(2)
    return (
        <label className="block px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm text-[var(--app-fg)]">{props.label}</span>
                <span className="text-xs tabular-nums text-[var(--app-hint)]">{display}</span>
            </div>
            {props.hint && <p className="mb-2 text-xs text-[var(--app-hint)]">{props.hint}</p>}
            <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
                onChange={(e) => props.onChange(Number(e.target.value))}
                className="w-full accent-[var(--app-link)]" />
        </label>
    )
}

/** "How it behaves" — response length selector. */
export function VoiceRespondsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs, setResponseLength } = useVoicePersonality()
    const currentResponseLength: ResponseLengthOption = prefs.responseLength ?? 'balanced'

    return (
        <div className="border-t border-[var(--app-divider)] px-3 py-3">
            <p className="mb-2 text-[var(--app-fg)]">{props.t('settings.voice.responseLength.label')}</p>
            <div className="flex gap-2">
                {RESPONSE_LENGTH_OPTIONS.map((opt) => (
                    <button key={opt} type="button" onClick={() => setResponseLength(opt)}
                        className={`flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                            currentResponseLength === opt
                                ? 'border-[var(--app-link)] bg-[var(--app-link)]/10 text-[var(--app-link)]'
                                : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                        }`}>
                        {props.t(`settings.voice.responseLength.${opt}`)}
                    </button>
                ))}
            </div>
            <p className="mt-1.5 text-xs text-[var(--app-hint)]">
                {props.t(`settings.voice.responseLength.${currentResponseLength}.hint`)}
            </p>
        </div>
    )
}

/** "Persona & instructions" — identity, character, and speaking style preset. */
export function VoicePersonaControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const {
        prefs,
        setPreset,
        setIdentity,
        setCharacter,
        resetIdentity,
        resetCharacter,
        resetVoicePersonalityLayers,
        appendPresetDeliveryToCharacter,
    } = useVoicePersonality()
    const [identityOpen, setIdentityOpen] = useState(false)
    const [characterOpen, setCharacterOpen] = useState(false)
    const [deliveryOpen, setDeliveryOpen] = useState(false)

    const identityEditor = prefs.identity.trim() || DEFAULT_VOICE_IDENTITY
    const characterEditor = prefs.character.trim() || DEFAULT_VOICE_CHARACTER
    const usingDefaults = isDefaultVoicePersonality(prefs)
    const presetSnippet = getPresetDeliverySnippet(prefs.preset)

    return (
        <div>
            {/* Identity */}
            <button type="button" onClick={() => setIdentityOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-[var(--app-divider)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-expanded={identityOpen}>
                <span className="text-[var(--app-fg)]">{props.t('settings.voice.identity.title')}</span>
                <ChevronDownIcon className={`shrink-0 transition-transform ${identityOpen ? 'rotate-180' : ''}`} />
            </button>
            {identityOpen && (
                <div className="space-y-2 border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 px-3 py-2">
                    <p className="text-xs text-[var(--app-hint)]">{props.t('settings.voice.identity.hint')}</p>
                    <textarea value={identityEditor}
                        onChange={(e) => setIdentity(e.target.value === DEFAULT_VOICE_IDENTITY ? '' : e.target.value)}
                        rows={6} maxLength={VOICE_IDENTITY_MAX_LENGTH} spellCheck={false}
                        className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 font-mono text-xs leading-relaxed text-[var(--app-fg)]" />
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={resetIdentity}
                            className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">
                            {props.t('settings.voice.identity.reset')}
                        </button>
                        <span className="text-xs text-[var(--app-hint)]">
                            {prefs.identity.trim() ? props.t('settings.voice.identity.customized') : props.t('settings.voice.identity.default')}
                        </span>
                    </div>
                </div>
            )}

            {/* Character & speaking style */}
            <button type="button" onClick={() => setCharacterOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-[var(--app-divider)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-expanded={characterOpen}>
                <span className="text-[var(--app-fg)]">{props.t('settings.voice.character.promptTitle')}</span>
                <ChevronDownIcon className={`shrink-0 transition-transform ${characterOpen ? 'rotate-180' : ''}`} />
            </button>
            {characterOpen && (
                <div className="space-y-2 border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 px-3 py-2">
                    <p className="text-xs text-[var(--app-hint)]">{props.t('settings.voice.character.promptHint')}</p>
                    <textarea value={characterEditor}
                        onChange={(e) => setCharacter(e.target.value === DEFAULT_VOICE_CHARACTER ? '' : e.target.value)}
                        rows={8} maxLength={VOICE_CHARACTER_MAX_LENGTH} spellCheck={false}
                        className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 font-mono text-xs leading-relaxed text-[var(--app-fg)]" />
                    <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={resetCharacter}
                            className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">
                            {props.t('settings.voice.character.reset')}
                        </button>
                        {presetSnippet && (
                            <button type="button" onClick={appendPresetDeliveryToCharacter}
                                className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">
                                {props.t('settings.voice.character.appendPreset')}
                            </button>
                        )}
                        <button type="button" onClick={resetVoicePersonalityLayers}
                            className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">
                            {props.t('settings.voice.layers.resetAll')}
                        </button>
                    </div>
                </div>
            )}

            {/* Speaking style preset */}
            <button type="button" onClick={() => setDeliveryOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-[var(--app-divider)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-expanded={deliveryOpen}>
                <span className="flex items-center gap-2 text-[var(--app-fg)]">
                    {props.t('settings.voice.character.title')}
                    {!usingDefaults && (
                        <span className="rounded-full bg-[var(--app-link)]/15 px-2 py-0.5 text-[10px] text-[var(--app-link)]">
                            {props.t('settings.voice.advanced.customizedBadge')}
                        </span>
                    )}
                </span>
                <ChevronDownIcon className={`shrink-0 transition-transform ${deliveryOpen ? 'rotate-180' : ''}`} />
            </button>
            {deliveryOpen && (
                <div className="space-y-1 border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 pb-2">
                    <p className="px-3 pt-2 text-xs text-[var(--app-hint)]">
                        {props.t('settings.voice.character.presetSlidersHint')}
                    </p>
                    <label className="block px-3 pt-1">
                        <span className="mb-1 block text-sm text-[var(--app-fg)]">
                            {props.t('settings.voice.character.preset.label')}
                        </span>
                        <select value={prefs.preset}
                            onChange={(e) => setPreset(e.target.value as VoicePersonalityPresetId)}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-2 text-sm text-[var(--app-fg)]">
                            {VOICE_PERSONALITY_PRESETS.map((preset) => (
                                <option key={preset.id} value={preset.id}>{props.t(preset.labelKey)}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-[var(--app-hint)]">
                            {props.t(getVoicePersonalityPreset(prefs.preset).descriptionKey)}
                        </p>
                        {!usingDefaults && (
                            <p className="mt-2 text-xs text-[var(--app-hint)]">
                                {props.t('settings.voice.layers.composedNote')}
                            </p>
                        )}
                    </label>
                </div>
            )}
        </div>
    )
}

/** "How it sounds" — per-backend acoustic tuning. Shows a capability note for backends with no sliders. */
export function VoiceSoundsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs, setElevenLabs, setGeminiAffectiveDialog } = useVoicePersonality()
    const [tuningOpen, setTuningOpen] = useState(false)

    const backend = props.voiceBackend ?? 'elevenlabs'
    const showElevenLabsSliders = backend === 'elevenlabs'
    const showGeminiOptions = backend === 'gemini-live'
    const showQwenNote = backend === 'qwen-realtime'
    const showBackendHint = props.voiceBackend == null

    return (
        <div>
            {/* Tone & pace */}
            <button type="button" onClick={() => setTuningOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-[var(--app-divider)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-expanded={tuningOpen}>
                <span className="text-[var(--app-fg)]">{props.t('settings.voice.tuning.title')}</span>
                <ChevronDownIcon className={`shrink-0 transition-transform ${tuningOpen ? 'rotate-180' : ''}`} />
            </button>
            {tuningOpen && (
                <div className="border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 pb-2">
                    {showBackendHint && (
                        <p className="px-3 py-3 text-xs text-[var(--app-hint)]">{props.t('settings.voice.tuning.selectBackend')}</p>
                    )}
                    {showQwenNote && (
                        <p className="px-3 py-3 text-xs text-[var(--app-hint)]">{props.t('settings.voice.tuning.qwenHint')}</p>
                    )}
                    {showElevenLabsSliders && (
                        <div>
                            <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                {props.t('settings.voice.tuning.elevenlabs')}
                            </p>
                            <VoiceSlider label={props.t('settings.voice.tuning.stability')} hint={props.t('settings.voice.tuning.stabilityHint')}
                                value={prefs.elevenLabs.stability} min={0} max={1} step={0.05}
                                onChange={(stability) => setElevenLabs({ stability })} />
                            <VoiceSlider label={props.t('settings.voice.tuning.expressiveness')} hint={props.t('settings.voice.tuning.expressivenessHint')}
                                value={prefs.elevenLabs.style} min={0} max={1} step={0.05}
                                onChange={(style) => setElevenLabs({ style })} />
                            <VoiceSlider label={props.t('settings.voice.tuning.speakingRate')} hint={props.t('settings.voice.tuning.speakingRateHint')}
                                value={prefs.elevenLabs.speed} min={0.7} max={1.2} step={0.01}
                                onChange={(speed) => setElevenLabs({ speed })}
                                formatValue={(v) => `${v.toFixed(2)}×`} />
                            <VoiceSlider label={props.t('settings.voice.tuning.similarity')} hint={props.t('settings.voice.tuning.similarityHint')}
                                value={prefs.elevenLabs.similarity_boost} min={0} max={1} step={0.05}
                                onChange={(similarity_boost) => setElevenLabs({ similarity_boost })} />
                            <label className="flex items-center justify-between px-3 py-2">
                                <span className="text-sm text-[var(--app-fg)]">{props.t('settings.voice.tuning.speakerBoost')}</span>
                                <input type="checkbox" checked={prefs.elevenLabs.use_speaker_boost}
                                    onChange={(e) => setElevenLabs({ use_speaker_boost: e.target.checked })}
                                    className="h-4 w-4 accent-[var(--app-link)]" />
                            </label>
                        </div>
                    )}
                    {showGeminiOptions && (
                        <div>
                            <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                {props.t('settings.voice.tuning.gemini')}
                            </p>
                            <label className="flex items-center justify-between px-3 py-2">
                                <span className="text-sm text-[var(--app-fg)]">{props.t('settings.voice.tuning.affectiveDialog')}</span>
                                <input type="checkbox" checked={prefs.gemini.affective_dialog}
                                    onChange={(e) => setGeminiAffectiveDialog(e.target.checked)}
                                    className="h-4 w-4 accent-[var(--app-link)]" />
                            </label>
                            <p className="px-3 pb-2 text-xs text-[var(--app-hint)]">{props.t('settings.voice.tuning.affectiveDialogHint')}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

/** Debug/diagnostics panel for the Advanced section. */
export function VoiceDiagnosticsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs } = useVoicePersonality()
    const [fixturesOpen, setFixturesOpen] = useState(false)

    const backend = props.voiceBackend ?? 'elevenlabs'
    const wireHint = getVoiceWireBudgetHint(backend)
    const fixturesPreview = useMemo(() => getVoicePlatformFixturesPreview(800), [])
    const composed = useMemo(
        () => resolveComposedVoiceSystemPrompt(prefs, { backend }),
        [prefs, backend]
    )
    const contextNotice = readVoiceContextNotice()

    return (
        <div>
            <p className="px-3 pt-2 pb-1 text-xs text-[var(--app-hint)]">
                {props.t(wireHint.wireNoteKey)}
                {' '}{props.t('settings.voice.wireBudget.storage')}{wireHint.storageMaxChars.toLocaleString()}.
                {backend === 'elevenlabs' && (
                    <> {props.t('settings.voice.wireBudget.elevenlabsLimits')
                        .replace('{msg}', String(ELEVENLABS_WEBRTC_MAX_MESSAGE_BYTES))
                        .replace('{prompt}', String(ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES))}</>
                )}
            </p>
            {composed.truncated && (
                <p className="px-3 pb-2 text-xs text-amber-600 dark:text-amber-400">
                    {props.t('settings.voice.wireBudget.promptTruncated')}
                </p>
            )}
            {contextNotice && (
                <p className="px-3 pb-1 text-xs text-[var(--app-link)]">
                    {props.t('settings.voice.contextNotice')}: {contextNotice}
                </p>
            )}
            <p className="px-3 pb-2 text-xs tabular-nums text-[var(--app-hint)]">
                {props.t('settings.voice.wireBudget.composedSize')}: {composed.wireBytes.toLocaleString()} B
            </p>

            <button type="button" onClick={() => setFixturesOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-[var(--app-divider)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-expanded={fixturesOpen}>
                <span className="text-[var(--app-fg)]">{props.t('settings.voice.fixtures.title')}</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 transition-transform ${fixturesOpen ? 'rotate-180' : ''}`}>
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>
            {fixturesOpen && (
                <div className="space-y-2 border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 px-3 py-2">
                    <p className="text-xs text-[var(--app-hint)]">{props.t('settings.voice.fixtures.hint')}</p>
                    <pre className="max-h-48 overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-[10px] leading-relaxed text-[var(--app-hint)] whitespace-pre-wrap">
                        {fixturesPreview}
                    </pre>
                </div>
            )}
        </div>
    )
}

/** @deprecated Use VoiceRespondsControls + VoicePersonaControls + VoiceSoundsControls instead. */
export function VoiceAdvancedControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    return (
        <>
            <VoicePersonaControls {...props} />
            <VoiceSoundsControls {...props} />
        </>
    )
}
