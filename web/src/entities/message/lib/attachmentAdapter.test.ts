import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAttachmentAdapter } from './attachmentAdapter'
import type { ApiClient } from '@/api/client'

describe('createAttachmentAdapter', () => {
    let mockApi: ApiClient

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = {
            uploadFile: vi.fn(),
            deleteUploadFile: vi.fn(),
        } as unknown as ApiClient
    })

    it('creates adapter with correct accept property', () => {
        const adapter = createAttachmentAdapter(mockApi, 'session-123')
        expect(adapter.accept).toBe('*/*')
    })

    it('uploads file successfully', async () => {
        const mockFile = new File(['test content'], 'test.txt', { type: 'text/plain' })

        ;(mockApi.uploadFile as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            path: '/uploads/test.txt',
        })

        const adapter = createAttachmentAdapter(mockApi, 'session-123')
        const generator = adapter.add({ file: mockFile })

        const states = []
        for await (const state of generator) {
            states.push(state)
        }

        expect(states.length).toBeGreaterThan(0)
        expect(states[0].status.type).toBe('running')

        const finalState = states[states.length - 1]
        expect(finalState.status.type).toBe('requires-action')
        expect((finalState as { path?: string }).path).toBe('/uploads/test.txt')
    })

    it('handles upload error', async () => {
        const mockFile = new File(['test'], 'test.txt', { type: 'text/plain' })

        ;(mockApi.uploadFile as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: false,
            error: 'Upload failed',
        })

        const adapter = createAttachmentAdapter(mockApi, 'session-123')
        const generator = adapter.add({ file: mockFile })

        const states = []
        for await (const state of generator) {
            states.push(state)
        }

        const finalState = states[states.length - 1]
        expect(finalState.status.type).toBe('incomplete')
        expect(finalState.status.reason).toBe('error')
    })

    it('rejects files over size limit', async () => {
        // Create a mock file with size property set to exceed limit
        const mockFile = new File(['small content'], 'large.bin', { type: 'application/octet-stream' })
        Object.defineProperty(mockFile, 'size', { value: 51 * 1024 * 1024 })

        const adapter = createAttachmentAdapter(mockApi, 'session-123')
        const generator = adapter.add({ file: mockFile })

        const states = []
        for await (const state of generator) {
            states.push(state)
        }

        const finalState = states[states.length - 1]
        expect(finalState.status.type).toBe('incomplete')
    })

    it('removes attachment and deletes upload', async () => {
        ;(mockApi.deleteUploadFile as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
        })

        const adapter = createAttachmentAdapter(mockApi, 'session-123')

        const attachment = {
            id: 'att-1',
            type: 'file' as const,
            name: 'test.txt',
            contentType: 'text/plain',
            status: { type: 'complete' as const },
            path: '/uploads/test.txt',
        }

        await adapter.remove(attachment)

        expect(mockApi.deleteUploadFile).toHaveBeenCalledWith('session-123', '/uploads/test.txt')
    })

    it('sends attachment with metadata', async () => {
        const adapter = createAttachmentAdapter(mockApi, 'session-123')

        const pendingAttachment = {
            id: 'att-1',
            type: 'file' as const,
            name: 'test.txt',
            contentType: 'text/plain',
            file: new File(['test'], 'test.txt'),
            status: { type: 'requires-action' as const, reason: 'composer-send' as const },
            path: '/uploads/test.txt',
        }

        const complete = await adapter.send(pendingAttachment)

        expect(complete.status.type).toBe('complete')
        expect(complete.content).toBeDefined()
        expect(complete.content.length).toBeGreaterThan(0)

        const contentText = complete.content[0].text
        const parsed = JSON.parse(contentText)
        expect(parsed.__attachmentMetadata).toBeDefined()
        expect(parsed.__attachmentMetadata.path).toBe('/uploads/test.txt')
    })
})
