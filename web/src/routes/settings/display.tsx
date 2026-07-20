import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { getAppearanceOptions, useAppearance } from '@/hooks/useTheme'
import { getColorThemeOptions, getColorThemePreview, useColorTheme, type ColorThemePreset } from '@/hooks/useColorTheme'
import { getFontScaleOptions, useFontScale } from '@/hooks/useFontScale'
import { getTerminalFontSizeOptions, useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { getSessionListStatusModeOptions, useSessionListStatusMode } from '@/hooks/useSessionListStatusMode'
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import { MAX_SESSION_PREVIEW_LIMIT, MIN_SESSION_PREVIEW_LIMIT, normalizeSessionPreviewLimit, useSessionPreviewLimit } from '@/hooks/useSessionPreviewLimit'
import { useThemeColors, type ThemeColorKeyId } from '@/hooks/useThemeColors'
import { SettingsChoiceGroup, SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'

function MinusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M5 12h14" /></svg>
}

function PlusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function ColorThemePicker() {
    const { t } = useTranslation()
    const { colorTheme, setColorTheme } = useColorTheme()

    return (
        <fieldset className="px-3 py-3">
            <legend className="mb-2 text-[var(--app-fg)]">{t('settings.display.colorTheme')}</legend>
            <div role="radiogroup" aria-label={t('settings.display.colorTheme')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {getColorThemeOptions().map((option) => (
                    <ColorThemeOption
                        key={option.value}
                        theme={option.value}
                        label={t(option.labelKey)}
                        selected={colorTheme === option.value}
                        onSelect={setColorTheme}
                    />
                ))}
            </div>
        </fieldset>
    )
}

function ColorThemeOption(props: { theme: ColorThemePreset; label: string; selected: boolean; onSelect: (theme: ColorThemePreset) => void }) {
    const preview = getColorThemePreview(props.theme)
    return (
        <label
            className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-2 text-left text-sm transition-colors ${props.selected
                ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
        >
            <input type="radio" name="color-theme" value={props.theme} checked={props.selected} onChange={() => props.onSelect(props.theme)} className="sr-only" />
            <span className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md border border-[var(--app-border)]" style={{ backgroundColor: preview.light }} aria-hidden="true">
                <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundColor: preview.dark }} />
                <span className="absolute inset-x-1 bottom-1 h-1 rounded-full" style={{ backgroundColor: preview.accent }} />
            </span>
            <span className="min-w-0 truncate font-medium">{props.label}</span>
        </label>
    )
}

function SessionPreviewLimitControl() {
    const { t } = useTranslation()
    const { sessionPreviewLimit, setSessionPreviewLimit } = useSessionPreviewLimit()
    const [draft, setDraft] = useState(String(sessionPreviewLimit))

    useEffect(() => setDraft(String(sessionPreviewLimit)), [sessionPreviewLimit])

    const commit = () => {
        const parsed = draft.trim() === '' ? sessionPreviewLimit : Number(draft)
        const next = normalizeSessionPreviewLimit(parsed)
        setSessionPreviewLimit(next)
        setDraft(String(next))
    }
    const step = (delta: number) => setSessionPreviewLimit(normalizeSessionPreviewLimit(sessionPreviewLimit + delta))

    return (
        <SettingsRow label={t('settings.display.sessionPreviewLimit')} trailing={
            <div className="flex h-9 items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                <button type="button" onClick={() => step(-1)} disabled={sessionPreviewLimit <= MIN_SESSION_PREVIEW_LIMIT} aria-label={t('settings.display.sessionPreviewLimit.decrease')} className="flex h-8 w-8 items-center justify-center disabled:opacity-40"><MinusIcon /></button>
                <input
                    aria-label={t('settings.display.sessionPreviewLimit')}
                    type="number"
                    inputMode="numeric"
                    min={MIN_SESSION_PREVIEW_LIMIT}
                    max={MAX_SESSION_PREVIEW_LIMIT}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { commit(); event.currentTarget.blur() }
                        if (event.key === 'Escape') { setDraft(String(sessionPreviewLimit)); event.currentTarget.blur() }
                    }}
                    className="h-8 w-14 border-x border-[var(--app-border)] bg-transparent text-center text-sm text-[var(--app-fg)] outline-none"
                />
                <button type="button" onClick={() => step(1)} disabled={sessionPreviewLimit >= MAX_SESSION_PREVIEW_LIMIT} aria-label={t('settings.display.sessionPreviewLimit.increase')} className="flex h-8 w-8 items-center justify-center disabled:opacity-40"><PlusIcon /></button>
            </div>
        } />
    )
}

function ThemeColorControls() {
    const { t } = useTranslation()
    const { keys, getPickerValue, isCustomized, hasAnyCustom, setColor, resetColor, resetAll } = useThemeColors()
    return (
        <details open={hasAnyCustom} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">
                <span>
                    <span className="block">{t('settings.display.themeColors.title')}</span>
                    <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{t('settings.display.themeColors.description')}</span>
                </span>
                <span className="ml-3 text-sm text-[var(--app-hint)]">{hasAnyCustom ? t('settings.voice.advanced.customizedBadge') : t('settings.display.themeColors.expand')}</span>
            </summary>
            <div className="border-t border-[var(--app-divider)] px-3 py-3">
                {hasAnyCustom ? <div className="mb-3 text-right"><button type="button" onClick={resetAll} className="text-sm text-[var(--app-link)] hover:underline">{t('settings.display.themeColors.resetAll')}</button></div> : null}
                <div className="grid gap-3 sm:grid-cols-2">
                    {keys.map((key) => (
                        <div key={key.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] px-2.5 py-2">
                            <span className="min-w-0 truncate text-sm text-[var(--app-fg)]">{t(key.labelKey)}</span>
                            <span className="flex shrink-0 items-center gap-2">
                                {isCustomized(key.id) ? <button type="button" onClick={(event) => { event.preventDefault(); resetColor(key.id as ThemeColorKeyId) }} className="text-xs text-[var(--app-hint)] hover:text-[var(--app-link)]">{t('settings.display.themeColors.reset')}</button> : null}
                                <input type="color" aria-label={t(key.labelKey)} value={getPickerValue(key.id)} onChange={(event) => setColor(key.id as ThemeColorKeyId, event.target.value)} className="h-8 w-10 cursor-pointer border-0 bg-transparent p-0" />
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </details>
    )
}

export default function SettingsDisplayPage() {
    const { t } = useTranslation()
    const { appearance, setAppearance } = useAppearance()
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { sessionListStatusMode, setSessionListStatusMode } = useSessionListStatusMode()
    const { showActiveSessionsOnly, setShowActiveSessionsOnly } = useShowActiveSessionsOnly()

    return (
        <SettingsPageContent title={t('settings.display.title')} description={t('settings.display.description')}>
            <SettingsSection title={t('settings.display.appearance')}>
                <SettingsChoiceGroup
                    label={t('settings.display.appearance')}
                    value={appearance}
                    columns={4}
                    options={getAppearanceOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setAppearance}
                />
                <ColorThemePicker />
                <ThemeColorControls />
            </SettingsSection>

            <SettingsSection title={t('settings.display.typography')}>
                <SettingsChoiceGroup label={t('settings.display.fontSize')} value={fontScale} columns={5} options={getFontScaleOptions()} onChange={setFontScale} />
                <SettingsChoiceGroup label={t('settings.display.terminalFontSize')} value={terminalFontSize} columns={5} options={getTerminalFontSizeOptions()} onChange={setTerminalFontSize} />
            </SettingsSection>

            <SettingsSection title={t('settings.display.sessions')}>
                <SessionPreviewLimitControl />
                <SettingsSwitch label={t('settings.display.activeSessionsOnly')} description={t('settings.display.activeSessionsOnly.desc')} checked={showActiveSessionsOnly} onChange={setShowActiveSessionsOnly} />
                <SettingsChoiceGroup
                    label={t('settings.display.sessionListStatus')}
                    value={sessionListStatusMode}
                    options={getSessionListStatusModeOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setSessionListStatusMode}
                />
                {sessionListStatusMode === 'detailed' ? <div className="px-3 pb-3 text-xs text-[var(--app-hint)]">{t('settings.display.sessionListStatus.detailedDescription')}</div> : null}
            </SettingsSection>
        </SettingsPageContent>
    )
}
