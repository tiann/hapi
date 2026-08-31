import { useEffect, useState } from 'react'
import { SettingsRow } from '@/components/settings/SettingsPrimitives'
import {
    MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    MAX_TEXT_CONTEXT_LINE_THRESHOLD,
    MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    MIN_TEXT_CONTEXT_LINE_THRESHOLD,
    normalizeTextContextCharacterThreshold,
    normalizeTextContextLineThreshold,
    useTextContextPreferences,
} from '@/hooks/useTextContextPreferences'
import { useTranslation } from '@/lib/use-translation'

function MinusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M5 12h14" /></svg>
}

function PlusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function ThresholdInput(props: {
    label: string
    description: string
    value: number
    min: number
    max: number
    step: number
    unit: string
    normalize: (value: number) => number
    onChange: (value: number) => void
}) {
    const [draft, setDraft] = useState(String(props.value))

    useEffect(() => {
        setDraft(String(props.value))
    }, [props.value])

    const commit = () => {
        const parsed = draft.trim() === '' ? props.value : Number(draft)
        const next = props.normalize(parsed)
        props.onChange(next)
        setDraft(String(next))
    }
    const step = (delta: number) => {
        props.onChange(props.normalize(props.value + delta))
    }

    return (
        <SettingsRow
            label={props.label}
            description={props.description}
            trailing={
                <div className="flex h-9 items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                    <button
                        type="button"
                        onClick={() => step(-props.step)}
                        disabled={props.value <= props.min}
                        aria-label={`${props.label} -`}
                        className="flex h-8 w-8 items-center justify-center disabled:opacity-40"
                    >
                        <MinusIcon />
                    </button>
                    <input
                        aria-label={props.label}
                        type="number"
                        inputMode="numeric"
                        min={props.min}
                        max={props.max}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                commit()
                                event.currentTarget.blur()
                            }
                            if (event.key === 'Escape') {
                                setDraft(String(props.value))
                                event.currentTarget.blur()
                            }
                        }}
                        className="h-8 w-20 border-x border-[var(--app-border)] bg-transparent text-center text-sm text-[var(--app-fg)] outline-none"
                    />
                    <span className="min-w-12 px-2 text-center text-xs text-[var(--app-hint)]">
                        {props.unit}
                    </span>
                    <button
                        type="button"
                        onClick={() => step(props.step)}
                        disabled={props.value >= props.max}
                        aria-label={`${props.label} +`}
                        className="flex h-8 w-8 items-center justify-center disabled:opacity-40"
                    >
                        <PlusIcon />
                    </button>
                </div>
            }
        />
    )
}

export function TextContextThresholdSettings() {
    const { t } = useTranslation()
    const {
        characterThreshold,
        lineThreshold,
        setCharacterThreshold,
        setLineThreshold,
    } = useTextContextPreferences()

    return (
        <>
            <ThresholdInput
                label={t('settings.chat.textContext.characterThreshold')}
                description={t('settings.chat.textContext.characterThreshold.desc')}
                value={characterThreshold}
                min={MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD}
                max={MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD}
                step={500}
                unit={t('settings.chat.textContext.characters')}
                normalize={normalizeTextContextCharacterThreshold}
                onChange={setCharacterThreshold}
            />
            <ThresholdInput
                label={t('settings.chat.textContext.lineThreshold')}
                description={t('settings.chat.textContext.lineThreshold.desc')}
                value={lineThreshold}
                min={MIN_TEXT_CONTEXT_LINE_THRESHOLD}
                max={MAX_TEXT_CONTEXT_LINE_THRESHOLD}
                step={10}
                unit={t('settings.chat.textContext.lines')}
                normalize={normalizeTextContextLineThreshold}
                onChange={setLineThreshold}
            />
        </>
    )
}
