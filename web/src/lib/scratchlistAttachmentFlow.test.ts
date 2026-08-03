import { describe, expect, it, vi } from 'vitest'
import type { AttachmentMetadata } from '@/types/api'
import {
    attachmentsNeedScratchlistMigration,
    finalizeMigratedScratchlistParkCleanup,
    migrateChatPathAttachmentsToScratchlist,
    prepareScratchlistParkAttachments,
    type ParkAttachmentMetadata,
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
        // Chat-path delete is deferred until park succeeds.
        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(result).toEqual([
            hub,
            { ...migrated, previewUrl: chat.previewUrl, migratedFromPath: chat.path },
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

describe('prepareScratchlistParkAttachments (#1226)', () => {
    it('passes hub chips through and migrates chat-path chips without deleting the chat upload', async () => {
        const hubMeta = {
            id: 'hub-1',
            filename: 'hub.png',
            mimeType: 'image/png',
            size: 2,
            path: 'hapi-hub:scratchlist/default/session-1/hub-1-hub.png',
        }
        const migrated = {
            id: 'hub-new',
            filename: 'chat.png',
            mimeType: 'image/png',
            size: 1,
            path: 'hapi-hub:scratchlist/default/session-1/hub-new-chat.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: migrated,
        })
        const deleteUploadFile = vi.fn()
        const api = { uploadScratchlistAttachment, deleteUploadFile } as never
        const chatFile = new File([new Uint8Array([1])], 'chat.png', { type: 'image/png' })

        const result = await prepareScratchlistParkAttachments(api, 'session-1', [
            {
                id: 'chip-hub',
                name: 'hub.png',
                contentType: 'image/png',
                hubAttachment: hubMeta,
                previewUrl: 'data:image/png;base64,hub',
            },
            {
                id: 'chip-chat',
                name: 'chat.png',
                contentType: 'image/png',
                file: chatFile,
                path: '/tmp/hapi-blobs/chat.png',
                previewUrl: 'data:image/png;base64,chat',
            },
        ])

        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(result).toEqual([
            { ...hubMeta, previewUrl: 'data:image/png;base64,hub' },
            {
                ...migrated,
                previewUrl: 'data:image/png;base64,chat',
                migratedFromPath: '/tmp/hapi-blobs/chat.png',
            },
        ])
    })

    it('reuses a restored hub path without re-uploading', async () => {
        const uploadScratchlistAttachment = vi.fn()
        const api = { uploadScratchlistAttachment } as never
        const hubPath = 'hapi-hub:scratchlist/default/session-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-photo.png'
        const file = new File([new Uint8Array([1, 2])], 'photo.png', { type: 'image/png' })

        const result = await prepareScratchlistParkAttachments(api, 'session-1', [
            {
                id: 'chip-restored',
                name: 'photo.png',
                contentType: 'image/png',
                file,
                path: hubPath,
                previewUrl: 'data:image/png;base64,x',
            },
        ])

        expect(uploadScratchlistAttachment).not.toHaveBeenCalled()
        expect(result).toEqual([{
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 2,
            path: hubPath,
            previewUrl: 'data:image/png;base64,x',
        }])
    })

    it('rolls back hub blobs when a later chip fails to migrate', async () => {
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
            .mockResolvedValueOnce({ success: false, error: 'quota' })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const api = { uploadScratchlistAttachment, deleteScratchlistAttachment } as never
        const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })

        await expect(prepareScratchlistParkAttachments(api, 'session-1', [
            { id: '1', name: 'a.png', contentType: 'image/png', file, path: '/tmp/a.png' },
            { id: '2', name: 'b.png', contentType: 'image/png', file, path: '/tmp/b.png' },
        ])).rejects.toThrow(/quota|Failed to migrate/i)

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-ok')
    })
})

describe('finalizeMigratedScratchlistParkCleanup (#1226)', () => {
    const hubPath = 'hapi-hub:scratchlist/default/session-1/hub-1-a.png'
    const chatPath = '/tmp/hapi-blobs/a.png'

    it('deletes chat uploads after accepted park', async () => {
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const deleteScratchlistAttachment = vi.fn()
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
                migratedFromPath: chatPath,
            } as ParkAttachmentMetadata],
            true,
        )

        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', chatPath)
        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
    })

    it('deletes orphan hub blobs after rejected park so retry can remigrate', async () => {
        const deleteUploadFile = vi.fn()
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
                migratedFromPath: chatPath,
            } as ParkAttachmentMetadata],
            false,
        )

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-1')
        expect(deleteUploadFile).not.toHaveBeenCalled()
    })

    it('no-ops when nothing was migrated from a chat path', async () => {
        const deleteUploadFile = vi.fn()
        const deleteScratchlistAttachment = vi.fn()
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
            }],
            true,
        )

        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
    })
})
