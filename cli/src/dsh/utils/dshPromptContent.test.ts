import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentMetadata } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'

const authState = vi.hoisted(() => ({
    withinUploadDir: true,
    authorized: true
}))

vi.mock('@/modules/common/handlers/uploads', () => ({
    isPathWithinUploadDir: () => authState.withinUploadDir,
    isAuthorizedUploadFile: () => authState.authorized
}))

import {
    buildDshPromptContent,
    dshImageAttachmentsFor,
    formatDshUserMessage,
    isInlineImageAttachment
} from './dshPromptContent'

function fakeBackend(imagePrompts: boolean): AcpSdkBackend {
    return { supportsImagePrompts: () => imagePrompts } as unknown as AcpSdkBackend
}

function attachment(partial: Partial<AttachmentMetadata> & { path: string; mimeType: string }): AttachmentMetadata {
    return {
        id: 'attachment-1',
        filename: 'file',
        size: 10,
        ...partial
    }
}

describe('isInlineImageAttachment', () => {
    it('accepts the canonical inline image mime types (case-insensitive)', () => {
        for (const mimeType of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
            expect(isInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(true)
        }
    })

    it('rejects other attachments (documents, non-canonical images)', () => {
        for (const mimeType of ['text/plain', 'application/pdf', 'image/heic', '']) {
            expect(isInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(false)
        }
    })
})

describe('formatDshUserMessage', () => {
    it('keeps non-image attachments as @path references', () => {
        expect(formatDshUserMessage('hello', [
            attachment({ path: '/uploads/notes.txt', mimeType: 'text/plain' })
        ])).toBe('@/uploads/notes.txt\n\nhello')
    })

    it('excludes inline-capable images from the text form', () => {
        expect(formatDshUserMessage('hello', [
            attachment({ path: '/uploads/shot.png', mimeType: 'image/png' }),
            attachment({ path: '/uploads/notes.txt', mimeType: 'text/plain' })
        ])).toBe('@/uploads/notes.txt\n\nhello')
    })

    it('keeps non-canonical images (e.g. heic) in the text form', () => {
        expect(formatDshUserMessage('hello', [
            attachment({ path: '/uploads/photo.heic', mimeType: 'image/heic' })
        ])).toBe('@/uploads/photo.heic\n\nhello')
    })

    it('returns the bare text when no attachments apply', () => {
        expect(formatDshUserMessage('hello', undefined)).toBe('hello')
        expect(formatDshUserMessage('hello', [])).toBe('hello')
    })
})

describe('dshImageAttachmentsFor', () => {
    it('collects only the inline-capable image attachments', () => {
        expect(dshImageAttachmentsFor([
            attachment({ path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' }),
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' }),
            attachment({ path: '/uploads/c.webp', mimeType: 'image/webp' })
        ])).toEqual({
            imageAttachments: [
                { path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' },
                { path: '/uploads/c.webp', mimeType: 'image/webp', filename: 'file' }
            ]
        })
    })

    it('omits the field entirely without images', () => {
        expect(dshImageAttachmentsFor(undefined)).toEqual({})
        expect(dshImageAttachmentsFor([
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' })
        ])).toEqual({})
    })
})

describe('buildDshPromptContent', () => {
    let uploadDir: string

    beforeEach(async () => {
        authState.withinUploadDir = true
        authState.authorized = true
        uploadDir = await mkdtemp(join(tmpdir(), 'dsh-prompt-'))
    })

    afterEach(async () => {
        await rm(uploadDir, { recursive: true, force: true })
    })

    it('returns a plain text block without image attachments', async () => {
        const prompt = await buildDshPromptContent(fakeBackend(true), 'hello', undefined, {
            sessionId: 'session-1',
            onNotice: () => {}
        })
        expect(prompt).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('falls back to the @path text form when the backend does not advertise image prompts', async () => {
        const prompt = await buildDshPromptContent(fakeBackend(false), 'hello', [
            { path: '/uploads/a.png', mimeType: 'image/png' }
        ], { sessionId: 'session-1', onNotice: () => {} })
        expect(prompt).toEqual([{ type: 'text', text: '@/uploads/a.png\n\nhello' }])
    })

    it('reads authorized image files into base64 image blocks', async () => {
        const imagePath = join(uploadDir, 'shot.png')
        await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

        const prompt = await buildDshPromptContent(fakeBackend(true), 'look', [
            { path: imagePath, mimeType: 'image/png', filename: 'shot.png' }
        ], { sessionId: 'session-1', onNotice: () => {} })

        expect(prompt).toEqual([
            { type: 'text', text: 'look' },
            { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' }
        ])
    })

    it('normalizes image/jpg to the canonical image/jpeg mimeType', async () => {
        const imagePath = join(uploadDir, 'photo.jpg')
        await writeFile(imagePath, Buffer.from('jpg'))

        const prompt = await buildDshPromptContent(fakeBackend(true), 'look', [
            { path: imagePath, mimeType: 'image/jpg' }
        ], { sessionId: 'session-1', onNotice: () => {} })

        expect(prompt[1]).toEqual({ type: 'image', data: Buffer.from('jpg').toString('base64'), mimeType: 'image/jpeg' })
    })

    it('notifies and skips an image outside the session upload dir', async () => {
        authState.withinUploadDir = false
        const notices: string[] = []

        const prompt = await buildDshPromptContent(fakeBackend(true), 'look', [
            { path: '/elsewhere/shot.png', mimeType: 'image/png', filename: 'shot.png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) })

        expect(prompt).toEqual([{ type: 'text', text: 'look' }])
        expect(notices).toEqual(['Could not attach image shot.png: invalid upload path'])
    })

    it('notifies and skips an unreadable image without failing the turn', async () => {
        const notices: string[] = []
        const prompt = await buildDshPromptContent(fakeBackend(true), 'look', [
            { path: join(uploadDir, 'missing.png'), mimeType: 'image/png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) })

        expect(prompt).toEqual([{ type: 'text', text: 'look' }])
        expect(notices).toHaveLength(1)
        expect(notices[0]).toContain('Could not attach image')
    })
})
