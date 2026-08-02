/**
 * agy's `ask_question` tool is a native TUI selector, not a permission-gated
 * tool call — it never goes through the PreToolUse hook (agyPermissionHandler
 * never sees a `requestDecision` call for it). Its full definition (all
 * sub-questions, options, multi-select flags) arrives already-structured in
 * the PLANNER_RESPONSE.tool_calls entry (see agyTranscriptTypes.ts), so no
 * TUI text parsing is needed — just a shape translation.
 *
 * agy's native arg shape uses plain string options and a snake_case
 * `is_multi_select` flag:
 *   { questions: [{ question, options: string[], is_multi_select }] }
 * The web's AskUserQuestionView/Footer (shared with claude/cursor) expects the
 * canonical shape used by `parseAskUserQuestionInput`:
 *   { questions: [{ question, header?, multiSelect, options: [{ label, description? }] }] }
 * Translating here (CLI side) — rather than teaching the web parser a third
 * shape — mirrors the existing AGY_TOOL_SPECS/mapAgyToolCall convention in
 * normalizeAgent.ts (agy-native args -> canonical fields) and lets agy's
 * question reuse the AskUserQuestionView/Footer with zero web changes.
 */

export type AgyAskQuestionOption = {
    label: string
}

export type AgyAskQuestionQuestion = {
    question: string
    options: AgyAskQuestionOption[]
    multiSelect: boolean
}

export type AgyAskQuestionInput = {
    questions: AgyAskQuestionQuestion[]
}

/** True when a planner tool_call is agy's native `ask_question` invocation. */
export function isAgyAskQuestionToolCall(toolCall: { name: string } | null | undefined): boolean {
    return toolCall?.name === 'ask_question'
}

/**
 * Translate agy's raw `ask_question` args into the canonical
 * AskUserQuestionView/Footer input shape. Defensive against malformed/partial
 * args (missing questions, non-string options, etc.) — always returns a
 * (possibly empty) questions array rather than throwing, since this runs on
 * live model output.
 */
export function buildCanonicalAskUserQuestionInput(args: Record<string, unknown> | null | undefined): AgyAskQuestionInput {
    const rawQuestions = args && Array.isArray(args.questions) ? args.questions : []
    const questions: AgyAskQuestionQuestion[] = []

    for (const raw of rawQuestions) {
        if (!raw || typeof raw !== 'object') continue
        const q = raw as Record<string, unknown>

        const question = typeof q.question === 'string' ? q.question.trim() : ''
        const multiSelect = q.is_multi_select === true

        const rawOptions = Array.isArray(q.options) ? q.options : []
        const options: AgyAskQuestionOption[] = []
        for (const opt of rawOptions) {
            if (typeof opt === 'string') {
                const label = opt.trim()
                if (label.length > 0) options.push({ label })
                continue
            }
            if (opt && typeof opt === 'object' && typeof (opt as Record<string, unknown>).label === 'string') {
                const label = ((opt as Record<string, unknown>).label as string).trim()
                if (label.length > 0) options.push({ label })
            }
        }

        if (!question && options.length === 0) continue
        questions.push({ question, options, multiSelect })
    }

    return { questions }
}
