import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSelection } from '@/ui/selectAgent'
import type { CommandContext } from './types'

const { getCliArgsMock, resolveCommandMock, selectAgentMock, ensureLoopbackProxyBypassMock, isBunCompiledMock, ensureRuntimeAssetsMock, runMock } = vi.hoisted(() => ({
    getCliArgsMock: vi.fn<() => string[]>(),
    resolveCommandMock: vi.fn(),
    selectAgentMock: vi.fn<() => Promise<AgentSelection>>(),
    ensureLoopbackProxyBypassMock: vi.fn(),
    isBunCompiledMock: vi.fn(() => false),
    ensureRuntimeAssetsMock: vi.fn(async () => {}),
    runMock: vi.fn<(_: CommandContext) => Promise<void>>(async () => {})
}))

vi.mock('@/utils/cliArgs', () => ({ getCliArgs: getCliArgsMock }))
vi.mock('./registry', () => ({ resolveCommand: resolveCommandMock }))
vi.mock('@/ui/selectAgent', () => ({ selectAgent: selectAgentMock }))
vi.mock('@/runtime/assets', () => ({ ensureRuntimeAssets: ensureRuntimeAssetsMock }))
vi.mock('@/projectPath', () => ({ isBunCompiled: isBunCompiledMock }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))
vi.mock('@/utils/proxyEnv', () => ({ ensureLoopbackProxyBypass: ensureLoopbackProxyBypassMock }))

import { runCli } from './runCli'

describe('CLI entrypoint', () => {
    const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const originalExitCode = process.exitCode

    beforeEach(() => {
        vi.clearAllMocks()
        process.exitCode = undefined
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        resolveCommandMock.mockImplementation(async (args: string[]) => ({
            command: { name: args[0], requiresRuntimeAssets: args[0] !== 'pi', run: runMock },
            context: { args, subcommand: args[0], commandArgs: args.slice(1) }
        }))
    })

    afterEach(() => {
        for (const [stream, descriptor] of [
            [process.stdin, originalStdinTTY], [process.stdout, originalStdoutTTY]
        ] as const) {
            if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor)
            else Reflect.deleteProperty(stream, 'isTTY')
        }
        process.exitCode = originalExitCode
        vi.restoreAllMocks()
    })

    it.each(['--help', '-h', 'help', '--version', '-v'])('handles top-level %s without session initialization', async (arg) => {
        getCliArgsMock.mockReturnValue([arg])
        await runCli()

        const output = vi.mocked(console.log).mock.calls.flat().join('\n')
        expect(output).toContain(arg === '-v' || arg === '--version' ? 'hapi version:' : 'HAPI - Coding agents')
        expect(output).not.toContain('Claude Code Options')
        expect(resolveCommandMock).not.toHaveBeenCalled()
        expect(selectAgentMock).not.toHaveBeenCalled()
        expect(ensureRuntimeAssetsMock).not.toHaveBeenCalled()
        expect(runMock).not.toHaveBeenCalled()
    })

    it.each(['claude', 'codex', 'pi'] as const)('dispatches a selected %s exactly like an explicit command', async (agent) => {
        getCliArgsMock.mockReturnValue([])
        selectAgentMock.mockResolvedValue({ type: 'selected', agent })
        await runCli()

        expect(runMock).toHaveBeenCalledWith({ args: [agent], subcommand: agent, commandArgs: [] })
        expect(selectAgentMock).toHaveBeenCalledOnce()
        if (agent === 'pi') expect(ensureRuntimeAssetsMock).not.toHaveBeenCalled()
        else expect(ensureRuntimeAssetsMock).toHaveBeenCalledOnce()
    })

    it.each(['--help', '-h', '--version', '-v'])('leaves agent %s arguments to the adapter', async (flag) => {
        const args = ['codex', flag, '--', '--help', 'a prompt']
        getCliArgsMock.mockReturnValue(args)
        await runCli()

        expect(runMock).toHaveBeenCalledWith({ args, subcommand: 'codex', commandArgs: args.slice(1) })
        expect(selectAgentMock).not.toHaveBeenCalled()
        expect(console.log).not.toHaveBeenCalled()
    })

    it('finishes loading the command before preparing its runtime and running it', async () => {
        const order: string[] = []
        const originalDev = process.env.DEV
        const args = ['codex']
        getCliArgsMock.mockReturnValue(args)
        process.env.DEV = 'true'
        resolveCommandMock.mockImplementationOnce(async () => {
            await Promise.resolve()
            expect(process.env.DEV).toBe('true')
            order.push('command')
            return {
                command: { name: 'codex', requiresRuntimeAssets: true, run: runMock },
                context: { args, subcommand: 'codex', commandArgs: [] }
            }
        })
        ensureLoopbackProxyBypassMock.mockImplementationOnce(() => { order.push('proxy') })
        isBunCompiledMock.mockImplementationOnce(() => {
            order.push('compiled')
            return true
        })
        ensureRuntimeAssetsMock.mockImplementationOnce(async () => {
            expect(process.env.DEV).toBe('false')
            order.push('assets')
        })
        runMock.mockImplementationOnce(async () => { order.push('run') })

        try {
            await runCli()
            expect(order).toEqual(['command', 'proxy', 'compiled', 'assets', 'run'])
        } finally {
            if (originalDev === undefined) delete process.env.DEV
            else process.env.DEV = originalDev
            resolveCommandMock.mockReset()
            ensureLoopbackProxyBypassMock.mockReset()
            isBunCompiledMock.mockReset()
            ensureRuntimeAssetsMock.mockReset()
            runMock.mockReset()
        }
    })

    it.each(['unknown', '--yolo', '--resume', 'a prompt'])('rejects %s instead of starting Claude', async (arg) => {
        getCliArgsMock.mockReturnValue([arg])
        resolveCommandMock.mockResolvedValue(null)
        await runCli()

        expect(process.exitCode).toBe(1)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('hapi <agent>'))
        expect(selectAgentMock).not.toHaveBeenCalled()
        expect(runMock).not.toHaveBeenCalled()
        expect(ensureRuntimeAssetsMock).not.toHaveBeenCalled()
    })

    it.each([[false, false], [true, false], [false, true]])('requires TTY input and output (%s, %s)', async (stdinTTY, stdoutTTY) => {
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY })
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY })
        getCliArgsMock.mockReturnValue([])
        await runCli()

        expect(process.exitCode).toBe(1)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('interactive terminal'))
        expect(selectAgentMock).not.toHaveBeenCalled()
        expect(resolveCommandMock).not.toHaveBeenCalled()
    })

    it.each([0, 1, 130] as const)('propagates picker exit code %s without starting a session', async (exitCode) => {
        getCliArgsMock.mockReturnValue([])
        selectAgentMock.mockResolvedValue({ type: 'exit', exitCode })
        await runCli()

        expect(process.exitCode).toBe(exitCode)
        expect(resolveCommandMock).not.toHaveBeenCalled()
        expect(ensureRuntimeAssetsMock).not.toHaveBeenCalled()
        expect(runMock).not.toHaveBeenCalled()
    })
})
