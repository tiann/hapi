import { describe, expect, it, vi } from 'vitest'
import type { AttachmentMetadata } from '@/types/api'
import {
    attachmentsNeedScratchlistMigration,
    migrateChatPathAttachmentsToScratchlist,
} from './scratchlistAttachmentFlow'

function chatAttachment(path = '/tmp/hapi-blobs/a.png'): AttachmentMetadata {
    return {
        id: 'att-1',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 4,
        path,
        previewUrl: 'data:image/png;base64,aaaa',
    }
}

function hubAttachment(): AttachmentMetadata {
    return {
        id: 'hub-1',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 4,
        path: 'hapi-hub:scratchlist/default/session-1/hub-1-a.png',
    }
}

describe('attachmentsNeedScratchlistMigration (#1226)', () => {
    it('is false for empty / already-hub payloads', () => {
        expect(attachmentsNeedScratchlistMigration(undefined)).toBe(false)
        expect(attachmentsNeedScratchlistMigration([])).toBe(false)
        expect(attachmentsNeedScratchlistMigration([hubAttachment()])).toBe(false)
    })

    it('is true when any attachment still has a chat upload path', () => {
        expect(attachmentsNeedScratchlistMigration([chatAttachment()])).toBe(true)
        expect(attachmentsNeedScratchlistMigration([hubAttachment(), chatAttachment()])).toBe(true)
    })
})

describe('migrateChatPathAttachmentsToScratchlist (#1226)', () => {
    it('re-uploads chat-path items via scratchlist/upload and leaves hub items alone', async () => {
        const migrated = {
            id: 'hub-new',
            filename: 'a.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-1/hub-new-a.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: migrated,
        })
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const api = { uploadScratchlistAttachment, deleteUploadFile } as never

        const hub = hubAttachment()
        const chat = chatAttachment()
        const contentBase64 = 'iVBORw0KGgo='
        const result = await migrateChatPathAttachmentsToScratchlist(
            api,
            'session-1',
            [hub, chat],
            async (att) => {
                expect(att.path).toBe(chat.path)
                return contentBase64
            },
        )

        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(uploadScratchlistAttachment).toHaveBeenCalledWith(
            'session-1',
            'a.png',
            contentBase64,
            'image/png',
        )
        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', chat.path)
        expect(result).toEqual([
            hub,
            { ...migrated, previewUrl: chat.previewUrl },
        ])
    })

    it('rolls back newly uploaded hub blobs and throws when one migrate fails', async () => {
        const uploadScratchlistAttachment = vi.fn()
            .mockResolvedValueOnce({
                success: true,
                attachment: {
                    id: 'hub-ok',
                    filename: 'a.png',
                    mimeType: 'image/png',
                    size: 1,
                    path: 'hapi-hub:scratchlist/default/session-1/hub-ok-a.png',
                },
            })
            .mockResolvedValueOnce({ success: false, error: 'too big' })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const api = {
            uploadScratchlistAttachment,
            deleteScratchlistAttachment,
            deleteUploadFile,
        } as never

        await expect(migrateChatPathAttachmentsToScratchlist(
            api,
            'session-1',
            [chatAttachment('/tmp/a.png'), chatAttachment('/tmp/b.png')],
            async () => 'YmFzZTY0',
        )).rejects.toThrow(/too big|Failed to migrate/i)

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-ok')
    })
})
