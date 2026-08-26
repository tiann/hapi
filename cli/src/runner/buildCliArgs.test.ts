import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCliArgs, classifyRecoveredProcessGeneration, createSpawnDeduplicator, releaseRecoveredSpawnDedupe } from './run'

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

    it('passes --collaboration-mode through for codex Plan mode', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            collaborationMode: 'plan',
        })
        expect(args).toContain('--collaboration-mode')
        expect(args).toContain('plan')
    })

    it('omits --collaboration-mode for default collaboration mode', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            collaborationMode: 'default',
        })
        expect(args).not.toContain('--collaboration-mode')
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



    it('passes the preallocated HAPI id to OpenCode without resuming its native session', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            existingSessionId: 'fresh-hapi-session',
        })

        expect(args).toContain('--existing-session-id')
        expect(args).toContain('fresh-hapi-session')
        expect(args).not.toContain('--resume')
    })

    it('passes the existing HAPI row id when resuming OpenCode', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            resumeSessionId: 'opencode-session-1',
            existingSessionId: 'hapi-session-1',
        })
        expect(args).toContain('--resume')
        expect(args).toContain('opencode-session-1')
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-1')
        expect(args).not.toContain('--hapi-session-id')
    })

    it('passes --existing-session-id for cursor resume when sessionId is set (#991)', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp',
            resumeSessionId: 'cursor-csid-1',
            sessionId: 'hapi-session-991',
        })
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-991')
        expect(args).toContain('--resume')
        expect(args).toContain('cursor-csid-1')
    })

    it('does not pass --collaboration-mode for non-codex agents', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            collaborationMode: 'plan',
        })
        expect(args).not.toContain('--collaboration-mode')
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

    it('skips --cursor-worktree when directory is already a linked git worktree', () => {
        const main = mkdtempSync(join(tmpdir(), 'hapi-cliargs-main-'))
        const linkedParent = mkdtempSync(join(tmpdir(), 'hapi-cliargs-wt-'))
        const linked = join(linkedParent, 'feature')
        const gitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.com'
        }
        const git = (cwd: string, args: string[]) => {
            execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv })
        }
        try {
            git(main, ['init'])
            writeFileSync(join(main, 'README'), 'x\n')
            git(main, ['add', 'README'])
            git(main, ['commit', '-m', 'init'])
            git(main, ['worktree', 'add', '-b', 'feature', linked])

            const args = buildCliArgs('cursor', {
                directory: linked,
                sessionType: 'worktree',
                worktreeName: 'should-not-appear',
            })
            expect(args).not.toContain('--cursor-worktree')
            expect(args).not.toContain('should-not-appear')
        } finally {
            rmSync(linkedParent, { recursive: true, force: true })
            rmSync(main, { recursive: true, force: true })
        }
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

    it('reuses the original HAPI row for Pi native resume', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            resumeSessionId: 'pi-native-session-1',
            existingSessionId: 'hapi-session-pi-1',
        })

        expect(args).toContain('--session-id')
        expect(args).toContain('pi-native-session-1')
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-pi-1')
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

    it('passes --fork-session and --existing-session-id for Claude message-level fork', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            resumeSessionId: 'claude-source-id',
            existingSessionId: 'hapi-child-id',
            forkSession: true,
        })
        expect(args).toContain('--resume')
        expect(args).toContain('claude-source-id')
        expect(args).toContain('--fork-session')
        expect(args.indexOf('--fork-session')).toBeGreaterThan(args.indexOf('--resume'))
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-child-id')
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
    it('emits --existing-session-id for agy reopen', () => {
        const args = buildCliArgs('agy', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
        })
        expect(args).toContain('--existing-session-id')
        expect(args[args.indexOf('--existing-session-id') + 1]).toBe('existing-hub-id')
        expect(args).not.toContain('--hapi-session-id')
    })

    it('builds a remote DSH ACP runner command without unsupported policy flags', () => {
        const args = buildCliArgs('dsh', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
            permissionMode: 'read-only'
        }, true)
        expect(args).toEqual([
            'dsh',
            '--hapi-starting-mode', 'remote',
            '--started-by', 'runner',
            '--existing-session-id', 'existing-hub-id'
        ])
    })

    it('does not emit --hapi-session-id for a non-pty flavor', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
        })
        expect(args).not.toContain('--hapi-session-id')
    })

})


describe('createSpawnDeduplicator', () => {
    it('rehydrates a live child after runner restart without spawning again', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'success' as const, sessionId: 'duplicate' }
        })

        dedupe.recoverChild('fresh-hapi-session', {
            type: 'error',
            errorMessage: 'Session fresh-hapi-session is still starting'
        })

        await expect(dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })).resolves.toEqual({
            type: 'error', errorMessage: 'Session fresh-hapi-session is still starting'
        })
        expect(calls).toBe(0)
    })

    it('shares an in-flight spawn and its successful result while the child is alive', async () => {
        let calls = 0
        let resolveSpawn: ((result: { type: 'success'; sessionId: string }) => void) | undefined
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return await new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
                resolveSpawn = resolve
            })
        })

        const first = dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })
        const concurrentRetry = dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })
        expect(calls).toBe(1)
        resolveSpawn?.({ type: 'success', sessionId: 'fresh-hapi-session' })
        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        await expect(concurrentRetry).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })

        await expect(dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })).resolves.toEqual({
            type: 'success', sessionId: 'fresh-hapi-session'
        })
        expect(calls).toBe(1)
    })

    it('retries immediately when spawning fails before a child PID is registered', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'error' as const, errorMessage: 'Failed to spawn HAPI process - no PID returned' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Failed to spawn HAPI process - no PID returned' })
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Failed to spawn HAPI process - no PID returned' })

        expect(calls).toBe(2)
    })

    it('keeps a timed-out child deduped until the runner observes its exit', async () => {
        let calls = 0
        let dedupe!: ReturnType<typeof createSpawnDeduplicator>
        dedupe = createSpawnDeduplicator(async (options) => {
            calls += 1
            dedupe.markChildAlive(options.existingSessionId!)
            return { type: 'error' as const, errorMessage: 'Session webhook timeout' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        expect(calls).toBe(1)

        dedupe.onChildExited('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        expect(calls).toBe(2)
    })

    it('keeps a stopped child deduped until the runner observes its exit', async () => {
        let calls = 0
        let dedupe!: ReturnType<typeof createSpawnDeduplicator>
        dedupe = createSpawnDeduplicator(async (options) => {
            calls += 1
            dedupe.markChildAlive(options.existingSessionId!)
            return { type: 'success' as const, sessionId: 'fresh-hapi-session' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })

        // stopSession() has only requested termination; the child can still be alive.
        dedupe.markChildStopping('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        expect(calls).toBe(1)

        dedupe.onChildExited('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        expect(calls).toBe(2)
    })
})

describe('classifyRecoveredProcessGeneration', () => {
    it('quarantines a live recovered child while its generation marker is unavailable', () => {
        expect(classifyRecoveredProcessGeneration(true, null, 'persisted-marker')).toBe('quarantined')
    })

    it('releases quarantine only after exit or a generation mismatch is proven', () => {
        expect(classifyRecoveredProcessGeneration(false, null, 'persisted-marker')).toBe('exited')
        expect(classifyRecoveredProcessGeneration(true, 'other-marker', 'persisted-marker')).toBe('exited')
        expect(classifyRecoveredProcessGeneration(true, 'persisted-marker', 'persisted-marker')).toBe('verified')
    })
})

describe('releaseRecoveredSpawnDedupe', () => {
    it('allows an immediate same-row spawn after a recovered child reaches a terminal stop branch', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'success' as const, sessionId: 'fresh-hapi-session' }
        })
        dedupe.recoverChild('fresh-hapi-session', { type: 'success', sessionId: 'fresh-hapi-session' })
        const recovered = new Map([[123, 'fresh-hapi-session']])

        releaseRecoveredSpawnDedupe(123, recovered, dedupe)
        await dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })

        expect(calls).toBe(1)
        expect(recovered.has(123)).toBe(false)
    })
})
