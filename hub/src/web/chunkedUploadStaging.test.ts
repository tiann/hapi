import { afterEach, describe, expect, it, vi } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChunkedUploadStaging } from './chunkedUploadStaging'

const tempDirs: string[] = []

afterEach(() => {
    vi.useRealTimers()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hub-chunked-staging-'))
    tempDirs.push(dir)
    return dir
}

describe('ChunkedUploadStaging', () => {
    it('refreshes the inactivity timeout as chunks make progress', async () => {
        vi.useFakeTimers()
        const root = tempRoot()
        const staging = new ChunkedUploadStaging(1_000, root)
        await staging.begin({
            namespace: 'default',
            sessionId: 'session-1',
            uploadId: 'upload-1',
            filename: 'slow.bin',
            mimeType: 'application/octet-stream',
            size: 2,
        })

        vi.advanceTimersByTime(900)
        await staging.append('default', 'session-1', 'upload-1', 0, new Uint8Array([1]))
        vi.advanceTimersByTime(900)
        await staging.append('default', 'session-1', 'upload-1', 1, new Uint8Array([2]))
        vi.advanceTimersByTime(900)

        const finalized = await staging.finalize('default', 'session-1', 'upload-1')
        expect(existsSync(finalized.path)).toBe(true)
        await staging.discard(finalized)
    })

    it('removes staging state when a chunk write fails', async () => {
        const root = tempRoot()
        const staging = new ChunkedUploadStaging(60_000, root)
        await staging.begin({
            namespace: 'default',
            sessionId: 'session-1',
            uploadId: 'upload-write-failure',
            filename: 'failed.bin',
            mimeType: 'application/octet-stream',
            size: 1,
        })
        const uploadDir = readdirSync(root).find((name) => name.startsWith('chunk-'))!
        const payloadPath = join(root, uploadDir, 'payload')
        rmSync(payloadPath)
        mkdirSync(payloadPath)

        await expect(
            staging.append('default', 'session-1', 'upload-write-failure', 0, new Uint8Array([1]))
        ).rejects.toBeDefined()

        expect(readdirSync(root)).toEqual([])
    })

    it('removes dead-process staging directories without touching the current process', async () => {
        const root = tempRoot()
        const dead = join(root, 'chunk-dead')
        const current = join(root, 'chunk-current')
        mkdirSync(dead)
        mkdirSync(current)
        writeFileSync(join(dead, '.staging.json'), JSON.stringify({ ownerPid: -1, createdAt: 1 }))
        writeFileSync(join(current, '.staging.json'), JSON.stringify({ ownerPid: process.pid, createdAt: 1 }))

        const staging = new ChunkedUploadStaging(1_000, root)
        await staging.initialize()

        expect(existsSync(dead)).toBe(false)
        expect(existsSync(current)).toBe(true)
    })
})
