import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableCandidates, getAgentLaunchCommand, resolveExecutable } from './agentLaunchCommand'
import { getAgentAvailability } from './agentAvailability'

async function makeExecutable(directory: string, name: string): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
}

describe('agent executable resolution', () => {
    it('resolves commands from PATH and absolute environment overrides', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const copilot = await makeExecutable(directory, 'copilot-custom')

        expect(resolveExecutable('copilot-custom', { pathValue: directory })).toBe(copilot)
        expect(getAgentLaunchCommand('copilot', { COPILOT_CLI_PATH: copilot })).toBe(copilot)
        expect(getAgentAvailability('copilot', {
            COPILOT_CLI_PATH: copilot,
            PATH: directory,
        })).toEqual({ agent: 'copilot', available: true })
    })

    it('uses PATHEXT when resolving Windows commands', () => {
        expect(executableCandidates('agent', {
            platform: 'win32',
            pathValue: 'C:\\Tools;D:\\Bin',
            pathExt: '.EXE;.CMD',
        })).toEqual([
            'C:\\Tools\\agent.EXE',
            'C:\\Tools\\agent.CMD',
            'D:\\Bin\\agent.EXE',
            'D:\\Bin\\agent.CMD',
        ])
    })

    it('reports missing executables without invoking them', () => {
        expect(getAgentAvailability('grok', { PATH: '' })).toEqual({
            agent: 'grok',
            available: false,
            reason: 'not_found',
        })
        expect(getAgentAvailability('claude', { PATH: '' })).toEqual({
            agent: 'claude',
            available: false,
            reason: 'not_found',
        })
        expect(getAgentAvailability('codex', {
            PATH: '',
            HAPI_CODEX_APP_SERVER_BIN: '/missing/codex',
        })).toEqual({
            agent: 'codex',
            available: false,
            reason: 'invalid_configuration',
        })
    })

    it('uses the configured Codex app-server executable for availability', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const codex = await makeExecutable(directory, 'codex-app-server')

        expect(getAgentAvailability('codex', {
            PATH: '',
            HAPI_CODEX_APP_SERVER_BIN: codex,
        })).toEqual({ agent: 'codex', available: true })
    })

    it('rejects malformed or missing DSH static configuration', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        await makeExecutable(directory, 'dsh-acp-demo')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_ARGS_JSON: 'not json',
        }).reason).toBe('invalid_configuration')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_CONFIG: join(directory, 'missing.yml'),
        }).reason).toBe('invalid_configuration')

        const config = join(directory, 'cordis.yml')
        await writeFile(config, 'agents: []\n')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_CONFIG: config,
        })).toEqual({ agent: 'dsh', available: true })
    })

    it('accepts a macOS Codex app executable when the CLI is absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const appCommand = join(directory, 'Codex.app', 'Contents', 'Resources', 'codex')
        await mkdir(join(directory, 'Codex.app', 'Contents', 'Resources'), { recursive: true })
        await writeFile(appCommand, '#!/bin/sh\n')
        await chmod(appCommand, 0o755)

        expect(resolveExecutable(appCommand, { pathValue: '' })).toBe(appCommand)
    })
})
