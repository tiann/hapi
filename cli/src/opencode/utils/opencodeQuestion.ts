import { asString, isObject } from '@hapi/protocol';
import type { AgentMessage, FormElicitationContent } from '@/agent/types';

/**
 * OpenCode (v2) asks `question` tool calls through ACP `elicitation/create`.
 * The form it sends has one property per question (`q0`, `q1`, ...): a
 * `oneOf` string for single choice or an `items.anyOf` array for multiple
 * choice, plus an optional `<key>_custom` string for a typed-in answer.
 * These helpers translate that form to the Claude `AskUserQuestion` input the
 * web card renders, and the card's answers back to the form content.
 */

/** Tool name shared with Claude so the web, hub notifications and summaries treat it as a question. */
export const QUESTION_DISPLAY_TOOL_NAME = 'AskUserQuestion';

/** Native OpenCode tool name as it appears in `tool_call` updates. */
export const OPENCODE_QUESTION_TOOL_NAME = 'question';

export type QuestionOption = {
    /** Value OpenCode expects back. */
    value: string;
    label: string;
    description?: string;
};

export type ElicitedQuestion = {
    key: string;
    header: string | null;
    question: string;
    options: QuestionOption[];
    multiple: boolean;
    /** Key of the free-text partner property, when the form allows typed answers. */
    customKey: string | null;
};

const CUSTOM_SUFFIX = '_custom';

function parseOptions(entries: unknown): QuestionOption[] | null {
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) return null;
    const options: QuestionOption[] = [];
    for (const entry of entries) {
        if (!isObject(entry)) return null;
        const value = asString(entry.const);
        if (value === null) return null;
        const description = asString(entry.description);
        options.push({
            value,
            label: asString(entry.title) ?? value,
            ...(description ? { description } : {})
        });
    }
    return options;
}

/** Returns null for any form this adapter cannot answer faithfully. */
export function parseQuestionSchema(schema: unknown): ElicitedQuestion[] | null {
    if (!isObject(schema) || !isObject(schema.properties)) return null;
    const properties = schema.properties;
    const keys = Object.keys(properties);
    const questions: ElicitedQuestion[] = [];

    for (const key of keys) {
        if (key.endsWith(CUSTOM_SUFFIX) && properties[key.slice(0, -CUSTOM_SUFFIX.length)] !== undefined) {
            continue;
        }
        const property = properties[key];
        if (!isObject(property)) return null;

        let multiple: boolean;
        let options: QuestionOption[] | null;
        if (property.type === 'string') {
            multiple = false;
            options = parseOptions(property.oneOf);
        } else if (property.type === 'array') {
            multiple = true;
            options = isObject(property.items) ? parseOptions(property.items.anyOf) : null;
        } else {
            return null;
        }
        if (!options) return null;

        const customKey = `${key}${CUSTOM_SUFFIX}`;
        questions.push({
            key,
            header: asString(property.title),
            question: asString(property.description) ?? asString(property.title) ?? key,
            options,
            multiple,
            customKey: properties[customKey] !== undefined ? customKey : null
        });
    }

    return questions.length > 0 ? questions : null;
}

export function toAskUserQuestionInput(questions: ElicitedQuestion[]): { questions: Array<Record<string, unknown>> } {
    return {
        questions: questions.map((question) => ({
            header: question.header ?? '',
            question: question.question,
            options: question.options.map((option) => ({
                label: option.label,
                ...(option.description ? { description: option.description } : {})
            })),
            multiSelect: question.multiple,
            allowFreeText: question.customKey !== null
        }))
    };
}

/**
 * Converts the card's answers (`{"0": ["승인"]}`, keyed by question index or
 * schema key) to `elicitation/create` content. Returns null when nothing was
 * answered, which the caller treats as a dismissal.
 */
export function buildQuestionContent(
    questions: ElicitedQuestion[],
    answers: Record<string, unknown>
): FormElicitationContent | null {
    const content: FormElicitationContent = {};

    questions.forEach((question, index) => {
        const raw = answers[String(index)] ?? answers[question.key];
        const values = (Array.isArray(raw) ? raw : [])
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (values.length === 0) return;

        const chosen: string[] = [];
        const typed: string[] = [];
        for (const value of values) {
            const option = question.options.find((candidate) => candidate.value === value || candidate.label === value);
            if (option) chosen.push(option.value);
            else typed.push(value);
        }

        const typedAnswer = question.customKey && typed.length > 0 ? typed.join(', ') : null;
        if (question.multiple) {
            if (chosen.length > 0) content[question.key] = chosen;
            if (typedAnswer) content[question.customKey as string] = typedAnswer;
        } else if (typedAnswer) {
            // OpenCode prefers a non-empty typed answer over the selection.
            content[question.customKey as string] = typedAnswer;
        } else if (chosen.length > 0) {
            content[question.key] = chosen[0] as string;
        }
    });

    return Object.keys(content).length > 0 ? content : null;
}

/** OpenCode names the per-question flags `multiple` and `custom`; the web card reads `multiSelect` and `allowFreeText`. */
export function normalizeQuestionToolInput(input: unknown): unknown {
    if (!isObject(input) || !Array.isArray(input.questions)) return input;
    return {
        ...input,
        questions: input.questions.map((question) => {
            if (!isObject(question)) return question;
            const { multiple, custom, ...rest } = question;
            return {
                ...rest,
                ...('multiple' in question ? { multiSelect: multiple === true } : {}),
                // OpenCode's per-question `custom` (typed answers allowed, default true).
                ...(typeof custom === 'boolean' ? { allowFreeText: custom } : {})
            };
        })
    };
}

/**
 * Presents OpenCode's native `question` tool call as `AskUserQuestion`, so the
 * request raised for it (same tool call id) and the tool card agree on one
 * tool name and one input shape.
 */
export function presentQuestionToolCall(message: AgentMessage): AgentMessage {
    if (message.type !== 'tool_call' || message.name !== OPENCODE_QUESTION_TOOL_NAME) return message;
    return {
        ...message,
        name: QUESTION_DISPLAY_TOOL_NAME,
        input: normalizeQuestionToolInput(message.input)
    };
}
