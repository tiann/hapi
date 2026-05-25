import { describe, expect, it } from 'vitest'
import { mergePathValue, resolveRunnerPluginSpawnOptions, resolveRunnerPluginSpawnPlan } from './runnerExtensionPipeline'

describe('runner plugin extension pipeline', () => {
    const baseInput = {
        machineId: 'runner-1',
        agent: 'codex',
        options: { directory: '/repo', agent: 'codex' as const },
        basePlan: {
            command: '/opt/hapi/current',
            args: ['codex', '--hapi-starting-mode', 'remote', '--started-by', 'runner'],
            displayArgs: ['codex', '--hapi-starting-mode', 'remote', '--started-by', 'runner'],
            mode: 'compiled' as const,
            cwd: '/repo',
            env: { PATH: '/usr/bin', SECRET_TOKEN: 'secret', HAPI_INVOKED_CWD: '/repo' }
        },
        timeoutMs: 20,
        pathDelimiter: ':'
    }

    it('strips control-only machineId from spawn options before strict schema validation', async () => {
        const result = await resolveRunnerPluginSpawnOptions({
            machineId: 'runner-1',
            agent: 'codex',
            cwd: '/repo',
            options: {
                directory: '/repo',
                machineId: 'client-supplied-runner'
            } as unknown as Parameters<typeof resolveRunnerPluginSpawnOptions>[0]['options'],
            spawnOptionsProviders: []
        })

        expect(result.options).toEqual({
            directory: '/repo',
            agent: 'codex'
        })
        expect('machineId' in result.options).toBe(false)
    })

    it('merges environment provider output without leaking secret values into diagnostics', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [{
                pluginId: 'com.example.env',
                id: 'env',
                priority: 0,
                order: 0,
                contribution: {
                    id: 'env',
                    provide: () => ({
                        env: { TOOL_HOME: '/opt/tool', HAPI_INVOKED_CWD: 'secret' },
                        pathPrepend: ['/opt/tool/bin']
                    })
                }
            }],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.env.TOOL_HOME).toBe('/opt/tool')
        expect(result.env.PATH).toBe('/opt/tool/bin:/usr/bin')
        expect(result.env.HAPI_INVOKED_CWD).toBe('/repo')
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret')
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-env-protected')
    })

    it('applies valid command resolver proposals and rejects invalid ones', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [],
            commandResolvers: [
                {
                    pluginId: 'com.example.bad',
                    id: 'bad',
                    priority: 0,
                    order: 0,
                    contribution: {
                        id: 'bad',
                        resolve: () => ({ args: ['plugins', 'list'] })
                    }
                },
                {
                    pluginId: 'com.example.good',
                    id: 'good',
                    priority: 10,
                    order: 1,
                    contribution: {
                        id: 'good',
                        resolve: () => ({ args: ['codex', '--model', 'gpt-5.5'] })
                    }
                }
            ],
            spawnHooks: []
        })

        expect(result.command).toBe('/opt/hapi/current')
        expect(result.displayArgs).toEqual(['codex', '--model', 'gpt-5.5', '--hapi-starting-mode', 'remote', '--started-by', 'runner'])
        expect(result.args).toEqual(['codex', '--model', 'gpt-5.5', '--hapi-starting-mode', 'remote', '--started-by', 'runner'])
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-command-disallowed')
    })

    it('preserves canonical Runner control flags when command resolvers try to override them', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [],
            commandResolvers: [{
                pluginId: 'com.example.cmd',
                id: 'cmd',
                priority: 0,
                order: 0,
                contribution: {
                    id: 'cmd',
                    resolve: () => ({ args: ['codex', '--started-by', 'terminal', '--hapi-starting-mode', 'local', '--model', 'gpt-5.5'] })
                }
            }],
            spawnHooks: []
        })

        expect(result.args).toEqual(['codex', '--model', 'gpt-5.5', '--hapi-starting-mode', 'remote', '--started-by', 'runner'])
        expect(result.displayArgs).toEqual(result.args)
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'runner-extension-command-control-preserved' })
        ]))
    })

    it('rewrites the display HAPI args tail in development mode while Core keeps the executable', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            basePlan: {
                command: '/usr/bin/bun',
                args: ['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex'],
                displayArgs: ['codex'],
                mode: 'development',
                cwd: '/repo',
                env: {}
            },
            environmentProviders: [],
            commandResolvers: [{
                pluginId: 'com.example.cmd',
                id: 'cmd',
                priority: 0,
                order: 0,
                contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'gpt-5.5'] }) }
            }],
            spawnHooks: []
        })

        expect(result.command).toBe('/usr/bin/bun')
        expect(result.args).toEqual(['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex', '--model', 'gpt-5.5'])
        expect(result.displayArgs).toEqual(['codex', '--model', 'gpt-5.5'])
    })

    it('uses the current display arg tail when multiple development-mode resolvers override args', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            basePlan: {
                command: '/usr/bin/bun',
                args: ['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex'],
                displayArgs: ['codex'],
                mode: 'development',
                cwd: '/repo',
                env: {}
            },
            environmentProviders: [],
            commandResolvers: [
                {
                    pluginId: 'com.example.first',
                    id: 'cmd',
                    priority: 0,
                    order: 0,
                    contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'a'] }) }
                },
                {
                    pluginId: 'com.example.second',
                    id: 'cmd',
                    priority: 1,
                    order: 1,
                    contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'b'] }) }
                }
            ],
            spawnHooks: []
        })

        expect(result.args).toEqual(['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex', '--model', 'b'])
        expect(result.displayArgs).toEqual(['codex', '--model', 'b'])
    })

    it('ignores cwd proposals outside the base spawn directory', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [{
                pluginId: 'com.example.cwd',
                id: 'cwd',
                priority: 0,
                order: 0,
                contribution: { id: 'cwd', provide: () => ({ cwd: '/etc' }) }
            }],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.cwd).toBe('/repo')
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'runner-extension-cwd-outside-workspace' })
        ]))
    })

    it('continues on throwing beforeSpawn hook unless hook explicitly blocks', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [],
            commandResolvers: [],
            spawnHooks: [
                {
                    pluginId: 'com.example.throw',
                    id: 'throw',
                    priority: 0,
                    order: 0,
                    contribution: {
                        id: 'throw',
                        beforeSpawn: () => { throw new Error('boom') }
                    }
                },
                {
                    pluginId: 'com.example.block',
                    id: 'block',
                    priority: 1,
                    order: 1,
                    contribution: {
                        id: 'block',
                        beforeSpawn: () => ({ block: { reason: 'policy' } })
                    }
                }
            ]
        })

        expect(result.blocked).toEqual({ reason: 'policy' })
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-before-spawn-failed')
    })

    it('uses deterministic priority for env conflicts', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [
                {
                    pluginId: 'com.example.high',
                    id: 'env',
                    priority: 10,
                    order: 0,
                    contribution: { id: 'env', provide: () => ({ env: { TOOL: 'high' } }) }
                },
                {
                    pluginId: 'com.example.low',
                    id: 'env',
                    priority: 0,
                    order: 1,
                    contribution: { id: 'env', provide: () => ({ env: { TOOL: 'low' } }) }
                }
            ],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.env.TOOL).toBe('high')
    })

    it('isolates timed out providers', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            timeoutMs: 5,
            environmentProviders: [{
                pluginId: 'com.example.slow',
                id: 'slow',
                priority: 0,
                order: 0,
                contribution: { id: 'slow', provide: () => new Promise(() => undefined) }
            }],
            commandResolvers: [],
            spawnHooks: []
        })
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-environment-failed')
    })

    it('sanitizes thrown provider errors and plugin diagnostics', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [
                {
                    pluginId: 'com.example.throw',
                    id: 'throw',
                    priority: 0,
                    order: 0,
                    contribution: { id: 'throw', provide: () => { throw new Error('boom secret-value') } }
                },
                {
                    pluginId: 'com.example.diag',
                    id: 'diag',
                    priority: 1,
                    order: 1,
                    contribution: {
                        id: 'diag',
                        provide: () => ({ diagnostics: [{ severity: 'warning', code: 'custom', message: 'custom secret-value' }] })
                    }
                }
            ],
            commandResolvers: [],
            spawnHooks: [],
            sanitizeDiagnostic: (_pluginId, value) => String(value instanceof Error ? value.message : value).replaceAll('secret-value', '[REDACTED]')
        })

        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'runner-extension-environment-failed', message: expect.stringContaining('[REDACTED]') }),
            expect.objectContaining({ code: 'custom', message: 'custom [REDACTED]' })
        ]))
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-value')
    })

    it('preserves Windows env casing and protects HAPI env keys case-insensitively', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            basePlan: {
                ...baseInput.basePlan,
                env: { Path: 'C:\\Windows', HAPI_INVOKED_CWD: 'C:\\repo', CODEX_HOME: 'C:\\codex' }
            },
            environmentProviders: [{
                pluginId: 'com.example.win',
                id: 'win',
                priority: 0,
                order: 0,
                contribution: {
                    id: 'win',
                    provide: () => ({
                        env: { codex_home: 'C:\\evil', hapi_invoked_cwd: 'C:\\evil', NORMAL: 'ok' },
                        pathPrepend: ['D:\\Tools']
                    })
                }
            }],
            commandResolvers: [],
            spawnHooks: [],
            pathDelimiter: ';',
            platform: 'win32'
        })

        expect(result.env.Path).toBe('D:\\Tools;C:\\Windows')
        expect(result.env.CODEX_HOME).toBe('C:\\codex')
        expect(result.env.HAPI_INVOKED_CWD).toBe('C:\\repo')
        expect(result.env.NORMAL).toBe('ok')
        expect(result.diagnostics.filter((entry) => entry.code === 'runner-extension-env-protected')).toHaveLength(2)
    })

    it('treats toolPaths as reserved instead of mutating env', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [{
                pluginId: 'com.example.tools',
                id: 'tools',
                priority: 0,
                order: 0,
                contribution: { id: 'tools', provide: () => ({ toolPaths: { git: '/custom/git' } }) }
            }],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.env.git).toBeUndefined()
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'runner-extension-tool-paths-reserved' })
        ]))
    })

    it('skips launch-option proposals for manual fields', async () => {
        const result = await resolveRunnerPluginSpawnOptions({
            machineId: 'runner-1',
            agent: 'codex',
            cwd: '/repo',
            options: {
                directory: '/repo',
                agent: 'codex',
                model: 'manual-model',
                permissionMode: 'default',
                yolo: false,
                manualFields: ['model', 'permissionMode']
            },
            spawnOptionsProviders: [{
                pluginId: 'com.example.defaults',
                id: 'defaults',
                priority: 0,
                order: 0,
                contribution: {
                    id: 'defaults',
                    provide: () => ({
                        options: {
                            model: 'plugin-model',
                            permissionMode: 'yolo',
                            yolo: true,
                            modelReasoningEffort: 'high'
                        },
                        applied: [{ label: 'Defaults' }]
                    })
                }
            }]
        })

        expect(result.options.model).toBe('manual-model')
        expect(result.options.permissionMode).toBe('default')
        expect(result.options.yolo).toBe(false)
        expect(result.options.modelReasoningEffort).toBe('high')
        expect(result.diagnostics.filter((entry) => entry.code === 'runner-extension-manual-field-skipped')).toHaveLength(3)
        expect(result.applied[0]?.fields).toEqual(['modelReasoningEffort'])
    })
})

describe('mergePathValue', () => {
    it('merges Linux and macOS PATH with colon delimiter', () => {
        expect(mergePathValue({ base: '/usr/bin:/bin', prepend: ['/opt/bin'], append: ['/custom/bin'], delimiter: ':' }))
            .toBe('/opt/bin:/usr/bin:/bin:/custom/bin')
    })

    it('merges Windows PATH with semicolon delimiter', () => {
        expect(mergePathValue({ base: 'C:\\Windows;C:\\Tools', prepend: ['D:\\Agent\\bin'], append: ['E:\\Extra'], delimiter: ';' }))
            .toBe('D:\\Agent\\bin;C:\\Windows;C:\\Tools;E:\\Extra')
    })
})
