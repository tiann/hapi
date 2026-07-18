import { describe, expect, it } from 'vitest';
import { getComposerPermissionModeOptions } from './HappyComposer';

describe('getComposerPermissionModeOptions', () => {
    it('includes bypassPermissions (Yolo) for a non-PTY claude session', () => {
        const options = getComposerPermissionModeOptions('claude', false);
        expect(options.map((o) => o.mode)).toContain('bypassPermissions');
    });

    it('excludes bypassPermissions (Yolo) for a PTY claude session', () => {
        const options = getComposerPermissionModeOptions('claude', true);
        expect(options.map((o) => o.mode)).not.toContain('bypassPermissions');
        // The other live-cycle modes remain offered.
        expect(options.map((o) => o.mode)).toEqual(
            expect.arrayContaining(['default', 'acceptEdits', 'plan', 'auto'])
        );
    });

    it('is a no-op for flavors without a bypassPermissions-equivalent mode name (grok uses the same literal)', () => {
        // grok also uses the literal 'bypassPermissions' — PTY exclusion applies
        // uniformly across any flavor that offers it, not just claude.
        const nonPty = getComposerPermissionModeOptions('grok', false);
        const pty = getComposerPermissionModeOptions('grok', true);
        expect(nonPty.map((o) => o.mode)).toContain('bypassPermissions');
        expect(pty.map((o) => o.mode)).not.toContain('bypassPermissions');
    });

    it('leaves flavors with no bypassPermissions option unaffected by the PTY flag', () => {
        const options = getComposerPermissionModeOptions('codex', true);
        expect(options).toEqual(getComposerPermissionModeOptions('codex', false));
    });
});
