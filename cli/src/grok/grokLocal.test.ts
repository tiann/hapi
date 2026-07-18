import { describe, expect, it } from 'vitest';
import { buildGrokLocalArgs, buildGrokLocalSpawnOptions } from './grokLocal';
import { resolveGrokLocalSession } from './grokLocalLauncher';

describe('buildGrokLocalArgs', () => {
    it('starts a new native TUI with a preallocated UUID and cwd', () => {
        expect(buildGrokLocalArgs({ cwd: '/tmp/project', sessionId: '11111111-1111-4111-8111-111111111111' }))
            .toEqual([
                '--sandbox', 'workspace', '--no-alt-screen', '--cwd', '/tmp/project',
                '--session-id', '11111111-1111-4111-8111-111111111111'
            ]);
    });

    it('resumes the exact native session id', () => {
        expect(buildGrokLocalArgs({ cwd: '/tmp/project', sessionId: 'abc', resume: true }))
            .toEqual(['--sandbox', 'workspace', '--no-alt-screen', '--cwd', '/tmp/project', '--resume', 'abc']);
    });

    it.each([
        ['default', 'workspace', false],
        ['read-only', 'read-only', false],
        ['safe-yolo', 'workspace', true],
        ['yolo', 'off', true]
    ] as const)('uses sandbox %s => %s and auto approval=%s', (permissionMode, profile, autoApprove) => {
        const args = buildGrokLocalArgs({ cwd: '/tmp/project', sessionId: 'abc', permissionMode });
        expect(args.slice(0, 2)).toEqual(['--sandbox', profile]);
        expect(args.includes('--always-approve')).toBe(autoApprove);
    });

    it('passes initial model and reasoning effort to the native TUI', () => {
        expect(buildGrokLocalArgs({
            cwd: '/tmp/project', sessionId: 'abc', model: 'grok-4.5', effort: 'high'
        })).toEqual([
            '--sandbox', 'workspace', '--model', 'grok-4.5', '--reasoning-effort', 'high',
            '--no-alt-screen', '--cwd', '/tmp/project', '--session-id', 'abc'
        ]);
    });

    it('resumes any existing Grok session when switching back to local', () => {
        expect(resolveGrokLocalSession('existing-id')).toEqual({ sessionId: 'existing-id', resume: true });
        expect(resolveGrokLocalSession(null, () => 'new-id')).toEqual({ sessionId: 'new-id', resume: false });
    });

    it('preserves hostile-looking argv as data and never launches through a shell', () => {
        const abort = new AbortController().signal;
        const options = buildGrokLocalSpawnOptions({
            path: 'C:\\repo & calc.exe',
            abort,
            env: {
                PATH: 'C:\\bin',
                HOME: 'C:\\Users\\dev',
                CLI_API_TOKEN: 'hapi-secret',
                OPENAI_API_KEY: 'other-provider-secret'
            },
            sessionId: '11111111-1111-4111-8111-111111111111',
            model: 'grok-4.5 & calc.exe',
            effort: 'high'
        });

        expect(options).toMatchObject({
            command: 'grok',
            cwd: 'C:\\repo & calc.exe',
            shell: false,
            signal: abort,
            env: { PATH: 'C:\\bin', HOME: 'C:\\Users\\dev' }
        });
        expect(options.args).toContain('grok-4.5 & calc.exe');
    });
});
