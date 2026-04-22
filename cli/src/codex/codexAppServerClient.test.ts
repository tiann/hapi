import { describe, expect, it } from 'vitest';
import { resolveCodexAppServerCommand } from './codexAppServerClient';

describe('resolveCodexAppServerCommand', () => {
    it('uses CODEX_BIN when provided', () => {
        expect(resolveCodexAppServerCommand({ CODEX_BIN: '/home/user/.npm-global/bin/codex' })).toBe('/home/user/.npm-global/bin/codex');
    });

    it('falls back to codex when CODEX_BIN is empty', () => {
        expect(resolveCodexAppServerCommand({ CODEX_BIN: '' })).toBe('codex');
    });
});
