import { asString, isObject } from '@hapi/protocol';

/** The question card HAPI clients already render for an agent's question. */
export const QUESTION_TOOL_NAME = 'AskUserQuestion';

type Choice = { value: string; label: string };

export type AgyQuestion = {
    key: string;
    otherKey: string | null;
    question: string;
    choices: Choice[];
    multiSelect: boolean;
};

export type AgyQuestionForm = { toolCallId: string | null; questions: AgyQuestion[] };

type AskUserQuestionInput = {
    questions: Array<{
        question: string;
        header: null;
        options: Array<{ label: string; description: null }>;
        multiSelect: boolean;
        /** Absent when unknown (the tool call's own input). */
        allowFreeText?: boolean;
    }>;
};

function readChoices(entries: unknown): Choice[] {
    if (!Array.isArray(entries)) return [];
    const choices: Choice[] = [];
    for (const entry of entries) {
        if (!isObject(entry)) continue;
        const value = asString(entry.const);
        if (value === null) continue;
        choices.push({ value, label: asString(entry.title) ?? value });
    }
    return choices;
}

/**
 * agy's `ask_question` as an ACP form elicitation: question N is property
 * `qN` (single choice: string with oneOf; multi-select: array with
 * items.anyOf), with an optional free-form `qN_other`.
 */
export function parseAgyQuestionForm(params: unknown): AgyQuestionForm | null {
    if (!isObject(params)) return null;
    if (params.mode !== undefined && params.mode !== 'form') return null;
    const schema = params.requestedSchema;
    const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : null;
    if (!properties) return null;
    const questions: AgyQuestion[] = [];
    const keys = Object.keys(properties)
        .filter((key) => /^q\d+$/.test(key))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    for (const key of keys) {
        const property = properties[key];
        if (!isObject(property)) continue;
        const multiSelect = property.type === 'array';
        const items = isObject(property.items) ? property.items : null;
        const choices = multiSelect
            ? readChoices(items?.anyOf ?? items?.oneOf)
            : readChoices(property.oneOf ?? property.anyOf);
        const otherKey = `${key}_other`;
        questions.push({
            key,
            otherKey: otherKey in properties ? otherKey : null,
            question: asString(property.title) ?? '',
            choices,
            multiSelect
        });
    }
    if (questions.length === 0) return null;
    return { toolCallId: asString(params.toolCallId), questions };
}

export function questionCardInput(questions: AgyQuestion[]): AskUserQuestionInput {
    return {
        questions: questions.map((question) => ({
            question: question.question,
            header: null,
            options: question.choices.map((choice) => ({ label: choice.label, description: null })),
            multiSelect: question.multiSelect,
            allowFreeText: question.otherKey !== null
        }))
    };
}

/**
 * The `ask_question` tool call's own input, shown as the same question card.
 * agy sends the questions as an array; its transcript stores a JSON string.
 */
export function questionCardInputFromToolCall(input: unknown): AskUserQuestionInput | null {
    if (!isObject(input)) return null;
    let raw: unknown = input.questions;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(raw)) return null;
    const questions = raw.filter(isObject).map((entry) => ({
        question: asString(entry.question) ?? '',
        header: null,
        options: (Array.isArray(entry.options) ? entry.options : [])
            .map((option) => asString(option))
            .filter((label): label is string => Boolean(label))
            .map((label) => ({ label, description: null })),
        multiSelect: entry.is_multi_select === true
    }));
    return questions.length > 0 ? { questions } : null;
}

function answerValues(answer: unknown): string[] {
    const values = Array.isArray(answer)
        ? answer
        : isObject(answer) && Array.isArray(answer.answers) ? answer.answers : [];
    return values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

/**
 * The card's answers (option labels plus any typed text, per question index)
 * in agy's shape: the chosen option values, and free text under `qN_other`
 * only when the user typed some, so agy records exactly the chosen label.
 * `shownLabels` are the labels the card showed (from the tool call), matched
 * by position when they differ from the form's option titles.
 */
export function agyQuestionContent(
    questions: AgyQuestion[],
    answers: Record<string, unknown> | undefined,
    shownLabels?: string[][]
): Record<string, string | string[]> {
    const content: Record<string, string | string[]> = {};
    questions.forEach((question, index) => {
        const values = answerValues(answers?.[String(index)]);
        const chosen: string[] = [];
        const typed: string[] = [];
        for (const value of values) {
            const shown = shownLabels?.[index];
            // By position only when the card showed exactly the form's options.
            const shownIndex = shown && shown.length === question.choices.length
                ? shown.findIndex((label) => label.trim() === value)
                : -1;
            const choice = question.choices.find((candidate) => candidate.label.trim() === value)
                ?? (shownIndex >= 0 ? question.choices[shownIndex] : undefined);
            if (choice) chosen.push(choice.value);
            else typed.push(value);
        }
        if (chosen.length > 0) content[question.key] = question.multiSelect ? chosen : chosen[0]!;
        if (typed.length > 0 && question.otherKey) content[question.otherKey] = typed.join(', ');
    });
    return content;
}
