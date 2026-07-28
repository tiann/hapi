import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    deleteScratchlistAttachmentById,
    moveScratchlistAttachmentFilesForSession,
    resolveScratchlistAttachmentsForSession,
    sumScratchlistAttachmentBytesOnDisk,
    writeScratchlistAttachmentFile,
} from './storage'

describe('scratchlistAttachments storage security', () => {
    it('resolves only attachments owned by the session namespace path', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-scratchlist-storage-'))
        try {
            const owned = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                'session-a',
                'a.png',
                'image/png',
                Buffer.from('aaa')
            )
            const other = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                'session-b',
                'b.png',
                'image/png',
                Buffer.from('bbbb')
            )

            const ok = await resolveScratchlistAttachmentsForSession(
                hapiHome,
                'default',
                'session-a',
                [owned]
            )
            expect(ok.ok).toBe(true)
            if (ok.ok) {
                expect(ok.attachments[0]?.size).toBe(3)
                expect(ok.attachments[0]?.path).toBe(owned.path)
            }

            const forged = await resolveScratchlistAttachmentsForSession(
                hapiHome,
                'default',
                'session-a',
                [{ ...other, id: other.id }]
            )
            expect(forged.ok).toBe(false)

            const disk = await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', 'session-a')
            expect(disk).toBe(3)

            const deleted = await deleteScratchlistAttachmentById(
                hapiHome,
                'default',
                'session-a',
                owned.id
            )
            expect(deleted).toBe(true)
            expect(await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', 'session-a')).toBe(0)

            const otherAgain = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                'session-a',
                'c.png',
                'image/png',
                Buffer.from('ccc')
            )
            const partialId = otherAgain.id.split('-')[0]!
            expect(partialId.length).toBe(8)
            expect(
                await deleteScratchlistAttachmentById(hapiHome, 'default', 'session-a', partialId)
            ).toBe(false)
            expect(await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', 'session-a')).toBe(3)

            const aliased = await resolveScratchlistAttachmentsForSession(
                hapiHome,
                'default',
                'session-a',
                [{ ...otherAgain, id: partialId, path: otherAgain.path }]
            )
            expect(aliased.ok).toBe(false)

            const toxic = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                'session-a',
                'ok.png',
                'image/png',
                Buffer.from('dd')
            )
            const resolvedToxic = await resolveScratchlistAttachmentsForSession(
                hapiHome,
                'default',
                'session-a',
                [{
                    ...toxic,
                    filename: 'evil\r\nContent-Type: text/html".png',
                }]
            )
            expect(resolvedToxic.ok).toBe(true)
            if (resolvedToxic.ok) {
                expect(resolvedToxic.attachments[0]?.filename).toBe('ok.png')
                expect(resolvedToxic.attachments[0]?.filename).not.toMatch(/[\r\n"]/)
            }
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('re-keys attachment files when a session id is transferred', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-scratchlist-move-'))
        try {
            const written = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                'session-old',
                'pic.png',
                'image/png',
                Buffer.from('payload')
            )
            const moved = await moveScratchlistAttachmentFilesForSession(
                hapiHome,
                'default',
                'session-old',
                'session-new',
                [written]
            )
            expect(moved[0]?.path).toContain('/session-new/')
            expect(moved[0]?.path).not.toContain('/session-old/')
            expect(await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', 'session-old')).toBe(0)
            expect(await sumScratchlistAttachmentBytesOnDisk(hapiHome, 'default', 'session-new')).toBe(7)

            const resolved = await resolveScratchlistAttachmentsForSession(
                hapiHome,
                'default',
                'session-new',
                moved
            )
            expect(resolved.ok).toBe(true)
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })
})
