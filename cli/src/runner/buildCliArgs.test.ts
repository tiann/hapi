import { describe, it, expect } from 'vitest'
import {
    DEFAULT_AGY_MODEL,
    DEFAULT_ARK_MODEL,
    DEFAULT_CC_API_MODEL,
    DEFAULT_CLAUDE_DEEPSEEK_MODEL,
    DEFAULT_HERMES_MOA_PRESET,
} from '@hapi/protocol'
import { buildCliArgs, createRunnerResumeProfileFingerprint } from './run'

describe('buildCliArgs', () => {
    it('keeps a fresh implicit default profile identical to its persisted resume profile', () => {
        const fresh = createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project'
        })
        const resumed = createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project',
            resumeSessionId: 'native-1',
            permissionMode: 'default'
        })

        expect(resumed).toBe(fresh)
    })

    it('canonicalizes default and explicit provider efforts across launch args and resume identity', () => {
        const omittedCodexArgs = buildCliArgs('codex', { directory: '/tmp/project' })
        const defaultCodexArgs = buildCliArgs('codex', {
            directory: '/tmp/project',
            modelReasoningEffort: ' default ',
        })
        expect(omittedCodexArgs).not.toContain('--model-reasoning-effort')
        expect(defaultCodexArgs).not.toContain('--model-reasoning-effort')
        expect(createRunnerResumeProfileFingerprint('codex', '/tmp/project', {
            directory: '/tmp/project',
        })).toBe(createRunnerResumeProfileFingerprint('codex', '/tmp/project', {
            directory: '/tmp/project',
            modelReasoningEffort: ' default ',
        }))

        const explicitCodexArgs = buildCliArgs('codex', {
            directory: '/tmp/project',
            modelReasoningEffort: ' high ',
        })
        expect(explicitCodexArgs).toEqual(expect.arrayContaining([
            '--model-reasoning-effort', 'high',
        ]))
        expect(createRunnerResumeProfileFingerprint('codex', '/tmp/project', {
            directory: '/tmp/project',
            modelReasoningEffort: 'high',
        })).not.toBe(createRunnerResumeProfileFingerprint('codex', '/tmp/project', {
            directory: '/tmp/project',
        }))

        expect(createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project',
        })).toBe(createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project',
            effort: ' auto ',
        }))
        expect(createRunnerResumeProfileFingerprint('grok', '/tmp/project', {
            directory: '/tmp/project',
        })).toBe(createRunnerResumeProfileFingerprint('grok', '/tmp/project', {
            directory: '/tmp/project',
            effort: ' auto ',
        }))
        expect(createRunnerResumeProfileFingerprint('grok', '/tmp/project', {
            directory: '/tmp/project',
            effort: 'low',
        })).not.toBe(createRunnerResumeProfileFingerprint('grok', '/tmp/project', {
            directory: '/tmp/project',
            effort: 'high',
        }))

        expect(buildCliArgs('grok', {
            directory: '/tmp/project',
            permissionMode: ' safe-yolo ',
        })).toEqual(expect.arrayContaining(['--permission-mode', 'safe-yolo']))
    })

    it('normalizes legacy yolo and selected DeepSeek values to persisted runtime values', () => {
        const freshYolo = createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project'
        }, true)
        const resumedYolo = createRunnerResumeProfileFingerprint('claude', '/tmp/project', {
            directory: '/tmp/project', permissionMode: 'bypassPermissions'
        })
        expect(resumedYolo).toBe(freshYolo)

        const freshDeepSeek = createRunnerResumeProfileFingerprint('claude-deepseek', '/tmp/project', {
            directory: '/tmp/project', model: 'deepseek-v4-flash', effort: 'high'
        })
        const resumedDeepSeek = createRunnerResumeProfileFingerprint('claude-deepseek', '/tmp/project', {
            directory: '/tmp/project', model: 'deepseek-v4-flash', effort: 'high', permissionMode: 'default'
        })
        expect(resumedDeepSeek).toBe(freshDeepSeek)
        expect(createRunnerResumeProfileFingerprint('claude-deepseek', '/tmp/project', {
            directory: '/tmp/project', model: 'deepseek-v4-pro[1m]', effort: 'max'
        })).not.toBe(freshDeepSeek)
    })

    it('materializes concrete omitted model defaults for launch and resume identity', () => {
        const cases = [
            ['claude-deepseek', DEFAULT_CLAUDE_DEEPSEEK_MODEL],
            ['claude-ark', DEFAULT_ARK_MODEL],
            ['cc-api', DEFAULT_CC_API_MODEL],
            ['agy', DEFAULT_AGY_MODEL],
            ['hermes-moa', DEFAULT_HERMES_MOA_PRESET],
        ] as const

        for (const [agent, defaultModel] of cases) {
            const args = buildCliArgs(agent, { directory: '/tmp/project' })
            expect(args, agent).toContain('--model')
            expect(args, agent).toContain(defaultModel)

            const implicit = createRunnerResumeProfileFingerprint(agent, '/tmp/project', {
                directory: '/tmp/project',
            })
            const persisted = createRunnerResumeProfileFingerprint(agent, '/tmp/project', {
                directory: '/tmp/project',
                model: defaultModel,
                permissionMode: 'default',
            })
            expect(implicit, agent).toBe(persisted)
        }
    })

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
        const args = buildCliArgs('agy', {
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

    it('routes claude-deepseek through Claude with the selected model and official effort', () => {
        const args = buildCliArgs('claude-deepseek', {
            directory: '/tmp',
            model: 'deepseek-v4-flash',
            effort: 'high',
        })

        expect(args[0]).toBe('claude')
        expect(args).toContain('--hapi-agent')
        expect(args).toContain('claude-deepseek')
        expect(args).toContain('--model')
        expect(args).toContain('deepseek-v4-flash')
        expect(args).toContain('--effort')
        expect(args).toContain('high')
    })

    it('routes claude-ark through Claude while preserving model and selected effort', () => {
        const args = buildCliArgs('claude-ark', {
            directory: '/tmp',
            model: 'doubao-seed-2.0-code',
            effort: 'high',
        })

        expect(args[0]).toBe('claude')
        expect(args).toContain('--hapi-agent')
        expect(args).toContain('claude-ark')
        expect(args).toContain('--model')
        expect(args).toContain('doubao-seed-2.0-code')
        expect(args).toContain('--effort')
        expect(args).toContain('high')
        expect(args).not.toContain('max')
    })


    it('routes cc-api through Claude while preserving model and selected effort', () => {
        const args = buildCliArgs('cc-api', {
            directory: '/tmp',
            model: 'glm-5.2[1m]',
            effort: 'max',
        })

        expect(args[0]).toBe('claude')
        expect(args).toContain('--hapi-agent')
        expect(args).toContain('cc-api')
        expect(args).toContain('--model')
        expect(args).toContain('glm-5.2[1m]')
        expect(args).toContain('--effort')
        expect(args).toContain('max')
    })

    it('omits invalid cc-api effort/model combinations from runner args', () => {
        const args = buildCliArgs('cc-api', {
            directory: '/tmp',
            model: 'kimi-k2.7-code',
            effort: 'high',
        })

        expect(args).toContain('--model')
        expect(args).toContain('kimi-k2.7-code')
        expect(args).not.toContain('--effort')
        expect(args).not.toContain('high')
    })

    it('passes through persisted effort for an unlisted cc-api model only on resume', () => {
        const freshArgs = buildCliArgs('cc-api', {
            directory: '/tmp',
            model: 'custom-cc-api-model',
            effort: 'high',
        })
        const resumeArgs = buildCliArgs('cc-api', {
            directory: '/tmp',
            resumeSessionId: 'custom-session-1',
            model: 'custom-cc-api-model',
            effort: 'high',
        })

        expect(freshArgs).not.toContain('--effort')
        expect(resumeArgs).toEqual(expect.arrayContaining([
            '--resume', 'custom-session-1',
            '--model', 'custom-cc-api-model',
            '--effort', 'high',
        ]))
    })

    it('adds --service-tier for Codex sessions only', () => {
        const codexArgs = buildCliArgs('codex', {
            directory: '/tmp',
            serviceTier: 'fast'
        })
        expect(codexArgs).toContain('--service-tier')
        expect(codexArgs).toContain('fast')

        const claudeArgs = buildCliArgs('claude', {
            directory: '/tmp',
            serviceTier: 'fast'
        })
        expect(claudeArgs).not.toContain('--service-tier')
        expect(claudeArgs).not.toContain('fast')
    })

    it('routes hermes-moa through its own command with model and permission mode but no Claude effort', () => {
        const args = buildCliArgs('hermes-moa', {
            directory: '/tmp',
            model: 'gpt-5.6-sol-max',
            effort: 'max',
            permissionMode: 'yolo',
            resumeSessionId: '20260707_010203_abcd',
        })

        expect(args[0]).toBe('hermes-moa')
        expect(args).toContain('--resume')
        expect(args).toContain('20260707_010203_abcd')
        expect(args).toContain('--model')
        expect(args).toContain('gpt-5.6-sol-max')
        expect(args).toContain('--permission-mode')
        expect(args).toContain('yolo')
        expect(args).not.toContain('claude')
        expect(args).not.toContain('--hapi-agent')
        expect(args).not.toContain('--effort')
        expect(args).not.toContain('max')
    })

    it('appends exact internal ownership arguments for managed launches', () => {
        const args = buildCliArgs('codex', { directory: '/tmp' }, false, {
            launchNonce: 'launch-123',
            runnerInstanceId: 'runner-456'
        })

        expect(args.slice(-4)).toEqual([
            '--hapi-launch-nonce', 'launch-123',
            '--hapi-runner-instance', 'runner-456'
        ])
    })

    it('routes only the explicit test contract to the deterministic integration fixture', () => {
        const fixtureArgs = buildCliArgs('claude', { directory: '/tmp' }, false, {
            launchNonce: 'launch-123',
            runnerInstanceId: 'runner-456'
        }, {
            NODE_ENV: 'test',
            HAPI_RUNNER_INTEGRATION_FIXTURE: '1'
        })

        expect(fixtureArgs).toEqual([
            'runner',
            'integration-fixture-agent',
            '--hapi-launch-nonce', 'launch-123',
            '--hapi-runner-instance', 'runner-456'
        ])

        expect(buildCliArgs('claude', { directory: '/tmp' }, false, undefined, {
            NODE_ENV: 'production',
            HAPI_RUNNER_INTEGRATION_FIXTURE: '1'
        })[0]).toBe('claude')
        expect(buildCliArgs('claude', { directory: '/tmp' }, false, undefined, {
            NODE_ENV: 'test'
        })[0]).toBe('claude')
    })

    it('routes grok through its own command with native resume, model and effort', () => {
        const args = buildCliArgs('grok', {
            directory: '/tmp', resumeSessionId: 'grok-session', model: 'grok-4.5', effort: 'high', permissionMode: 'safe-yolo'
        })
        expect(args[0]).toBe('grok')
        expect(args).toEqual(expect.arrayContaining(['--resume', 'grok-session', '--model', 'grok-4.5', '--effort', 'high', '--permission-mode', 'safe-yolo']))
    })

})
