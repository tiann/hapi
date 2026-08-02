import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPtyManager } from './AgentPtyManager'

const globalWithBun = globalThis as unknown as {
    Bun?: {
        spawn?: unknown
    }
}
const originalBun = globalWithBun.Bun

function makeMockProc(): { terminal: Bun.Terminal; killed: boolean; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn>; onExit?: (code: number | null) => void } {
    return {
        terminal: {
            write: vi.fn(),
            resize: vi.fn(),
            close: vi.fn(),
        } as unknown as Bun.Terminal,
        killed: false,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => { (proc as any).killed = true }),
    }
}

let proc: ReturnType<typeof makeMockProc>

describe('AgentPtyManager', () => {
    beforeEach(() => {
        proc = makeMockProc()
        const spawnMock = vi.fn(() => proc)
        globalWithBun.Bun = {
            spawn: spawnMock,
        }
    })

    afterEach(() => {
        if (originalBun === undefined) {
            delete globalWithBun.Bun
        } else {
            globalWithBun.Bun = originalBun
        }
    })

    it('spawns a process with terminal option', () => {
        const manager = new AgentPtyManager()
        const onData = vi.fn()

        manager.spawn({
            command: 'claude',
            args: ['--model', 'sonnet'],
            cwd: '/workspace/project',
            cols: 80,
            rows: 24,
            onData,
        })

        expect(globalWithBun.Bun!.spawn).toHaveBeenCalledWith(
            ['claude', '--model', 'sonnet'],
            expect.objectContaining({
                cwd: '/workspace/project',
                terminal: expect.objectContaining({
                    cols: 80,
                    rows: 24,
                    data: expect.any(Function),
                }),
            })
        )
        expect(manager.isRunning).toBe(true)
    })

    it('calls onData callback when terminal emits data', () => {
        const manager = new AgentPtyManager()
        const onData = vi.fn()

        manager.spawn({
            command: 'claude',
            onData,
        })

        const spawnCall = (globalWithBun.Bun!.spawn as ReturnType<typeof vi.fn>).mock.calls[0]
        const terminalConfig = spawnCall[1].terminal
        const decoder = new TextDecoder()
        const data = new TextEncoder().encode('hello from claude')

        terminalConfig.data(proc.terminal, data)

        expect(onData).toHaveBeenCalledWith('hello from claude')
    })

    it('writes data to terminal', () => {
        const manager = new AgentPtyManager()

        manager.spawn({
            command: 'claude',
            onData: vi.fn(),
        })

        manager.write('test input\n')

        expect(proc.terminal.write).toHaveBeenCalledWith('test input\n')
    })

    it('resizes terminal dimensions', () => {
        const manager = new AgentPtyManager()

        manager.spawn({
            command: 'claude',
            cols: 80,
            rows: 24,
            onData: vi.fn(),
        })

        manager.resize(120, 40)

        expect(proc.terminal.resize).toHaveBeenCalledWith(120, 40)
    })

    it('kills the process and cleans up', () => {
        const manager = new AgentPtyManager()

        manager.spawn({
            command: 'claude',
            onData: vi.fn(),
        })

        manager.kill()

        expect(proc.kill).toHaveBeenCalled()
        expect(proc.terminal.close).toHaveBeenCalled()
        expect(manager.isRunning).toBe(false)
    })

    it('reports exit code via onExit callback', () => {
        const manager = new AgentPtyManager()
        const onExit = vi.fn()

        manager.spawn({
            command: 'claude',
            onData: vi.fn(),
            onExit,
        })

        const spawnCall = (globalWithBun.Bun!.spawn as ReturnType<typeof vi.fn>).mock.calls[0]
        const onExitHandler = spawnCall[1].onExit

        onExitHandler(proc, 0)

        expect(onExit).toHaveBeenCalledWith(0, null)
        expect(manager.exitCode).toBe(0)
    })

    it('does not call spawn if Bun is unavailable', () => {
        delete globalWithBun.Bun
        const manager = new AgentPtyManager()
        const onError = vi.fn()

        manager.spawn({
            command: 'claude',
            onData: vi.fn(),
            onError,
        })

        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('Bun') })
        )
        expect(manager.isRunning).toBe(false)
    })

    it('does not write if not spawned', () => {
        const manager = new AgentPtyManager()
        manager.write('data')
        // No error should be thrown
    })

    it('does not resize if not spawned', () => {
        const manager = new AgentPtyManager()
        manager.resize(80, 24)
        // No error should be thrown
    })

    it('does not kill if not spawned', () => {
        const manager = new AgentPtyManager()
        manager.kill()
        // No error should be thrown
    })

    it('tracks exit code and signal code', () => {
        const manager = new AgentPtyManager()

        manager.spawn({
            command: 'claude',
            onData: vi.fn(),
        })

        const spawnCall = (globalWithBun.Bun!.spawn as ReturnType<typeof vi.fn>).mock.calls[0]
        const onExitHandler = spawnCall[1].onExit

        proc.signalCode = 'SIGTERM'
        onExitHandler(proc, null)

        expect(manager.exitCode).toBe(null)
        expect(manager.signalCode).toBe('SIGTERM')
        expect(manager.isRunning).toBe(false)
    })

    it('applies environment variables from filtered env', () => {
        const manager = new AgentPtyManager()

        manager.spawn({
            command: 'claude',
            env: { TERM: 'xterm-256color', CUSTOM_VAR: 'value' },
            onData: vi.fn(),
        })

        const spawnCall = (globalWithBun.Bun!.spawn as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(spawnCall[1].env).toEqual({ TERM: 'xterm-256color', CUSTOM_VAR: 'value' })
    })
})
