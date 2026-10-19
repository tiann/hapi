import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../store'
import {
    deleteScratchlistAttachmentFiles,
    readScratchlistAttachmentFile,
    writeScratchlistAttachmentFile,
} from '../scratchlistAttachments/storage'
import { MessageService } from './messageService'
import { rehomeMessageAttachments } from './messageAttachmentTransfer'

describe('rehomeMessageAttachments', () => {
    it('keeps earlier message metadata aligned when a later move fails', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-message-rehome-partial-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        try {
            const oldSession = store.sessions.getOrCreateSession(
                'message-rehome-old',
                { path: '/tmp/old', host: 'localhost' },
                null,
                'default',
            )
            const newSession = store.sessions.getOrCreateSession(
                'message-rehome-new',
                { path: '/tmp/new', host: 'localhost' },
                null,
                'default',
            )
            const firstAttachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                oldSession.id,
                'first.png',
                'image/png',
                Buffer.from('first'),
            )
            const missingAttachment = {
                id: '22222222-2222-4222-8222-222222222222',
                filename: 'missing.png',
                mimeType: 'image/png',
                size: 7,
                path: `hapi-hub:scratchlist/default/${oldSession.id}/missing.png`,
            }
            store.messages.addMessage(
                oldSession.id,
                {
                    role: 'user',
                    content: { type: 'text', text: 'first', attachments: [firstAttachment] },
                },
                'message-rehome-first',
                Date.now() + 60_000,
            )
            store.messages.addMessage(
                oldSession.id,
                {
                    role: 'user',
                    content: { type: 'text', text: 'second', attachments: [missingAttachment] },
                },
                'message-rehome-second',
                Date.now() + 60_000,
            )
            store.messages.mergeSessionMessages(oldSession.id, newSession.id)

            await expect(
                rehomeMessageAttachments(store, 'default', oldSession.id, newSession.id),
            ).rejects.toThrow()

            const firstAfter = store.messages.getAllMessages(newSession.id)
                .find((message) => message.localId === 'message-rehome-first')
            const secondAfter = store.messages.getAllMessages(newSession.id)
                .find((message) => message.localId === 'message-rehome-second')
            const firstPath = (firstAfter?.content as { content?: { attachments?: Array<{ path: string }> } })
                .content?.attachments?.[0]?.path
            const secondPath = (secondAfter?.content as { content?: { attachments?: Array<{ path: string }> } })
                .content?.attachments?.[0]?.path

            expect(firstPath).toContain(`/${newSession.id}/`)
            expect(secondPath).toContain(`/${oldSession.id}/`)
        } finally {
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('does not re-home an invoked scheduled attachment after its Hub blob was released', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-message-rehome-consumed-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        try {
            const oldSession = store.sessions.getOrCreateSession(
                'message-rehome-consumed-old',
                { path: '/tmp/old', host: 'localhost' },
                null,
                'default',
            )
            const newSession = store.sessions.getOrCreateSession(
                'message-rehome-consumed-new',
                { path: '/tmp/new', host: 'localhost' },
                null,
                'default',
            )
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                oldSession.id,
                'consumed.png',
                'image/png',
                Buffer.from('consumed'),
            )
            const message = store.messages.addMessage(
                oldSession.id,
                {
                    role: 'user',
                    content: { type: 'text', text: 'already sent', attachments: [attachment] },
                },
                'message-rehome-consumed',
                Date.now() - 1_000,
            )
            store.messages.markMessagesInvoked(oldSession.id, [message.localId!], Date.now())

            const cleanup = new MessageService(
                store,
                {} as never,
                { emit() {} } as never,
                undefined,
                {
                    deleteScheduledAttachments: async (_sessionId, attachments) => {
                        await deleteScratchlistAttachmentFiles(hapiHome, attachments)
                    },
                },
            )
            await cleanup.releaseConsumedScheduledAttachments(oldSession.id, [message.localId!])

            const sourceMessages = store.messages.getAllMessages(oldSession.id)
            store.messages.mergeSessionMessages(oldSession.id, newSession.id)
            await expect(
                rehomeMessageAttachments(
                    store,
                    'default',
                    oldSession.id,
                    newSession.id,
                    sourceMessages,
                ),
            ).resolves.toBeUndefined()

            const moved = store.messages.getAllMessages(newSession.id)
            const movedAttachment = (moved[0]?.content as {
                content?: { attachments?: Array<{ path: string }> }
            }).content?.attachments?.[0]
            expect(movedAttachment?.path).toBe(attachment.path)
        } finally {
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('does not re-home a localId-collision loser after the merge force-invokes it', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-message-rehome-collision-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        try {
            const oldSession = store.sessions.getOrCreateSession(
                'message-rehome-collision-old',
                { path: '/tmp/old', host: 'localhost' },
                null,
                'default',
            )
            const newSession = store.sessions.getOrCreateSession(
                'message-rehome-collision-new',
                { path: '/tmp/new', host: 'localhost' },
                null,
                'default',
            )
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                oldSession.id,
                'collision.png',
                'image/png',
                Buffer.from('collision'),
            )
            store.messages.addMessage(
                oldSession.id,
                {
                    role: 'user',
                    content: { type: 'text', text: 'source', attachments: [attachment] },
                },
                'shared-local-id',
                Date.now() + 60_000,
            )
            store.messages.addMessage(
                newSession.id,
                { role: 'user', content: { type: 'text', text: 'target' } },
                'shared-local-id',
            )

            const sourceMessages = store.messages.getAllMessages(oldSession.id)
            const sourceMessageId = sourceMessages[0]!.id
            store.messages.mergeSessionMessages(oldSession.id, newSession.id)
            const sourceAfter = store.messages.getAllMessages(newSession.id)
                .find((message) => message.id === sourceMessageId)
            expect(sourceAfter).toBeDefined()
            expect(sourceAfter?.invokedAt).not.toBeNull()

            await expect(
                rehomeMessageAttachments(
                    store,
                    'default',
                    oldSession.id,
                    newSession.id,
                    sourceMessages,
                ),
            ).resolves.toBeUndefined()

            const mergedSource = store.messages.getAllMessages(newSession.id)
                .find((message) => message.id === sourceMessageId)
            const mergedAttachment = (mergedSource?.content as {
                content?: { attachments?: Array<{ path: string }> }
            }).content?.attachments?.[0]
            expect(mergedAttachment?.path).toBe(attachment.path)
        } finally {
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('preserves a source draft blob while re-homing its scheduled message', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-message-rehome-draft-ref-'))
        const previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHome
        const store = new Store(':memory:')
        try {
            const oldSession = store.sessions.getOrCreateSession(
                'message-rehome-draft-ref-old',
                { path: '/tmp/old', host: 'localhost' },
                null,
                'default',
            )
            const newSession = store.sessions.getOrCreateSession(
                'message-rehome-draft-ref-new',
                { path: '/tmp/new', host: 'localhost' },
                null,
                'default',
            )
            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                'default',
                oldSession.id,
                'shared.png',
                'image/png',
                Buffer.from('shared'),
            )
            store.scratchlist.create(oldSession.id, 'draft remains', {
                entryId: 'draft-ref',
                attachments: [attachment],
            })
            store.messages.addMessage(
                oldSession.id,
                {
                    role: 'user',
                    content: { type: 'text', text: 'scheduled message', attachments: [attachment] },
                },
                'message-rehome-draft-ref',
                Date.now() + 60_000,
            )

            const sourceMessages = store.messages.getAllMessages(oldSession.id)
            store.messages.mergeSessionMessages(oldSession.id, newSession.id)
            await rehomeMessageAttachments(
                store,
                'default',
                oldSession.id,
                newSession.id,
                sourceMessages,
            )

            const moved = store.messages.getAllMessages(newSession.id)[0]
            const movedAttachment = (moved?.content as {
                content?: { attachments?: Array<{ path: string }> }
            }).content?.attachments?.[0]
            expect(movedAttachment?.path).toContain(`/${newSession.id}/`)
            expect(await readScratchlistAttachmentFile(hapiHome, attachment.path)).not.toBeNull()
            expect(await readScratchlistAttachmentFile(hapiHome, movedAttachment!.path)).not.toBeNull()
            expect(store.scratchlist.get(oldSession.id, 'draft-ref')?.attachments[0]?.path)
                .toBe(attachment.path)
        } finally {
            store.close()
            if (previousHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = previousHome
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })
})
