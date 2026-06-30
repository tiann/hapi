import { describe, it, expect } from 'vitest'
import { buildCliArgs } from './run'

describe('buildCliArgs', () => {
    it('adds --permission-mode for valid permission mode', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'bypassPermissions',
        })
        expect(args).toContain('--permission-mode')
        expect(args).toContain('bypassPermissions')
        expect(args).not.toContain('--yolo')
    })

    it('ignores invalid permission mode and falls back to --yolo', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'not-a-real-mode',
        }, true)
        expect(args).not.toContain('--permission-mode')
        expect(args).toContain('--yolo')
    })

    it('ignores invalid permission mode without yolo fallback', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'not-a-real-mode',
        })
        expect(args).not.toContain('--permission-mode')
        expect(args).not.toContain('--yolo')
    })

    it('prefers --permission-mode over --yolo when both present', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp',
            permissionMode: 'yolo',
        }, true)
        expect(args).toContain('--permission-mode')
        expect(args).toContain('yolo')
        // --yolo flag should NOT be added when --permission-mode is used
        const permIdx = args.indexOf('--permission-mode')
        const yoloIdx = args.indexOf('--yolo')
        expect(yoloIdx).toBe(-1)
    })

    it('throws for the removed gemini agent (no longer launchable)', () => {
        expect(() => buildCliArgs('gemini', { directory: '/tmp' })).toThrow(/no longer supported/)
    })

    it('adds --yolo when no permissionMode and yolo is true', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
        }, true)
        expect(args).toContain('--yolo')
        expect(args).not.toContain('--permission-mode')
    })

    it('passes --model through for opencode (mid-session model change support)', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            model: 'ollama/exaone:4.5-33b-q8',
        })
        expect(args).toContain('--model')
        expect(args).toContain('ollama/exaone:4.5-33b-q8')
    })



    it('passes --model-reasoning-effort through for opencode', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            modelReasoningEffort: 'high',
        })
        expect(args).toContain('--model-reasoning-effort')
        expect(args).toContain('high')
    })

    it('passes --service-tier through for codex (resume preserves Fast/Standard)', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            serviceTier: 'fast',
        })
        expect(args).toContain('--service-tier')
        expect(args).toContain('fast')
    })

    it('does not pass --service-tier for non-codex agents', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            serviceTier: 'fast',
        })
        expect(args).not.toContain('--service-tier')
    })

    it('passes existing Hapi session id separately from Codex resume thread', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            resumeSessionId: 'codex-thread-1',
            existingSessionId: 'hapi-session-1',
            model: 'gpt-5.5',
            modelReasoningEffort: 'low',
        })
        expect(args).toEqual([
            'codex',
            'resume',
            'codex-thread-1',
            '--hapi-starting-mode',
            'remote',
            '--started-by',
            'runner',
            '--existing-session-id',
            'hapi-session-1',
            '--model',
            'gpt-5.5',
            '--model-reasoning-effort',
            'low',
        ])
    })



    it('does not pass Codex-only existing session id flag to non-Codex agents', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            resumeSessionId: 'claude-session-1',
            existingSessionId: 'hapi-session-1',
        })
        expect(args).toContain('--resume')
        expect(args).toContain('claude-session-1')
        expect(args).not.toContain('--existing-session-id')
        expect(args).not.toContain('hapi-session-1')
    })

    it('validates all known permission modes', () => {
        for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'ask', 'debug', 'autoReview', 'read-only', 'safe-yolo', 'yolo']) {
            const args = buildCliArgs('claude', {
                directory: '/tmp',
                permissionMode: mode,
            })
            expect(args).toContain('--permission-mode')
            expect(args).toContain(mode)
        }
    })

    it('passes --cursor-worktree for cursor worktree sessions', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
            worktreeName: 'feature-x',
        })
        expect(args).toContain('--cursor-worktree')
        expect(args).toContain('feature-x')
    })

    it('passes bare --cursor-worktree when name is omitted', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
        })
        expect(args).toContain('--cursor-worktree')
        expect(args[args.length - 1]).toBe('--cursor-worktree')
    })

    it('does not pass --cursor-worktree for non-cursor worktree sessions', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
            worktreeName: 'feature-x',
        })
        expect(args).not.toContain('--cursor-worktree')
    })

    it('uses --session-id for pi resume (not --resume)', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            resumeSessionId: 'some-pi-session-id',
        })
        expect(args).not.toContain('--resume')
        expect(args).toContain('--session-id')
        expect(args).toContain('some-pi-session-id')
        expect(args[0]).toBe('pi')
    })

    it('still passes --resume for claude when resumeSessionId is provided', () => {
        // Guard against accidentally swallowing claude's --resume when
        // the pi branch was added.
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            resumeSessionId: 'some-claude-session-id',
        })
        expect(args).toContain('--resume')
        expect(args).toContain('some-claude-session-id')
    })

    it('passes --effort for pi agent', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            effort: 'high',
        })
        expect(args).toContain('--effort')
        expect(args).toContain('high')
    })

    it('passes --effort for claude agent', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            effort: 'high',
        })
        expect(args).toContain('--effort')
        expect(args).toContain('high')
    })

    it('builds Grok runner resume, model, effort, and permission arguments', () => {
        const args = buildCliArgs('grok', {
            directory: '/tmp',
            resumeSessionId: 'grok-session-1',
            model: 'grok-4.5',
            effort: 'low',
            permissionMode: 'plan'
        })

        expect(args).toEqual([
            'grok',
            '--resume', 'grok-session-1',
            '--hapi-starting-mode', 'remote',
            '--started-by', 'runner',
            '--model', 'grok-4.5',
            '--effort', 'low',
            '--permission-mode', 'plan'
        ])
    })
})
