import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingAttachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { createFileAttachment } from '@/lib/fileAttachments'

afterEach(() => {
    vi.unstubAllGlobals()
})

function simulateNonSecureCrypto(): void {
    vi.stubGlobal('crypto', {})
}

describe('attachment id generation', () => {
    it('creates queued file attachments when crypto.randomUUID is unavailable', () => {
        simulateNonSecureCrypto()
        const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

        expect(() => createFileAttachment(file)).not.toThrow()
        expect(createFileAttachment(file).id).toMatch(/.+/)
    })

    it('starts assistant-ui uploads when crypto.randomUUID is unavailable', async () => {
        simulateNonSecureCrypto()
        const api = {
            uploadFile: vi.fn(async () => ({ success: true, path: 'uploads/hello.txt' })),
            deleteUploadFile: vi.fn(async () => undefined),
        } as unknown as ApiClient
        const adapter = createAttachmentAdapter(api, 'session-1')
        const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

        const added = adapter.add({ file })
        expect('next' in added).toBe(true)

        const iterator = added as AsyncGenerator<PendingAttachment, void>
        const first = await iterator.next()

        expect(first.done).toBe(false)
        if (first.done) throw new Error('expected first pending attachment')

        expect(first.value.id).toMatch(/.+/)
        expect(first.value.status).toEqual({ type: 'running', reason: 'uploading', progress: 0 })
    })
})
