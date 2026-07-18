import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { generateHookSettingsFile } from './generateHookSettings';

type WrittenSettings = {
    hooks: {
        SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>;
        PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    };
};

const created: string[] = [];

function readSettings(filepath: string): WrittenSettings {
    created.push(filepath);
    return JSON.parse(readFileSync(filepath, 'utf-8')) as WrittenSettings;
}

afterEach(() => {
    for (const filepath of created.splice(0)) {
        try {
            rmSync(filepath, { force: true });
        } catch {
            // best effort
        }
    }
});

describe('generateHookSettingsFile', () => {
    it('registers SessionStart with the hook-forwarder command', () => {
        const settings = readSettings(
            generateHookSettingsFile(45678, 'tok-abc', {
                filenamePrefix: 'test-session-hook',
                logLabel: 'test'
            })
        );

        expect(settings.hooks.SessionStart).toHaveLength(1);
        const entry = settings.hooks.SessionStart[0];
        expect(entry.matcher).toBe('*');
        expect(entry.hooks[0].type).toBe('command');
        expect(entry.hooks[0].command).toContain('hook-forwarder');
        expect(entry.hooks[0].command).toContain('45678');
        expect(entry.hooks[0].command).toContain('tok-abc');
    });

    it('does NOT register PreToolUse by default (SDK/local/remote modes)', () => {
        const settings = readSettings(
            generateHookSettingsFile(45678, 'tok-abc', {
                filenamePrefix: 'test-session-hook',
                logLabel: 'test'
            })
        );

        expect(settings.hooks.PreToolUse).toBeUndefined();
    });

    it('registers PreToolUse only when includePreToolUse is set (PTY mode)', () => {
        const settings = readSettings(
            generateHookSettingsFile(45678, 'tok-abc', {
                filenamePrefix: 'test-pty-hook',
                logLabel: 'test',
                includePreToolUse: true
            })
        );

        expect(settings.hooks.PreToolUse).toHaveLength(1);
        const entry = settings.hooks.PreToolUse![0];
        // matcher '*' matches every tool name (claude's Ghz: !q || q==='*' → true)
        expect(entry.matcher).toBe('*');
        expect(entry.hooks[0].type).toBe('command');
        // same forwarder command — it branches on stdin hook_event_name
        expect(entry.hooks[0].command).toBe(settings.hooks.SessionStart[0].hooks[0].command);
        // generous timeout so the blocking hook survives a slow phone approval
        expect(entry.hooks[0].timeout).toBeGreaterThanOrEqual(600);
        // SessionStart keeps claude's default (no explicit timeout)
        expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBeUndefined();
    });
});
