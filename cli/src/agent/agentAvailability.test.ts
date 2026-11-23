import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as codexExecutable from '@/codex/utils/codexExecutable'
import { executableCandidates, getAgentLaunchCommand, parseNodeShimScript, resolveExecutable, resolveNodeCliLaunch } from './agentLaunchCommand'
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

    it('reads the script an npm Windows shim runs', () => {
        const npmShim = [
            '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
            'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
            '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
            'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
        ].join('\r\n')
        expect(parseNodeShimScript('C:\\Users\\Han Feng\\AppData\\Roaming\\npm\\pi.cmd', npmShim))
            .toBe('C:\\Users\\Han Feng\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js')
    })

    it('reads the script a pnpm Windows shim runs', () => {
        const pnpmShim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\pi\\dist\\cli.mjs" %*\r\n) ELSE (\r\n  node  "%~dp0\\global\\5\\node_modules\\pi\\dist\\cli.mjs" %*\r\n)'
        expect(parseNodeShimScript('D:\\pnpm\\pi.cmd', pnpmShim)).toBe('D:\\pnpm\\global\\5\\node_modules\\pi\\dist\\cli.mjs')
    })

    it('reads an absolute script a pnpm shim on another drive runs', () => {
        const shim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "E:\\pnpm-store\\pi\\dist\\cli.js" %*\r\n)'
        expect(parseNodeShimScript('C:\\pnpm\\pi.cmd', shim)).toBe('E:\\pnpm-store\\pi\\dist\\cli.js')
        expect(parseNodeShimScript('C:\\pnpm\\pi.cmd', '"node" "pi\\cli.js" %*')).toBeNull()
    })

    it('rejects a shim that does not run a node script', () => {
        expect(parseNodeShimScript('C:\\bin\\pi.cmd', '@echo off\r\n"%~dp0\\pi.exe" %*')).toBeNull()
    })

    it('leaves command lookup to spawn on POSIX', () => {
        expect(resolveNodeCliLaunch('pi', { PATH: '' }, 'linux')).toEqual({ command: 'pi', args: [] })
    })

    it('unquotes quoted Windows PATH entries', () => {
        expect(executableCandidates('pi', {
            platform: 'win32',
            pathValue: '"C:\\Program Files\\npm";""',
            pathExt: '.CMD',
        })).toEqual(['C:\\Program Files\\npm\\pi.CMD'])
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

    it('checks the terminal Codex executable independently of the runner override', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const codex = await makeExecutable(directory, 'codex')
        const resolveSpy = vi.spyOn(codexExecutable, 'resolveCodexCommand')
        try {
            resolveSpy.mockReturnValue({ command: codex, args: [] })
            expect(getAgentAvailability('codex', {
                PATH: '', HAPI_CODEX_APP_SERVER_BIN: '/missing/app-server'
            }, 'terminal')).toEqual({ agent: 'codex', available: true })

            resolveSpy.mockReturnValue({ command: join(directory, 'missing-codex'), args: [] })
            expect(getAgentAvailability('codex', {
                PATH: '', HAPI_CODEX_APP_SERVER_BIN: codex
            }, 'terminal')).toEqual({ agent: 'codex', available: false, reason: 'not_found' })
        } finally {
            resolveSpy.mockRestore()
        }
    })

    it('rejects malformed or missing DSH static configuration', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        await makeExecutable(directory, 'dsh')
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
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_COMMAND: 'dsh-acp-demo',
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
