import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
    settleDurableDelegate,
    spawnDurableUpgradeDelegate,
    waitForDelegatedRunner,
} from './runCli'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

describe('waitForDelegatedRunner', () => {
    it('rejects on asynchronous spawn error so the marker can be cleared', async () => {
        const child = new EventEmitter() as EventEmitter & ChildProcess
        const pending = waitForDelegatedRunner(child)
        queueMicrotask(() => {
            child.emit('error', new Error('ENOENT'))
        })
        await expect(pending).rejects.toThrow(/ENOENT/)
    })

    it('resolves with the exit code on clean exit', async () => {
        const child = new EventEmitter() as EventEmitter & ChildProcess
        const pending = waitForDelegatedRunner(child)
        queueMicrotask(() => {
            child.emit('exit', 7, null)
        })
        await expect(pending).resolves.toBe(7)
    })

    it('resolves immediately when the child has already exited', async () => {
        const child = Object.assign(new EventEmitter(), {
            exitCode: 0,
            signalCode: null,
        }) as EventEmitter & ChildProcess
        await expect(waitForDelegatedRunner(child)).resolves.toBe(0)
    })
})

describe('settleDurableDelegate', () => {
    it('clears the path when the child exits before hubReadyAt', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(async () => 1)
        const waitForReady = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20))
            return true
        })

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: false,
            waitForExit,
            waitForReady,
            killChild: vi.fn(async () => true),
            timeoutMs: 50,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: true })
    })

    it('does not hang forever when the child ignores SIGTERM after readiness timeout', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(
            () => new Promise<number>(() => {
                // never resolves — wedged target
            }),
        )
        const waitForReady = vi.fn(async () => false)
        const killChild = vi.fn(async () => true)

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: false,
            waitForExit,
            waitForReady,
            killChild,
            timeoutMs: 10,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: true })
        expect(killChild).toHaveBeenCalledWith(child, true)
    }, 10_000)

    it('refuses fallback when force-kill cannot stop the timed-out candidate', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(
            () => new Promise<number>(() => {
                // never resolves — wedged target
            }),
        )
        const waitForReady = vi.fn(async () => false)
        const killChild = vi.fn(async () => false)

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: false,
            waitForExit,
            waitForReady,
            killChild,
            timeoutMs: 10,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: false })
    }, 10_000)

    it('returns the exit code after readiness is confirmed', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        let resolveExit!: (code: number) => void
        const waitForExit = vi.fn(
            () => new Promise<number>((resolve) => {
                resolveExit = resolve
            }),
        )
        const waitForReady = vi.fn(async () => true)

        const pending = settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: false,
            waitForExit,
            waitForReady,
        })
        await Promise.resolve()
        resolveExit(0)
        await expect(pending).resolves.toEqual({ ready: true, exitCode: 0 })
        expect(child.kill).not.toHaveBeenCalled()
    })

    it('for detached runner start, waits for launcher exit then grandchild hubReadyAt', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(async () => 0)
        const waitForReady = vi.fn(async () => true)
        const killChild = vi.fn(async () => true)

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: true,
            detachedLauncher: true,
            waitForExit,
            waitForReady,
            killChild,
            timeoutMs: 50,
        })
        expect(settled).toEqual({ ready: true, exitCode: 0 })
        expect(waitForExit).toHaveBeenCalledTimes(1)
        expect(waitForReady).toHaveBeenCalledWith(1, { timeoutMs: 50 })
        expect(killChild).not.toHaveBeenCalled()
    })

    it('for detached runner start, does not treat clean launcher exit alone as ready', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(async () => 0)
        const waitForReady = vi.fn(async () => false)
        const killChild = vi.fn(async () => true)

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: true,
            detachedLauncher: true,
            waitForExit,
            waitForReady,
            killChild,
            timeoutMs: 10,
            readState: async () => ({ pid: 999 }),
            isAlive: () => true,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: false })
        // Grandchild may still be connecting — do not kill the process group.
        expect(killChild).not.toHaveBeenCalled()
    })

    it('for detached runner start, falls back when grandchild never claimed a live PID', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: true,
            detachedLauncher: true,
            waitForExit: vi.fn(async () => 0),
            waitForReady: vi.fn(async () => false),
            killChild: vi.fn(async () => true),
            timeoutMs: 10,
            readState: async () => null,
            isAlive: () => false,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: true })
    })

    it('for detached runner start, fails closed on non-zero launcher exit', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 4242,
            kill: vi.fn(),
        }) as EventEmitter & ChildProcess & { kill: ReturnType<typeof vi.fn> }
        const waitForExit = vi.fn(async () => 1)
        const waitForReady = vi.fn(async () => true)
        const killChild = vi.fn(async () => true)

        const settled = await settleDurableDelegate({
            child,
            wrapperPid: 1,
            useProcessGroup: true,
            detachedLauncher: true,
            waitForExit,
            waitForReady,
            killChild,
        })
        expect(settled).toEqual({ ready: false, safeToFallback: true })
        expect(waitForReady).not.toHaveBeenCalled()
        expect(killChild).not.toHaveBeenCalled()
    })
})

describe('spawnDurableUpgradeDelegate', () => {
    it('routes Windows .cmd durable targets through cross-spawn without shell:true', () => {
        const spawnImpl = vi.fn(
            (_command: string, _args: string[], _options: SpawnOptions) =>
                ({ pid: 1 }) as ChildProcess,
        )
        const crossSpawnImpl = vi.fn(
            (_command: string, _args: string[], _options: SpawnOptions) =>
                ({ pid: 99 }) as ChildProcess,
        )
        const upgradePath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\hapi.cmd'
        const workspaceRoot = 'C:\\work\\A & B'
        const args = ['runner', 'start-sync', '--workspace-root', workspaceRoot]

        spawnDurableUpgradeDelegate(upgradePath, args, {
            platform: 'win32',
            spawnImpl: spawnImpl as never,
            crossSpawnImpl: crossSpawnImpl as never,
        })

        expect(spawnImpl).not.toHaveBeenCalled()
        expect(crossSpawnImpl).toHaveBeenCalledTimes(1)
        const [command, passedArgs, options] = crossSpawnImpl.mock.calls[0]!
        expect(command).toBe(upgradePath)
        expect(passedArgs).toEqual(args)
        expect(passedArgs[3]).toBe(workspaceRoot)
        expect(options.shell).toBeUndefined()
        expect(options.env?.HAPI_CLI_EXECUTABLE).toBe(upgradePath)
    })

    it('uses plain spawn for non-shim Windows executables', () => {
        const spawnImpl = vi.fn(
            (_command: string, _args: string[], _options: SpawnOptions) =>
                ({ pid: 42 }) as ChildProcess,
        )
        const crossSpawnImpl = vi.fn(
            (_command: string, _args: string[], _options: SpawnOptions) =>
                ({ pid: 99 }) as ChildProcess,
        )
        const upgradePath = 'C:\\Users\\me\\.hapi\\artifacts\\hapi.exe'

        spawnDurableUpgradeDelegate(upgradePath, ['runner', 'start'], {
            platform: 'win32',
            spawnImpl: spawnImpl as never,
            crossSpawnImpl: crossSpawnImpl as never,
        })

        expect(crossSpawnImpl).not.toHaveBeenCalled()
        expect(spawnImpl).toHaveBeenCalledTimes(1)
        const [, , options] = spawnImpl.mock.calls[0]!
        expect(options.shell).toBeUndefined()
    })
})
