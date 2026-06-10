import { describe, expect, it } from 'vitest';
import { isCursorAskQuestionToolName, parseCursorAskQuestionInput } from '@/components/ToolCard/cursorAskQuestion';
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion';

describe('cursorAskQuestion', () => {
    it('is recognized as an ask-question tool', () => {
        expect(isCursorAskQuestionToolName('CursorAskQuestion')).toBe(true);
        expect(isAskUserQuestionToolName('CursorAskQuestion')).toBe(true);
    });

    it('parses Cursor ask_question payload shape', () => {
        const parsed = parseCursorAskQuestionInput({
            toolCallId: 'q-1',
            title: 'Choose approach',
            questions: [
                {
                    id: 'approach',
                    prompt: 'Which approach?',
                    allowMultiple: false,
                    options: [
                        { id: 'a', label: 'Option A' },
                        { id: 'b', label: 'Option B' }
                    ]
                }
            ]
        });

        expect(parsed.questions).toHaveLength(1);
        expect(parsed.questions[0]).toMatchObject({
            id: 'approach',
            header: 'Choose approach',
            question: 'Which approach?',
            multiSelect: false,
            options: [
                { id: 'a', label: 'Option A', description: null },
                { id: 'b', label: 'Option B', description: null }
            ]
        });
    });

    it('preserves stable ids used by AskUserQuestionFooter ACP submit', () => {
        const parsed = parseCursorAskQuestionInput({
            questions: [
                {
                    id: 'approach',
                    prompt: 'Which approach?',
                    options: [{ id: 'a', label: 'Option A' }]
                }
            ]
        });
        const q = parsed.questions[0];
        expect(q?.id).toBe('approach');
        expect(q?.options[0]?.id).toBe('a');
        // Mirrors AskUserQuestionFooter: question.id + option.id, not index/label.
        expect({ [q!.id!]: [q!.options[0]!.id!] }).toEqual({ approach: ['a'] });
    });

    it('returns empty questions for invalid input', () => {
        expect(parseCursorAskQuestionInput(null).questions).toEqual([]);
        expect(parseCursorAskQuestionInput({}).questions).toEqual([]);
    });
});
