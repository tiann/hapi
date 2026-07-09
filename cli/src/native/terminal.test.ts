import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { spawnMock, nativeHelperPathMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    nativeHelperPathMock: vi.fn(() => '/tmp/hapi-local')
}))

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return { ...actual, spawn: spawnMock }
})

vi.mock('./localHelper', () => ({ nativeHelperPath: nativeHelperPathMock }))

import { spawnNativeTerminal } from './terminal'

describe('native terminal helper', () => {
    it('spawns hapi-local pty and speaks the line protocol', () => {
        const writes: string[] = []
        const child = new EventEmitter() as EventEmitter & {
            stdin: { destroyed: boolean; write: (line: string) => void; end: () => void }
            stdout: EventEmitter
            stderr: EventEmitter
            killed: boolean
            exitCode: number | null
            kill: () => void
        }
        child.stdin = {
            destroyed: false,
            write: vi.fn((line: string) => { writes.push(line) }),
            end: vi.fn()
        }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.killed = false
        child.exitCode = null
        child.kill = vi.fn()
        spawnMock.mockReturnValue(child)

        const ready: boolean[] = []
        const output: string[] = []
        const terminal = spawnNativeTerminal({
            command: '/bin/zsh',
            args: ['-l'],
            cwd: '/work',
            cols: 100,
            rows: 40,
            env: { TERM: 'xterm-256color' },
            onReady: () => ready.push(true),
            onOutput: (data) => output.push(data),
            onError: () => {}
        })

        expect(terminal).not.toBeNull()
        expect(spawnMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'pty', 'spawn',
            '--cwd', '/work',
            '--cols', '100',
            '--rows', '40',
            '--command', '/bin/zsh',
            '--arg', '-l'
        ], { cwd: '/work', env: { TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] })

        child.stdout.emit('data', Buffer.from(`ready\t123\ndata\t${Buffer.from('hi').toString('base64')}\n`))
        terminal?.terminal.write('echo hi\n')
        terminal?.terminal.resize(120, 50)
        terminal?.terminal.close()

        expect(ready).toEqual([true])
        expect(output).toEqual(['hi'])
        expect(writes).toEqual([
            `write\t${Buffer.from('echo hi\n').toString('base64')}\n`,
            'resize\t120\t50\n',
            'close\n'
        ])
        expect(child.stdin.end).toHaveBeenCalled()
    })
})
