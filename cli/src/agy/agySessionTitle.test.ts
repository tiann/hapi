import { describe, expect, it } from 'vitest';
import { applyAgySessionTitleFallback, cleanPromptForTitle } from './agySessionTitle';
import type { Metadata } from '@/api/types';

describe('agy fallback session title', () => {
    it('keeps the user request while removing raw URLs and markdown links', () => {
        expect(cleanPromptForTitle('https://example.com/private?token=secret\n检查 [会话](/sessions/1234abcd) 的错误'))
            .toBe('检查 会话 的错误');
    });

    it('uses a safe host and path for a URL-only request', () => {
        expect(cleanPromptForTitle('https://example.com/path?token=secret#fragment')).toBe('example.com/path');
    });

    it('limits long titles by Unicode characters', () => {
        expect(cleanPromptForTitle('😀'.repeat(100))).toBe('😀'.repeat(59) + '…');
    });

    it.each([
        { name: 'My title' },
        { summary: { text: 'Native title', updatedAt: 1 } },
        { acpManualTitle: true }
    ])('preserves an existing or manually chosen title: %j', (existing) => {
        let metadata = existing as Metadata;
        applyAgySessionTitleFallback({ updateMetadata: (update: (metadata: Metadata) => Metadata) => { metadata = update(metadata); } } as never, 'new prompt');
        expect(metadata).toEqual(existing);
    });

    it('sets a title when none exists', () => {
        let metadata = {} as Metadata;
        applyAgySessionTitleFallback({ updateMetadata: (update: (metadata: Metadata) => Metadata) => { metadata = update(metadata); } } as never, 'Fix the problem');
        expect(metadata.summary?.text).toBe('Fix the problem');
    });
});
