import { describe, expect, it } from 'vitest'
import { createFileAttachment, isImageMimeType } from './fileAttachments'

describe('fileAttachments lib', () => {
    describe('createFileAttachment', () => {
        it('creates attachment with uploading status', () => {
            const file = new File(['content'], 'test.txt', { type: 'text/plain' })
            const attachment = createFileAttachment(file)

            expect(attachment.file).toBe(file)
            expect(attachment.status).toBe('uploading')
            expect(attachment.id).toBeDefined()
            expect(typeof attachment.id).toBe('string')
        })

        it('generates unique IDs for different files', () => {
            const file1 = new File(['content1'], 'test1.txt')
            const file2 = new File(['content2'], 'test2.txt')

            const attachment1 = createFileAttachment(file1)
            const attachment2 = createFileAttachment(file2)

            expect(attachment1.id).not.toBe(attachment2.id)
        })
    })

    describe('isImageMimeType', () => {
        it('returns true for image MIME types', () => {
            expect(isImageMimeType('image/png')).toBe(true)
            expect(isImageMimeType('image/jpeg')).toBe(true)
            expect(isImageMimeType('image/gif')).toBe(true)
            expect(isImageMimeType('image/webp')).toBe(true)
            expect(isImageMimeType('image/svg+xml')).toBe(true)
        })

        it('returns false for non-image MIME types', () => {
            expect(isImageMimeType('text/plain')).toBe(false)
            expect(isImageMimeType('application/pdf')).toBe(false)
            expect(isImageMimeType('video/mp4')).toBe(false)
            expect(isImageMimeType('audio/mpeg')).toBe(false)
        })

        it('returns false for empty string', () => {
            expect(isImageMimeType('')).toBe(false)
        })
    })
})
