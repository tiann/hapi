import { describe, it, expect } from 'vitest'
import { buildCliArgs, buildRunnerPluginSpawnContext } from './run'

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

    it('routes plugin agents through the generic agent-plugin command', () => {
        const args = buildCliArgs('vendor:example-agent', {
            directory: '/tmp',
            model: 'example-large',
            permissionMode: 'yolo',
        })

        expect(args.slice(0, 3)).toEqual(['agent-plugin', '--type', 'vendor:example-agent'])
        expect(args).toContain('--started-by')
        expect(args).toContain('runner')
        expect(args).toContain('--model')
        expect(args).toContain('example-large')
        expect(args).toContain('--permission-mode')
        expect(args).toContain('yolo')
    })

    it('rejects invalid plugin agent ids before spawn args are built', () => {
        expect(() => buildCliArgs('bad/agent', { directory: '/tmp' })).toThrow()
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

    it('uses the runner identity for plugin spawn context when the request omits machineId', () => {
        const context = buildRunnerPluginSpawnContext({
            runnerMachineId: 'runner-1',
            options: {
                directory: '/repo',
                agent: 'codex',
                model: 'gpt-5.5'
            },
            agent: 'codex',
            cwd: '/repo',
            displayArgs: ['codex', '--model', 'gpt-5.5'],
            env: { PATH: '/usr/bin', EMPTY: undefined }
        })

        expect(context).toMatchObject({
            machineId: 'runner-1',
            agent: 'codex',
            directory: '/repo',
            cwd: '/repo',
            args: ['codex', '--model', 'gpt-5.5'],
            envKeys: ['PATH'],
            model: 'gpt-5.5'
        })
    })

    it('does not trust machineId from spawn request options for plugin context', () => {
        const context = buildRunnerPluginSpawnContext({
            runnerMachineId: 'runner-1',
            options: {
                machineId: 'spoofed-runner',
                directory: '/repo'
            } as unknown as Parameters<typeof buildRunnerPluginSpawnContext>[0]['options'],
            agent: 'claude',
            cwd: '/repo',
            displayArgs: ['claude'],
            env: {}
        })

        expect(context.machineId).toBe('runner-1')
    })
})
