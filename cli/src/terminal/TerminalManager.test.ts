import { afterEach, describe, expect, it } from 'bun:test'
import { TerminalManager } from './TerminalManager'

type SpawnOptions = {
    terminal?: {
        cols: number
        rows: number
        data?: (terminal: FakeTerminal, data: Uint8Array) => void
    }
}

type FakeTerminal = {
    resize: (cols: number, rows: number) => void
    write: (data: string) => void
    close: () => void
}

const originalSpawn = Bun.spawn

function installFakeSpawn() {
    let latestTerminal: FakeTerminal | null = null
    let latestOptions: SpawnOptions | null = null

    Bun.spawn = ((command: string[], options: SpawnOptions) => {
        latestOptions = options
        const terminal: FakeTerminal = {
            resize: () => {},
            write: () => {},
            close: () => {}
        }
        latestTerminal = terminal
        return {
            terminal,
            killed: false,
            exitCode: null,
            signalCode: null,
            kill: () => {}
        }
    }) as typeof Bun.spawn

    return {
        emitData(data: string): void {
            if (!latestOptions?.terminal?.data || !latestTerminal) {
                throw new Error('terminal data handler was not registered')
            }
            latestOptions.terminal.data(latestTerminal, new TextEncoder().encode(data))
        }
    }
}

describe('TerminalManager', () => {
    afterEach(() => {
        Bun.spawn = originalSpawn
    })

    it('replays buffered output when reattaching to an existing terminal', () => {
        const fakeSpawn = installFakeSpawn()
        const outputs: string[] = []
        const readyIds: string[] = []

        const manager = new TerminalManager({
            sessionId: 'session-1',
            getSessionPath: () => '/tmp',
            onReady: (payload) => readyIds.push(payload.terminalId),
            onOutput: (payload) => outputs.push(payload.data),
            onExit: () => {},
            onError: () => {},
            idleTimeoutMs: 0
        })

        manager.create('terminal-1', 80, 24)
        fakeSpawn.emitData('first line\n')
        fakeSpawn.emitData('second line\n')

        outputs.length = 0
        manager.create('terminal-1', 100, 30, undefined, true)

        expect(readyIds).toEqual(['terminal-1', 'terminal-1'])
        expect(outputs).toEqual(['first line\nsecond line\n'])
    })

    it('does not replay buffered output unless requested', () => {
        const fakeSpawn = installFakeSpawn()
        const outputs: string[] = []

        const manager = new TerminalManager({
            sessionId: 'session-1',
            getSessionPath: () => '/tmp',
            onReady: () => {},
            onOutput: (payload) => outputs.push(payload.data),
            onExit: () => {},
            onError: () => {},
            idleTimeoutMs: 0
        })

        manager.create('terminal-1', 80, 24)
        fakeSpawn.emitData('first line\n')

        outputs.length = 0
        manager.create('terminal-1', 80, 24)

        expect(outputs).toEqual([])
    })

    it('cleans up detached terminals after the detached timeout', async () => {
        installFakeSpawn()
        const errors: string[] = []

        const manager = new TerminalManager({
            sessionId: 'session-1',
            getSessionPath: () => '/tmp',
            onReady: () => {},
            onOutput: () => {},
            onExit: () => {},
            onError: (payload) => errors.push(payload.message),
            idleTimeoutMs: 0,
            detachedTimeoutMs: 1
        })

        manager.create('terminal-1', 80, 24)
        manager.detach('terminal-1')
        await new Promise((resolve) => setTimeout(resolve, 5))
        manager.write('terminal-1', 'echo still-there\n')

        expect(errors).toEqual(['Terminal not found.'])
    })
})
