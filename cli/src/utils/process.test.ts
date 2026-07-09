import { describe, expect, it, vi } from 'vitest'

const { execFileMock, nativeHelperPathMock } = vi.hoisted(() => ({
    execFileMock: vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, result?: { stdout: string, stderr: string }) => void) => {
        callback(null, { stdout: '{"signaled":true}', stderr: '' })
    }),
    nativeHelperPathMock: vi.fn(() => '/tmp/hapi-local')
}))

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return {
        ...actual,
        execFile: execFileMock
    }
})

vi.mock('@/native/localHelper', () => ({
    nativeHelperPath: nativeHelperPathMock
}))

import { killProcessByChildProcess } from './process'
import type { ChildProcess } from 'node:child_process'

describe('process native helper', () => {
    it('delegates process-tree kill to hapi-local when available', async () => {
        const child = { pid: 12345 } as ChildProcess

        await expect(killProcessByChildProcess(child, true)).resolves.toBe(true)

        expect(execFileMock).toHaveBeenCalledOnce()
        expect(execFileMock.mock.calls[0]?.[0]).toBe('/tmp/hapi-local')
        expect(execFileMock.mock.calls[0]?.[1]).toEqual([
            'process',
            'kill-tree',
            '--pid',
            '12345',
            '--force'
        ])
    })
})
