import { describe, expect, it } from 'vitest';
import { deriveAgyFallbackTitle, extractAgyTitleMarker } from './title';

describe('agy title helpers', () => {
    it('extracts and strips the HAPI title marker from the first line', () => {
        expect(extractAgyTitleMarker('HAPI_TITLE: agy乱码修复 · 实测\n\n正文')).toEqual({
            title: 'agy乱码修复 · 实测',
            text: '正文'
        });
    });

    it('leaves text unchanged when no title marker is present', () => {
        expect(extractAgyTitleMarker('正文')).toEqual({
            title: null,
            text: '正文'
        });
    });

    it('derives a fallback title from the first user message while skipping attachment lines', () => {
        expect(deriveAgyFallbackTitle('@/tmp/upload.png\n请调四家审查 agy handoff 问题')).toBe('请调四家审查 agy handoff 问题');
    });
});
