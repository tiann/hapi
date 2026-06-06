import { describe, expect, it } from 'vitest';
import { getToolFullViewComponent, getToolViewComponent } from '@/components/ToolCard/views/_all';

describe('Cursor ACP tool views', () => {
    it('registers CursorAskQuestion and CursorCreatePlan views', () => {
        expect(getToolViewComponent('CursorAskQuestion')).toBeDefined();
        expect(getToolFullViewComponent('CursorAskQuestion')).toBeDefined();
        expect(getToolFullViewComponent('CursorCreatePlan')).toBeDefined();
    });
});
