import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { mkdtemp, mkdir, writeFile, lstat } from 'fs/promises'
import { tmpdir } from 'os'
import {
    ensureManagedCodexHome,
    getRunnerBaseEnv,
    getSanitizedRunnerChildEnv,
    getManagedCodexBootstrapEntryNames,
    getManagedCodexHome,
    getRunnerAgentEnv
} from './providerRuntime'

describe('managed Codex home env', () => {
    it('uses HAPI_CODEX_HOME override for managed Codex sessions', () => {
        const env = getRunnerAgentEnv('codex', {
            HAPI_HOME: '/tmp/hapi-home',
            HAPI_CODEX_HOME: '/tmp/custom-codex-home',
        })

        expect(env).toEqual({ CODEX_HOME: '/tmp/custom-codex-home' })
    })

    it('defaults managed Codex sessions to HAPI_HOME/codex-home', () => {
        expect(getManagedCodexHome({ HAPI_HOME: '/tmp/hapi-home' })).toBe(join('/tmp/hapi-home', 'codex-home'))
        expect(getRunnerAgentEnv('codex', { HAPI_HOME: '/tmp/hapi-home' })).toEqual({
            CODEX_HOME: join('/tmp/hapi-home', 'codex-home'),
        })
    })

    it('falls back to HOME/.hapi/codex-home when HAPI_HOME is not set', () => {
        expect(getManagedCodexHome({ HOME: '/Users/example' })).toBe(join('/Users/example', '.hapi', 'codex-home'))
        expect(getRunnerAgentEnv('codex', { HOME: '/Users/example' })).toEqual({
            CODEX_HOME: join('/Users/example', '.hapi', 'codex-home'),
        })
    })

    it('does not inject CODEX_HOME for non-Codex agents', () => {
        expect(getRunnerAgentEnv('claude', { HAPI_HOME: '/tmp/hapi-home' })).toEqual({})
        expect(getRunnerAgentEnv('agy', { HAPI_HOME: '/tmp/hapi-home' })).toEqual({})
        expect(getRunnerAgentEnv(undefined, { HAPI_HOME: '/tmp/hapi-home' })).toEqual({})
    })

    it('re-applies explicit Claude and Cursor executable overrides to launch env', () => {
        expect(getRunnerAgentEnv('claude', {
            HAPI_CLAUDE_PATH: '/opt/providers/claude-custom',
        })).toEqual({ HAPI_CLAUDE_PATH: '/opt/providers/claude-custom' })
        expect(getRunnerAgentEnv('cursor', {
            HAPI_CURSOR_PATH: '/opt/providers/cursor-custom',
        })).toEqual({ HAPI_CURSOR_PATH: '/opt/providers/cursor-custom' })
        expect(getRunnerAgentEnv('claude', {})).toEqual({})
        expect(getRunnerAgentEnv('cursor', {})).toEqual({})
    })

    it('injects the local claude-deepseek wrapper only for claude-deepseek sessions', () => {
        expect(getRunnerAgentEnv('claude-deepseek', { HOME: '/Users/example' })).toEqual({
            HAPI_CLAUDE_PATH: '/Users/example/.local/bin/claude-deepseek',
        })
        expect(getRunnerAgentEnv('claude', { HOME: '/Users/example' })).not.toHaveProperty('HAPI_CLAUDE_PATH')
        expect(getRunnerAgentEnv('codex', { HOME: '/Users/example', HAPI_HOME: '/tmp/hapi-home' })).not.toHaveProperty('HAPI_CLAUDE_PATH')
    })

    it('injects the local claude-ark wrapper only for claude-ark sessions', () => {
        expect(getRunnerAgentEnv('claude-ark', { HOME: '/Users/example' })).toEqual({
            HAPI_CLAUDE_PATH: '/Users/example/.local/bin/claude-ark',
        })
        expect(getRunnerAgentEnv('claude-ark', {
            HOME: '/Users/example',
            HAPI_CLAUDE_ARK_PATH: '/opt/hapi/claude-ark',
        })).toEqual({
            HAPI_CLAUDE_PATH: '/opt/hapi/claude-ark',
        })
        expect(getRunnerAgentEnv('claude', { HOME: '/Users/example' })).not.toHaveProperty('HAPI_CLAUDE_PATH')
        expect(getRunnerAgentEnv('claude-deepseek', { HOME: '/Users/example' })).toEqual({
            HAPI_CLAUDE_PATH: '/Users/example/.local/bin/claude-deepseek',
        })
    })


    it('injects the local claude-api wrapper only for cc-api sessions', () => {
        expect(getRunnerAgentEnv('cc-api', { HOME: '/Users/example' })).toEqual({
            HAPI_CLAUDE_PATH: '/Users/example/.local/bin/claude-api',
        })
        expect(getRunnerAgentEnv('cc-api', {
            HOME: '/Users/example',
            HAPI_CLAUDE_API_PATH: '/opt/hapi/claude-api',
        })).toEqual({
            HAPI_CLAUDE_PATH: '/opt/hapi/claude-api',
        })
        expect(getRunnerAgentEnv('claude', { HOME: '/Users/example' })).not.toHaveProperty('HAPI_CLAUDE_PATH')
        expect(getRunnerAgentEnv('claude-ark', { HOME: '/Users/example' })).toEqual({
            HAPI_CLAUDE_PATH: '/Users/example/.local/bin/claude-ark',
        })
    })

    it('injects the local Hermes wrapper only for Hermes MoA sessions', () => {
        expect(getRunnerAgentEnv('hermes-moa', { HOME: '/Users/example' })).toEqual({
            HAPI_HERMES_PATH: '/Users/example/.local/bin/hermes',
        })
        expect(getRunnerAgentEnv('hermes-moa', {
            HOME: '/Users/example',
            HAPI_HERMES_PATH: '/opt/hapi/hermes',
        })).toEqual({
            HAPI_HERMES_PATH: '/opt/hapi/hermes',
        })
        expect(getRunnerAgentEnv('claude', { HOME: '/Users/example' })).not.toHaveProperty('HAPI_HERMES_PATH')
    })

    it('prepends ~/.local/bin to runner-spawned agent PATH for every agent family', () => {
        expect(getRunnerBaseEnv({ HOME: '/Users/example', PATH: '/usr/bin:/bin' })).toEqual({
            PATH: '/Users/example/.local/bin:/usr/bin:/bin',
        })

        expect(getRunnerBaseEnv({ HOME: '/Users/example', PATH: '/usr/bin:/Users/example/.local/bin:/bin' })).toEqual({
            PATH: '/usr/bin:/Users/example/.local/bin:/bin',
        })
    })

    it('removes cross-provider credentials and stale managed-run metadata from child environments', () => {
        const env = {
            HOME: '/Users/example', PATH: '/usr/bin',
            OPENAI_API_KEY: 'openai-secret', CODEX_HOME: '/old/codex',
            ANTHROPIC_API_KEY: 'anthropic-secret', GOOGLE_API_KEY: 'google-secret',
            CLAUDE_SESSION: 'claude-selector', AGY_PROFILE: 'agy-profile', GROK_TOKEN: 'grok-secret',
            GEMINI_API_KEY: 'gemini-secret', ANTIGRAVITY_API_KEY: 'antigravity-secret',
            ARK_API_KEY: 'ark-secret', VOLCENGINE_TOKEN: 'volc-secret', HERMES_TOKEN: 'hermes-secret',
            HAPI_CLAUDE_PATH: '/stale/claude', HAPI_HERMES_PATH: '/stale/hermes', HAPI_CODEX_HOME: '/stale/codex',
            HAPI_LAUNCH_NONCE: 'stale', HAPI_RUNNER_INSTANCE_ID: 'stale-runner',
            HAPI_MANAGED_OUTCOME_FD: '9', HAPI_RESUME_PROFILE_FINGERPRINT: 'stale-profile',
            HAPI_EXPECTED_NATIVE_RESUME_ID: 'stale-native-id'
        }

        expect(getSanitizedRunnerChildEnv('claude', env)).toEqual({
            HOME: '/Users/example', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'anthropic-secret', CLAUDE_SESSION: 'claude-selector'
        })
        expect(getSanitizedRunnerChildEnv('codex', env)).toEqual({
            HOME: '/Users/example', PATH: '/usr/bin', OPENAI_API_KEY: 'openai-secret', CODEX_HOME: '/old/codex'
        })
        expect(getSanitizedRunnerChildEnv('grok', env)).toEqual({
            HOME: '/Users/example', PATH: '/usr/bin', GROK_TOKEN: 'grok-secret'
        })
    })

    it('bootstraps only non-history Codex resources into the managed home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-codex-home-test-'))
        const fakeHome = join(root, 'home')
        const defaultCodexHome = join(fakeHome, '.codex')
        const hapiHome = join(root, 'hapi')
        await mkdir(defaultCodexHome, { recursive: true })
        await writeFile(join(defaultCodexHome, 'auth.json'), '{}')
        await writeFile(join(defaultCodexHome, 'config.toml'), 'model = "gpt-5.5"')
        await mkdir(join(defaultCodexHome, 'plugins'), { recursive: true })
        await mkdir(join(defaultCodexHome, 'sessions'), { recursive: true })
        await writeFile(join(defaultCodexHome, 'state_5.sqlite'), '')
        await writeFile(join(defaultCodexHome, 'session_index.jsonl'), '')

        const managedHome = await ensureManagedCodexHome({ HOME: fakeHome, HAPI_HOME: hapiHome })

        expect(managedHome).toBe(join(hapiHome, 'codex-home'))
        expect((await lstat(join(managedHome, 'auth.json'))).isSymbolicLink()).toBe(true)
        expect((await lstat(join(managedHome, 'config.toml'))).isSymbolicLink()).toBe(true)
        expect((await lstat(join(managedHome, 'plugins'))).isSymbolicLink()).toBe(true)
        await expect(lstat(join(managedHome, 'sessions'))).rejects.toThrow()
        await expect(lstat(join(managedHome, 'state_5.sqlite'))).rejects.toThrow()
        await expect(lstat(join(managedHome, 'session_index.jsonl'))).rejects.toThrow()
    })

    it('allows concurrent managed-home bootstrap attempts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-codex-home-concurrent-test-'))
        const fakeHome = join(root, 'home')
        const defaultCodexHome = join(fakeHome, '.codex')
        const hapiHome = join(root, 'hapi')
        await mkdir(defaultCodexHome, { recursive: true })
        await writeFile(join(defaultCodexHome, 'auth.json'), '{}')
        await writeFile(join(defaultCodexHome, 'config.toml'), 'model = "gpt-5.5"')

        const [first, second] = await Promise.all([
            ensureManagedCodexHome({ HOME: fakeHome, HAPI_HOME: hapiHome }),
            ensureManagedCodexHome({ HOME: fakeHome, HAPI_HOME: hapiHome }),
        ])

        expect(first).toBe(second)
        expect((await lstat(join(first, 'auth.json'))).isSymbolicLink()).toBe(true)
        expect((await lstat(join(first, 'config.toml'))).isSymbolicLink()).toBe(true)
    })

    it('keeps history-like Codex entries out of the bootstrap allowlist', () => {
        const entries = getManagedCodexBootstrapEntryNames()
        expect(entries).not.toContain('sessions')
        expect(entries).not.toContain('archived_sessions')
        expect(entries).not.toContain('state_5.sqlite')
        expect(entries).not.toContain('session_index.jsonl')
        expect(entries).not.toContain('history.jsonl')
    })
})
