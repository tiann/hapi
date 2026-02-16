import { describe, it, expect } from 'vitest'
import { formatAttachmentsForClaude, formatMessageWithAttachments } from './attachmentFormatter'

const attachments = [
    {
        id: '1',
        filename: 'index.ts',
        mimeType: 'text/plain',
        size: 10,
        path: '/repo/src/index.ts'
    }
]

describe('formatAttachmentsForClaude', () => {
    it('formats attachments as @path references', () => {
        expect(formatAttachmentsForClaude(attachments)).toBe('@/repo/src/index.ts')
    })

    it('uses cwd-relative paths for codex when possible', () => {
        expect(formatAttachmentsForClaude(attachments, {
            agent: 'codex',
            cwd: '/repo'
        })).toBe('@src/index.ts')
    })

    it('keeps absolute path when outside codex cwd', () => {
        expect(formatAttachmentsForClaude(attachments, {
            agent: 'codex',
            cwd: '/other'
        })).toBe('@/repo/src/index.ts')
    })
})

describe('formatMessageWithAttachments', () => {
    it('prepends attachments for normal messages', () => {
        expect(formatMessageWithAttachments('fix this', attachments)).toBe('@/repo/src/index.ts\n\nfix this')
    })

    it('keeps codex slash commands untouched', () => {
        expect(formatMessageWithAttachments('/help', attachments, {
            agent: 'codex',
            cwd: '/repo'
        })).toBe('/help')
    })

    it('keeps claude slash commands untouched', () => {
        expect(formatMessageWithAttachments('/model sonnet', attachments, {
            agent: 'claude',
            cwd: '/repo'
        })).toBe('/model sonnet')
    })

    it('keeps gemini slash commands untouched', () => {
        expect(formatMessageWithAttachments('/model gemini-2.5-pro', attachments, {
            agent: 'gemini',
            cwd: '/repo'
        })).toBe('/model gemini-2.5-pro')
    })
})
