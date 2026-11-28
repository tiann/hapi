import { cursorCliSkuBaseId, isCursorAcpWireModelId, parseCursorSkuParamHints, parseCursorWireParams } from '@hapi/protocol'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

type Option = { value: string; label: string }

const axisLabels = {
    effort: 'misc.effort',
    reasoning: 'misc.reasoning',
    reasoning_effort: 'misc.reasoning',
    thinking: 'misc.thinking',
    context: 'misc.contextWindow',
    fast: 'misc.fastMode'
} as const
type Axis = keyof typeof axisLabels

function modelParameters(id: string): Record<string, string> {
    if (isCursorAcpWireModelId(id)) return parseCursorWireParams(id)
    // Cursor can also publish named CLI SKUs instead of bracketed ACP IDs.
    // Parse only recognized suffixes so words in the model name never become settings.
    const suffix = id.slice(cursorCliSkuBaseId(id).length)
    const { reasoning, thinking, fast } = parseCursorSkuParamHints(suffix)
    return { fast, ...(reasoning && { reasoning }), ...(thinking && { thinking }) }
}

export function CursorModelParameters(props: {
    options: ReadonlyArray<Option>
    selectedValue: string | null | undefined
    disabled: boolean
    onChange: (wireId: string) => void
}) {
    const { t } = useTranslation()
    const { options, selectedValue, disabled, onChange } = props
    if (options.length < 2) return null

    const field = (label: string, value: string, choices: ReadonlyArray<Option & { disabled?: boolean }>) => (
        <label key={label} className="flex flex-col gap-1.5 px-3 py-2 text-xs font-medium text-[var(--app-hint)]">
            {label}
            <SelectControl value={value} disabled={disabled} onChange={event => onChange(event.target.value)}
                className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] py-2 pl-3 text-sm text-[var(--app-text)] disabled:opacity-50">
                {choices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}
            </SelectControl>
        </label>
    )

    const rows = options.map(option => modelParameters(option.value))
    const current = options.findIndex(option => option.value === selectedValue)
    const keys = [...new Set(rows.flatMap(Object.keys))]
    const varying = keys.filter(key => rows.some(row => row[key] !== rows[0][key]))
    const wholeVariant = () => field(t('misc.variant'), current < 0 ? '' : options[current].value, current < 0
        ? [{ value: '', label: t('newSession.model.selectVariant'), disabled: true }, ...options]
        : options)

    if (current < 0 || !varying.length || varying.some(key => !Object.hasOwn(axisLabels, key))) return wholeVariant()
    if (options.some(option => cursorCliSkuBaseId(option.value) !== cursorCliSkuBaseId(options[0].value))) return wholeVariant()

    // An edge changes exactly one setting. Coupled or ambiguous variants need
    // the whole-variant list so that every advertised ID remains selectable.
    const reachable = new Set([current])
    for (const index of reachable) {
        for (const [other, row] of rows.entries()) {
            if (other === index) continue
            const differences = varying.filter(key => row[key] !== rows[index][key]).length
            if (differences === 0) return wholeVariant()
            if (differences === 1) reachable.add(other)
        }
    }
    if (reachable.size !== rows.length) return wholeVariant()

    return <>{(varying as Axis[]).map(axis => {
        const values = [...new Set(rows.map(row => row[axis]))]
        const choices = values.map((value, index) => {
            const target = rows.findIndex(row => row[axis] === value &&
                varying.every(key => key === axis || row[key] === rows[current][key]))
            let label = value ?? t('newSession.model.default')
            if (axis === 'fast' && value === 'true') label = t('misc.fastModeFast')
            if (axis === 'fast' && value === 'false') label = t('misc.fastModeStandard')
            if (axis === 'thinking' && value === 'true') label = t('misc.enabled')
            if (axis === 'thinking' && value === 'false') label = t('misc.disabled')
            return { value: target >= 0 ? options[target].value : `unavailable-${index}`, label, disabled: target < 0 }
        })
        return field(t(axisLabels[axis]), options[current].value, choices)
    })}</>
}
