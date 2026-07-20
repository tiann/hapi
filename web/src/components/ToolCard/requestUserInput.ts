import { isObject } from '@hapi/protocol'

export type RequestUserInputOption = {
    label: string
    description: string | null
}

export type RequestUserInputQuestion = {
    id: string
    question: string
    required: boolean
    multiple: boolean
    options: RequestUserInputOption[]
}

export type RequestUserInputQuestionAnswer = {
    selected: string[]
    userNote: string
}

export type ParsedRequestUserInput = {
    questions: RequestUserInputQuestion[]
    url: string | null
}

export type RequestUserInputQuestionInfo = {
    id: string
    question: string | null
}

// Nested answer format: { answers: { [id]: { answers: string[] } } }
export type RequestUserInputAnswers = Record<string, { answers: string[] }>

export function isRequestUserInputToolName(toolName: string): boolean {
    return toolName === 'request_user_input'
}

export function openRequestUserInputUrl(url: string): boolean {
    const opened = window.open('about:blank', '_blank')
    if (!opened) return false
    try {
        opened.opener = null
        opened.location.replace(url)
        return true
    } catch {
        opened.close()
        return false
    }
}

export function parseRequestUserInputInput(input: unknown): ParsedRequestUserInput {
    if (!isObject(input)) return { questions: [], url: null }

    let url: string | null = null
    if (typeof input.url === 'string') {
        try {
            const parsed = new URL(input.url)
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.toString()
        } catch {
            // Invalid and non-web URLs must never be opened by the approval UI.
        }
    }

    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return { questions: [], url }

    const questions: RequestUserInputQuestion[] = []
    for (const raw of rawQuestions) {
        if (!isObject(raw)) continue

        const id = typeof raw.id === 'string' ? raw.id.trim() : ''
        const question = typeof raw.question === 'string' ? raw.question.trim() : ''

        // Skip questions without id
        if (!id) continue

        const rawOptions = Array.isArray(raw.options) ? raw.options : []
        const options: RequestUserInputOption[] = []
        for (const opt of rawOptions) {
            if (!isObject(opt)) continue
            const label = typeof opt.label === 'string' ? opt.label.trim() : ''
            if (!label) continue
            const description = typeof opt.description === 'string' ? opt.description.trim() : null
            options.push({ label, description })
        }

        questions.push({
            id,
            question,
            required: raw.required !== false,
            multiple: raw.multiple === true,
            options
        })
    }

    return { questions, url }
}

export function isRequestUserInputUrlConfirmed(
    parsed: ParsedRequestUserInput,
    answersByQuestion: Record<string, RequestUserInputQuestionAnswer>
): boolean {
    if (!parsed.url) return false
    return parsed.questions.some((question) => {
        if (question.id !== '__mcp_url_confirmation') return false
        const selected = answersByQuestion[question.id]?.selected ?? []
        return question.options.some((option) => (
            selected.includes(option.label) && option.description === parsed.url
        ))
    })
}

export function isRequestUserInputQuestionAnswered(
    question: RequestUserInputQuestion,
    answer: RequestUserInputQuestionAnswer | undefined
): boolean {
    if (!question.required) return true
    if (!answer) return false
    if (question.options.length > 0) {
        return answer.selected.length > 0
    }
    return answer.userNote.trim().length > 0
}

export function extractRequestUserInputQuestionsInfo(input: unknown): RequestUserInputQuestionInfo[] | null {
    if (!isObject(input)) return null
    const raw = input.questions
    if (!Array.isArray(raw)) return null

    const questions: RequestUserInputQuestionInfo[] = []
    for (const q of raw) {
        if (!isObject(q)) continue
        const id = typeof q.id === 'string' ? q.id.trim() : ''
        const question = typeof q.question === 'string' ? q.question.trim() : null
        if (!id) continue
        questions.push({
            id,
            question: question && question.length > 0 ? question : null
        })
    }
    return questions
}

/**
 * Format answers for submission in the nested format expected by request_user_input
 * Format: { answers: { [id]: { answers: ["option", "user_note: note text"] } } }
 */
export function formatRequestUserInputAnswers(
    answersByQuestion: Record<string, RequestUserInputQuestionAnswer>
): { answers: RequestUserInputAnswers } {
    const answers: RequestUserInputAnswers = {}

    for (const [id, answer] of Object.entries(answersByQuestion)) {
        const answerArray: string[] = []

        answerArray.push(...answer.selected)

        const note = answer.userNote.trim()
        if (note.length > 0) {
            answerArray.push(`user_note: ${note}`)
        }

        answers[id] = { answers: answerArray }
    }

    return { answers }
}

/**
 * Parse answers from the nested format for display
 */
export function parseRequestUserInputAnswers(
    answers: unknown
): Record<string, { selected: string[]; userNote: string | null }> | null {
    if (!isObject(answers)) return null

    // Handle nested format: { answers: { [id]: { answers: string[] } } }
    const answersObj = isObject(answers.answers) ? answers.answers : answers

    const parsed: Record<string, { selected: string[]; userNote: string | null }> = {}

    for (const [id, value] of Object.entries(answersObj)) {
        let answerArray: string[] = []

        if (isObject(value) && Array.isArray(value.answers)) {
            answerArray = value.answers.filter((a): a is string => typeof a === 'string')
        } else if (Array.isArray(value)) {
            answerArray = value.filter((a): a is string => typeof a === 'string')
        }

        const selected: string[] = []
        let userNote: string | null = null

        for (const item of answerArray) {
            if (item.startsWith('user_note: ')) {
                userNote = item.slice('user_note: '.length).trim()
            } else {
                // Trim to match option labels which are also trimmed
                selected.push(item.trim())
            }
        }

        parsed[id] = { selected, userNote }
    }

    return parsed
}
