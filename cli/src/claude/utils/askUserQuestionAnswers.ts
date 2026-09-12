import { isObject } from '@hapi/protocol'

export function buildAskUserQuestionUpdatedInput(input: unknown, answers: Record<string, string[]> | Record<string, { answers: string[] }>): Record<string, unknown> {
    // Normalize incoming answers (web sends Record<questionIndex, string[]>;
    // codex pathway sends nested Record<id, { answers: string[] }>) into a
    // single Record<index, string[]> shape we can iterate.
    const indexedAnswers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            indexedAnswers[key] = value;
        } else if (value && typeof value === 'object' && 'answers' in value) {
            indexedAnswers[key] = value.answers;
        }
    }

    if (!isObject(input)) {
        return { answers: {} };
    }

    // claude code 2.x's built-in AskUserQuestion tool expects
    //   answers: Record<questionText, answerString>
    // and joins multi-select answers with a comma; it then echoes them
    // verbatim in the tool result (`mapToolResultToToolResultBlockParam`).
    // Sending the index-keyed `string[]` shape we receive from the web
    // makes claude's lookup miss every question, producing the empty
    // "User has answered your questions: ." result that locks the turn.
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const claudeShapedAnswers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        if (!q || typeof q !== 'object') continue;
        const questionText = (q as { question?: unknown }).question;
        if (typeof questionText !== 'string' || questionText.length === 0) continue;
        const selections = indexedAnswers[String(i)];
        if (!selections || selections.length === 0) continue;
        claudeShapedAnswers[questionText] = selections.join(',');
    }

    return {
        ...input,
        answers: claudeShapedAnswers
    };
}
