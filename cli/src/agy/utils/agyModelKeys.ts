export type AgyModelPickerTarget = {
    row: number
    effort: 0 | 1 | 2 | null
    label: string
}

const TARGETS: Record<string, AgyModelPickerTarget> = {
    'gemini-3.6-flash-low': { row: 0, effort: 0, label: 'Gemini 3.6 Flash (Low)' },
    'gemini-3.6-flash-medium': { row: 0, effort: 1, label: 'Gemini 3.6 Flash (Medium)' },
    'gemini-3.6-flash-high': { row: 0, effort: 2, label: 'Gemini 3.6 Flash (High)' },
    'gemini-3.5-flash-low': { row: 1, effort: 0, label: 'Gemini 3.5 Flash (Low)' },
    'gemini-3.5-flash-medium': { row: 1, effort: 1, label: 'Gemini 3.5 Flash (Medium)' },
    'gemini-3.5-flash-high': { row: 1, effort: 2, label: 'Gemini 3.5 Flash (High)' },
    'gemini-3.1-pro-low': { row: 2, effort: 0, label: 'Gemini 3.1 Pro (Low)' },
    'gemini-3.1-pro-high': { row: 2, effort: 2, label: 'Gemini 3.1 Pro (High)' },
    'claude-sonnet-4-6': { row: 3, effort: null, label: 'Claude Sonnet 4.6 (Thinking)' },
    'claude-opus-4-6-thinking': { row: 4, effort: null, label: 'Claude Opus 4.6 (Thinking)' },
    'gpt-oss-120b-medium': { row: 5, effort: null, label: 'GPT-OSS 120B (Medium)' },
}

const MODEL_ROWS = [
    'Gemini 3.6 Flash',
    'Gemini 3.5 Flash',
    'Gemini 3.1 Pro',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
] as const

export function buildAgyModelPickerTarget(modelId: string | null): AgyModelPickerTarget {
    if (modelId === null) throw new Error('Live AGY model reset is not supported')
    const target = TARGETS[modelId]
    if (!target) throw new Error(`Unsupported live AGY model: ${modelId}`)
    return target
}

export function findAgyCurrentModelRow(pickerOutput: string): number | null {
    const marker = pickerOutput.lastIndexOf('(current)')
    if (marker === -1) return null
    let bestRow: number | null = null
    let bestIndex = -1
    MODEL_ROWS.forEach((label, row) => {
        const index = pickerOutput.lastIndexOf(label, marker)
        if (index > bestIndex) {
            bestIndex = index
            bestRow = row
        }
    })
    return bestIndex === -1 ? null : bestRow
}

export function buildAgyModelNavigationKeys(target: AgyModelPickerTarget, currentRow: number): string {
    if (!Number.isInteger(currentRow) || currentRow < 0 || currentRow >= MODEL_ROWS.length) {
        throw new Error(`Invalid current AGY model row: ${currentRow}`)
    }
    const delta = target.row - currentRow
    const vertical = delta < 0 ? '\x1b[A'.repeat(-delta) : '\x1b[B'.repeat(delta)
    if (target.effort === null) return vertical
    const resetEffort = '\x1b[D'.repeat(3)
    const setEffort = '\x1b[C'.repeat(target.effort)
    return `${vertical}${resetEffort}${setEffort}`
}
