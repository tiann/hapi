import { isObject } from '@hapi/protocol'

/**
 * One settled question in the model-facing answer batch — the exact shape
 * DSH's native `ask_user_question` tool returns (`answerResult`), kept stable
 * so models trained on DSH's contract read MCP-bridged answers identically.
 */
export type AskUserAnswer = {
    id: string
    selected: string[]
    custom?: string
}

type WebAnswers = Record<string, string[] | { answers: string[] }>

function normalizeWebAnswers(answers: WebAnswers | undefined): Record<string, string[]> {
    const flat: Record<string, string[]> = {}
    if (!answers) return flat
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            flat[key] = value
        } else if (isObject(value) && Array.isArray(value.answers)) {
            flat[key] = value.answers
        }
    }
    return flat
}

/**
 * Flatten the web/mobile answer payload into the model-facing answer batch.
 *
 * The web `AskUserQuestionFooter` (and the mobile ports) submit
 * `Record<questionIndex, string[]>`: values are selected option LABELS, with
 * any free-text "Other" answer appended as an extra string in the same array.
 * Map that onto one `AskUserAnswer` per question:
 * - values matching an option label → `selected`
 * - remaining non-empty values → `custom` (joined; the UI offers one Other box)
 * - nothing selected and no custom → an empty `selected` with no `custom`,
 *   which is DSH's explicit "user skipped this question" spelling — the model
 *   is instructed to continue without re-asking.
 *
 * Keys are indices for the AskUserQuestion dialect (Cursor's dialect keys by
 * stable question id — `Record<id, string[]>` — and falls through the same
 * path because the lookup is by whatever key the questions carry).
 */
export function mapAskUserAnswers(input: unknown, answers: WebAnswers | undefined): AskUserAnswer[] {
    const flat = normalizeWebAnswers(answers)
    const questions = isObject(input) && Array.isArray(input.questions) ? input.questions : []

    const mapped: AskUserAnswer[] = []
    for (let i = 0; i < questions.length; i += 1) {
        const question = questions[i]
        if (!isObject(question)) continue
        const id = typeof question.id === 'string' && question.id.length > 0
            ? question.id
            : String(i)
        const labels = new Set<string>()
        if (Array.isArray(question.options)) {
            for (const option of question.options) {
                if (isObject(option) && typeof option.label === 'string' && option.label.length > 0) {
                    labels.add(option.label)
                }
            }
        }
        const values = flat[String(i)] ?? flat[id] ?? []
        const selected: string[] = []
        const custom: string[] = []
        for (const value of values) {
            if (typeof value !== 'string') continue
            const trimmed = value.trim()
            if (trimmed.length === 0) continue
            if (labels.has(trimmed)) {
                selected.push(trimmed)
            } else {
                custom.push(trimmed)
            }
        }
        mapped.push({
            id,
            selected,
            ...(custom.length > 0 ? { custom: custom.join(' ') } : {})
        })
    }
    return mapped
}

/**
 * Render the answer batch the way the model-facing tool result spells it —
 * a single JSON text block, identical to DSH's native tool result contract.
 */
export function formatAskUserAnswersJson(answers: AskUserAnswer[]): string {
    return JSON.stringify({ answers })
}
