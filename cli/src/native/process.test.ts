import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock, nativeHelperPathMock } = vi.hoisted(() => ({
    execFileMock: vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, result?: { stdout: string, stderr: string }) => void) => {
        callback(null, { stdout: '{"pid":12345}', stderr: '' })
    }),
    spawnMock: vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"pid":23456}\n')))
        return child
    }),
    nativeHelperPathMock: vi.fn(() => '/tmp/hapi-local')
}))

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return { ...actual, execFile: execFileMock, spawn: spawnMock }
})

vi.mock('./localHelper', () => ({ nativeHelperPath: nativeHelperPathMock }))

import { nativeSpawnDetached, nativeSpawnSupervised } from './process'

describe('native process helper', () => {
    it('calls hapi-local process spawn-detached', async () => {
        const env = { ...process.env, HAPI_TEST: '1' }
        await expect(nativeSpawnDetached({
            command: '/bin/echo',
            args: ['hi'],
            cwd: '/tmp',
            env
        })).resolves.toBe(12345)

        expect(execFileMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'process',
            'spawn-detached',
            '--cwd',
            '/tmp',
            '--command',
            '/bin/echo',
            '--arg',
            'hi'
        ], { encoding: 'utf8', env }, expect.any(Function))
    })

    it('calls hapi-local process spawn-supervised and parses child pid', async () => {
        const env = { ...process.env, HAPI_TEST: '1' }
        const result = await nativeSpawnSupervised({ command: '/bin/echo', args: ['hi'], cwd: '/tmp', env })

        expect(result?.pid).toBe(23456)
        expect(spawnMock).toHaveBeenCalledWith('/tmp/hapi-local', [
            'process',
            'spawn-supervised',
            '--cwd',
            '/tmp',
            '--command',
            '/bin/echo',
            '--arg',
            'hi'
        ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    })
})
