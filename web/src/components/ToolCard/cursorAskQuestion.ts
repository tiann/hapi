import { isObject } from '@hapi/protocol'
import type { AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'

export function isCursorAskQuestionToolName(toolName: string): boolean {
    return toolName === 'CursorAskQuestion'
}

export function parseCursorAskQuestionInput(input: unknown): { questions: AskUserQuestionQuestion[] } {
    if (!isObject(input)) return { questions: [] }

    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return { questions: [] }

    const requestTitle = typeof input.title === 'string' ? input.title.trim() : ''

    const questions: AskUserQuestionQuestion[] = []
    for (const raw of rawQuestions) {
        if (!isObject(raw)) continue

        const question = typeof raw.prompt === 'string'
            ? raw.prompt.trim()
            : typeof raw.question === 'string'
                ? raw.question.trim()
                : ''
        const header = typeof raw.title === 'string'
            ? raw.title.trim()
            : typeof raw.header === 'string'
                ? raw.header.trim()
                : ''
        const multiSelect = raw.allowMultiple === true || raw.multiSelect === true
        const questionId = typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim()
            : String(questions.length)

        const rawOptions = Array.isArray(raw.options) ? raw.options : []
        const options: AskUserQuestionQuestion['options'] = []
        for (const opt of rawOptions) {
            if (!isObject(opt)) continue
            const label = typeof opt.label === 'string'
                ? opt.label.trim()
                : typeof opt.id === 'string'
                    ? opt.id.trim()
                    : ''
            if (!label) continue
            const optionId = typeof opt.id === 'string' && opt.id.trim()
                ? opt.id.trim()
                : label
            options.push({ id: optionId, label, description: null })
        }

        if (!question && options.length === 0) continue

        questions.push({
            id: questionId,
            header: header.length > 0 ? header : (requestTitle.length > 0 ? requestTitle : null),
            question,
            options,
            multiSelect
        })
    }

    return { questions }
}
