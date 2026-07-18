import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fsMocks = vi.hoisted(() => {
    const readFile = vi.fn()
    const read = vi.fn()
    const close = vi.fn(async () => undefined)
    const handleStat = vi.fn()
    const open = vi.fn(async () => ({
        stat: handleStat,
        read,
        readFile,
        close
    }))

    return {
        open,
        read,
        readFile,
        handleStat,
        close
    }
})

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        open: fsMocks.open
    }
})

describe('buildAgentAttachments TOCTOU guard', () => {
    it('rejects oversized files from the opened handle stat before reading them', async () => {
        const { buildAgentAttachments, MAX_AGENT_ATTACHMENT_TOTAL_BYTES } = await import('./agentAttachment')
        const root = await mkdtemp(join(tmpdir(), 'hapi-agent-attachments-toctou-test-'))
        try {
            const file = join(root, 'artifact.txt')
            await writeFile(file, 'small')
            const actualStats = await stat(file)
            fsMocks.handleStat.mockResolvedValueOnce({
                isFile: () => true,
                size: MAX_AGENT_ATTACHMENT_TOTAL_BYTES + 1,
                dev: actualStats.dev,
                ino: actualStats.ino
            })
            fsMocks.readFile.mockResolvedValueOnce(Buffer.alloc(MAX_AGENT_ATTACHMENT_TOTAL_BYTES + 1))

            await expect(buildAgentAttachments([{ path: 'artifact.txt' }], root)).rejects.toThrow(/too large/i)
            expect(fsMocks.readFile).not.toHaveBeenCalled()
        } finally {
            await rm(root, { recursive: true, force: true })
            vi.clearAllMocks()
        }
    })

    it('uses bounded reads when a file grows after the opened handle stat', async () => {
        const { buildAgentAttachments, MAX_AGENT_ATTACHMENT_TOTAL_BYTES } = await import('./agentAttachment')
        const root = await mkdtemp(join(tmpdir(), 'hapi-agent-attachments-toctou-test-'))
        try {
            const file = join(root, 'artifact.txt')
            await writeFile(file, 'small')
            const actualStats = await stat(file)
            fsMocks.handleStat.mockResolvedValueOnce({
                isFile: () => true,
                size: 5,
                dev: actualStats.dev,
                ino: actualStats.ino
            })
            fsMocks.read.mockImplementation(async (_buffer: Buffer, _offset: number, length: number) => ({
                bytesRead: length,
                buffer: _buffer
            }))
            fsMocks.readFile.mockResolvedValueOnce(Buffer.alloc(MAX_AGENT_ATTACHMENT_TOTAL_BYTES + 1))

            await expect(buildAgentAttachments([{ path: 'artifact.txt' }], root)).rejects.toThrow(/too large/i)
            expect(fsMocks.readFile).not.toHaveBeenCalled()
            expect(fsMocks.read).toHaveBeenCalled()
            expect(Math.max(...fsMocks.read.mock.calls.map((call) => call[2] as number))).toBeLessThanOrEqual(64 * 1024)
        } finally {
            await rm(root, { recursive: true, force: true })
            vi.clearAllMocks()
        }
    })

    it('rejects files whose identity changes after validation but before reading', async () => {
        const { buildAgentAttachments } = await import('./agentAttachment')
        const root = await mkdtemp(join(tmpdir(), 'hapi-agent-attachments-toctou-test-'))
        try {
            await writeFile(join(root, 'artifact.txt'), 'small')
            fsMocks.handleStat.mockResolvedValueOnce({
                isFile: () => true,
                size: 5,
                dev: Number.MAX_SAFE_INTEGER - 1,
                ino: Number.MAX_SAFE_INTEGER - 2
            })
            fsMocks.read.mockResolvedValueOnce({
                bytesRead: 0,
                buffer: Buffer.alloc(0)
            })

            await expect(buildAgentAttachments([{ path: 'artifact.txt' }], root)).rejects.toThrow(/changed/i)
            expect(fsMocks.read).not.toHaveBeenCalled()
            expect(fsMocks.readFile).not.toHaveBeenCalled()
        } finally {
            await rm(root, { recursive: true, force: true })
            vi.clearAllMocks()
        }
    })
})
