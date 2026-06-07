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
        const args = buildCliArgs('gemini', {
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

    it('validates all known permission modes', () => {
        for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'ask', 'read-only', 'safe-yolo', 'yolo']) {
            const args = buildCliArgs('claude', {
                directory: '/tmp',
                permissionMode: mode,
            })
            expect(args).toContain('--permission-mode')
            expect(args).toContain(mode)
        }
    })

    it('skips --resume for pi (resume is out of scope; would create orphan session)', () => {
        // Pi session resume is currently out of scope — hub has no
        // piSessionId path on Metadata, so the resume would succeed at
        // the pi CLI level but the new session would be untracked. The
        // hub already returns null from resolveAgentResumeId for
        // flavor='pi' and falls through to fresh spawn, but if a
        // resumeSessionId is somehow attached at the runner layer we
        // must NOT forward --resume to the pi binary.
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            resumeSessionId: 'some-pi-session-id',
        })
        expect(args).not.toContain('--resume')
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
})
