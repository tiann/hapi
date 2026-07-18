export type TextSelectionRange = {
    start: number
    end: number
}

export type ComposerInsertionResult = {
    text: string
    cursorPosition: number
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.max(min, Math.min(max, Math.trunc(value)))
}

export function insertComposerSnippet(
    currentText: string,
    selection: TextSelectionRange,
    snippet: string
): ComposerInsertionResult {
    const start = clamp(selection.start, 0, currentText.length)
    const end = clamp(selection.end, start, currentText.length)
    const before = currentText.slice(0, start)
    const after = currentText.slice(end)

    if (start !== end) {
        const text = `${before}${snippet}${after}`
        return {
            text,
            cursorPosition: before.length + snippet.length
        }
    }

    const leadingSeparator = before.length > 0 && !/\s$/.test(before) ? '\n\n' : ''
    const trailingSeparator = after.length > 0 && !/^\s/.test(after) ? '\n\n' : ''
    const text = `${before}${leadingSeparator}${snippet}${trailingSeparator}${after}`

    return {
        text,
        cursorPosition: before.length + leadingSeparator.length + snippet.length
    }
}
