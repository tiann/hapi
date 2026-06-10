import { describe, expect, it } from 'vitest';
import { createCursorAcpBackend, CURSOR_ACP_REQUIRED_MESSAGE } from './cursorAcpBackend';

describe('createCursorAcpBackend', () => {
    it('uses agent acp command, not stream-json flags', () => {
        const backend = createCursorAcpBackend({ cwd: '/tmp' });
        const internal = backend as unknown as { options: { command: string; args?: string[] } };

        expect(internal.options.command).toBe('agent');
        expect(internal.options.args).toEqual(['acp']);
        expect(internal.options.args).not.toContain('-p');
        expect(internal.options.args).not.toContain('stream-json');
    });

    it('passes --model before acp when a concrete model is requested', () => {
        const backend = createCursorAcpBackend({
            cwd: '/tmp',
            model: 'composer-2.5[fast=true]'
        });
        const internal = backend as unknown as { options: { args?: string[] } };

        expect(internal.options.args).toEqual([
            '--model',
            'composer-2.5[fast=true]',
            'acp'
        ]);
    });

    it('omits --model for default/auto spawn selection', () => {
        const backend = createCursorAcpBackend({ cwd: '/tmp', model: 'auto' });
        const internal = backend as unknown as { options: { args?: string[] } };

        expect(internal.options.args).toEqual(['acp']);
    });
});

describe('CURSOR_ACP_REQUIRED_MESSAGE', () => {
    it('documents that stream-json is not a fallback for new sessions', () => {
        expect(CURSOR_ACP_REQUIRED_MESSAGE).toMatch(/ACP/i);
        expect(CURSOR_ACP_REQUIRED_MESSAGE).not.toMatch(/stream-json/i);
        expect(CURSOR_ACP_REQUIRED_MESSAGE).not.toMatch(/fallback/i);
    });
});
