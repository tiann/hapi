import { describe, expect, it } from 'vitest';
import { deriveToolName, deriveToolNameWithSource, isPlaceholderToolName } from './utils';

describe('agent tool name helpers', () => {
    it('treats generic kind fallback as placeholder', () => {
        expect(deriveToolName({ kind: 'other' })).toBe('Tool');
        expect(deriveToolName({ kind: 'unknown' })).toBe('Tool');
    });

    it('keeps source metadata for explicit raw input names', () => {
        const derived = deriveToolNameWithSource({
            kind: 'execute',
            rawInput: { name: 'Bash' }
        });
        expect(derived).toEqual({
            name: 'Bash',
            source: 'raw_input_name'
        });
    });

    it('marks placeholder tool names', () => {
        expect(isPlaceholderToolName('other')).toBe(true);
        expect(isPlaceholderToolName('tool')).toBe(true);
        expect(isPlaceholderToolName('search')).toBe(false);
    });

    describe('kind=edit _meta.kind mapping (Gemini write_file / replace)', () => {
        // Phase 3a Red tests (2026-05-05)
        // kind=edit + _meta.kind=add  → 'Write'
        // kind=edit + _meta.kind=modify → 'Edit'
        // _meta absent → existing kind fallback unchanged

        it('maps kind=edit + metaKind=add to Write', () => {
            const derived = deriveToolNameWithSource({
                kind: 'edit',
                metaKind: 'add'
            });
            expect(derived.name).toBe('Write');
        });

        it('maps kind=edit + metaKind=modify to Edit', () => {
            const derived = deriveToolNameWithSource({
                kind: 'edit',
                metaKind: 'modify'
            });
            expect(derived.name).toBe('Edit');
        });

        it('falls back to kind-based name when metaKind is absent', () => {
            // Without metaKind the existing behaviour must be preserved:
            // kind='edit' is not a placeholder so it surfaces as 'edit'
            const derived = deriveToolNameWithSource({
                kind: 'edit'
            });
            expect(derived.source).toBe('kind');
            expect(derived.name).toBe('edit');
        });

        it('title still wins over metaKind when title is present', () => {
            // title takes highest priority — metaKind must NOT override it
            const derived = deriveToolNameWithSource({
                title: 'MyCustomTool',
                kind: 'edit',
                metaKind: 'add'
            });
            expect(derived.name).toBe('MyCustomTool');
            expect(derived.source).toBe('title');
        });
    });
});
