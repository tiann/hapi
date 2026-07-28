import { describe, expect, it } from 'bun:test'
import {
    scratchlistSessionBytesBeforeForPut,
    validateScratchlistAttachmentsForWrite,
} from './validate'
import {
    SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_ENTRY,
    SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE,
    SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_SESSION,
    SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_PER_ENTRY,
} from '@hapi/protocol'

const limits = {
    maxAttachmentsPerEntry: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_PER_ENTRY,
    maxBytesPerFile: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE,
    maxBytesPerEntry: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_ENTRY,
    maxBytesPerSession: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_SESSION,
    allowedMimeTypes: ['image/png'],
}

const eightMb = 8 * 1024 * 1024

describe('scratchlistSessionBytesBeforeForPut', () => {
    it('subtracts removed blobs so replace-in-place does not double-count disk', () => {
        // Old 8MB + new 8MB still on disk; PUT drops the old id.
        // Without subtracting removed bytes, sessionBytesBefore would be 8MB and
        // a 10MB session cap would falsely reject the replace.
        const sessionBytesBefore = scratchlistSessionBytesBeforeForPut(
            16 * 1024 * 1024,
            [{ size: eightMb }],
            [{ size: eightMb }],
        )
        expect(sessionBytesBefore).toBe(0)
        const validation = validateScratchlistAttachmentsForWrite(
            [{
                id: '11111111-1111-4111-8111-111111111111',
                filename: 'new.png',
                mimeType: 'image/png',
                size: eightMb,
                path: 'hapi-hub:scratchlist/default/s/11111111-1111-4111-8111-111111111111-new.png',
            }],
            { ...limits, maxBytesPerSession: 10 * 1024 * 1024 },
            sessionBytesBefore,
        )
        expect(validation.ok).toBe(true)

        const naiveBefore = Math.max(0, 16 * 1024 * 1024 - eightMb)
        const naive = validateScratchlistAttachmentsForWrite(
            [{
                id: '11111111-1111-4111-8111-111111111111',
                filename: 'new.png',
                mimeType: 'image/png',
                size: eightMb,
                path: 'hapi-hub:scratchlist/default/s/11111111-1111-4111-8111-111111111111-new.png',
            }],
            { ...limits, maxBytesPerSession: 10 * 1024 * 1024 },
            naiveBefore,
        )
        expect(naive.ok).toBe(false)
    })

    it('still counts sibling entry bytes against the session cap', () => {
        // 9MB sibling + 8MB new upload already on disk.
        const sessionBytesBefore = scratchlistSessionBytesBeforeForPut(
            17 * 1024 * 1024,
            [{ size: eightMb }],
            [],
        )
        expect(sessionBytesBefore).toBe(9 * 1024 * 1024)
        const validation = validateScratchlistAttachmentsForWrite(
            [{
                id: '22222222-2222-4222-8222-222222222222',
                filename: 'big.png',
                mimeType: 'image/png',
                size: eightMb,
                path: 'hapi-hub:scratchlist/default/s/22222222-2222-4222-8222-222222222222-big.png',
            }],
            { ...limits, maxBytesPerSession: 10 * 1024 * 1024 },
            sessionBytesBefore,
        )
        expect(validation.ok).toBe(false)
        if (validation.ok) throw new Error('expected failure')
        expect(validation.code).toBe('scratchlist_attachments_session_bytes')
    })
})
