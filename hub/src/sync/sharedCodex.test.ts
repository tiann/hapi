import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function fixture() {
    const attachmentsRoot = mkdtempSync(join(tmpdir(), 'hapi-shared-codex-'))
    const store = new Store(':memory:', { attachmentsRoot })
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const metadata: Metadata = { path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const create = (name: string, more: Partial<Metadata> = {}, ready = true) => {
        const session = engine.getOrCreateSession(name, { ...metadata, codexSessionId: `native-${name}`, ...more }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        if (ready) engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    return {
        store,
        engine,
        create,
        rpc: (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway,
        cleanup: () => {
            engine.stop()
            store.close()
            rmSync(attachmentsRoot, { recursive: true, force: true })
        }
    }
}

describe('shared Codex hub binding', () => {
    it('guards plan actions by namespace and runtime, leaving stale-plan and retry validation to CLI', async () => {
        const f = fixture()
        try {
            const source = f.create('source')
            const unsupported = f.create('other', { flavor: 'claude' })
            const calls: string[][] = []
            f.rpc.implementCodexPlan = async (...args) => { calls.push(args); return { ok: true } }
            expect(await f.engine.implementCodexPlan(source.id, 'other-namespace', 'plan')).toMatchObject({ ok: false })
            expect(await f.engine.implementCodexPlan(unsupported.id, 'default', 'plan')).toMatchObject({ ok: false })
            expect(calls).toHaveLength(0)
            // The hub can lag the native plan state, including after an accepted action's lost reply.
            expect(await f.engine.implementCodexPlan(source.id, 'default', 'plan')).toEqual({ ok: true })
            expect(calls).toEqual([[source.id, 'plan']])
        } finally { f.cleanup() }
    })

    it('uses the already-bound fork child without spawning a second engine', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const child = f.create('child', { forkedFrom: source.id })
            f.rpc.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })
            expect(await f.engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: child.id })
            expect(f.engine.getSession(source.id)?.metadata?.codexSessionId).toBe('native-source')
        } finally { f.cleanup() }
    })
    it('clear returns a new root without superseding other clients and mode switching is inapplicable', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const child = f.create('child')
            f.rpc.clearConversation = async () => ({ sessionId: child.id })
            expect(await f.engine.clearConversation(source.id, 'default')).toEqual({ sessionId: child.id })
            expect(f.engine.getSession(source.id)?.metadata?.supersededBySessionId).toBeUndefined()
            await expect(f.engine.switchSession(source.id, 'remote')).rejects.toThrow('control_mode_not_applicable')
            await expect(f.engine.clearConversation(source.id, 'other-namespace')).rejects.toThrow()
        } finally { f.cleanup() }
    })

    it('clones durable attachments into an already-bound shared fork child', async () => {
        const f = fixture()
        try {
            const source = f.create('source')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'document.txt',
                mimeType: 'text/plain',
                original: Buffer.from('shared fork original')
            })
            const sourceContent = {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'inspect this document',
                    attachments: [{
                        id: 'message-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                },
                meta: { sentFrom: 'webapp' }
            }
            f.store.messages.addMessage(source.id, sourceContent, 'shared-attachment-local-id')
            f.store.messages.markMessagesInvoked(source.id, ['shared-attachment-local-id'], Date.now())
            const child = f.create('child', { forkedFrom: source.id }, false)

            // SharedCodexProjection may have already emitted the child turn as
            // text by the time the Hub receives the fork response.
            f.store.messages.addMessage(child.id, {
                role: 'user',
                content: { type: 'text', text: sourceContent.content.text },
                meta: { sentFrom: 'cli' }
            }, 'shared-attachment-local-id')
            f.store.messages.markMessagesInvoked(child.id, ['shared-attachment-local-id'], Date.now())
            f.rpc.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })

            const result = await f.engine.forkConversation(source.id, 'default')
            expect(result).toEqual({ type: 'success', sessionId: child.id })
            const childMessage = f.store.messages.getAllMessages(child.id)
                .find((message) => message.localId === 'shared-attachment-local-id')
            const clonedId = ((childMessage?.content as typeof sourceContent).content.attachments?.[0]).attachmentId
            expect(clonedId).toBeDefined()
            expect(clonedId).not.toBe(attachment.id)
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('shared fork original'))
            expect((await f.store.attachments.readForSessionAsync(attachment.id, 'default', source.id))?.data)
                .toEqual(Buffer.from('shared fork original'))

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)
            expect(f.store.attachments.getForSession(attachment.id, 'default', source.id)).toBeNull()
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('shared fork original'))
        } finally {
            f.cleanup()
        }
    })

    it('hydrates durable attachments when a native shared fork child becomes ready', async () => {
        const f = fixture()
        try {
            const source = f.create('native-source')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'native-fork.txt',
                mimeType: 'text/plain',
                original: Buffer.from('native fork original')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'native fork attachment',
                    attachments: [{
                        id: 'native-message-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                },
                meta: { sentFrom: 'webapp' }
            }, 'native-fork-local-id')
            f.store.messages.markMessagesInvoked(source.id, ['native-fork-local-id'], Date.now())
            const child = f.create('native-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'native-fork-local-id'
            }, false)
            f.store.messages.addMessage(child.id, {
                role: 'user',
                content: { type: 'text', text: 'native fork attachment' },
                meta: { sentFrom: 'cli' }
            }, 'native-fork-local-id')
            f.store.messages.markMessagesInvoked(child.id, ['native-fork-local-id'], Date.now())

            const events: Array<{ type: string; sessionId?: string }> = []
            const unsubscribe = f.engine.subscribe((event) => {
                events.push(event)
            })
            f.engine.handleSessionReady({ sid: child.id, time: Date.now() })
            let clonedId: string | undefined
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const message = f.store.messages.getAllMessages(child.id)
                    .find((candidate) => candidate.localId === 'native-fork-local-id')
                const messageContent = message?.content as {
                    content?: { attachments?: Array<{ attachmentId?: string }> }
                } | undefined
                const candidate = messageContent?.content?.attachments?.[0]?.attachmentId
                if (candidate && f.store.attachments.getForSession(candidate, 'default', child.id)) {
                    clonedId = candidate
                    break
                }
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            expect(clonedId).toBeDefined()
            expect(clonedId).not.toBe(attachment.id)
            expect(events).toContainEqual(expect.objectContaining({
                type: 'messages-invalidated',
                sessionId: child.id
            }))
            unsubscribe()

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('native fork original'))
        } finally {
            f.cleanup()
        }
    })

    it('waits for parent shared-fork hydration before hydrating a nested child', async () => {
        const f = fixture()
        let releaseClone: (() => void) | undefined
        let restoreClone: (() => void) | undefined
        try {
            const source = f.create('nested-source')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'nested.txt',
                mimeType: 'text/plain',
                original: Buffer.from('nested original')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'nested attachment',
                    attachments: [{
                        id: 'nested-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            }, 'nested-tip')
            f.store.messages.markMessagesInvoked(source.id, ['nested-tip'], Date.now())

            let signalCloneStarted!: () => void
            const cloneStarted = new Promise<void>((resolve) => { signalCloneStarted = resolve })
            const cloneGate = new Promise<void>((resolve) => { releaseClone = resolve })
            const originalClone = f.store.attachments.cloneMessageAttachments.bind(f.store.attachments)
            const cloneSpy = spyOn(f.store.attachments, 'cloneMessageAttachments').mockImplementation(async (...args) => {
                signalCloneStarted()
                await cloneGate
                return await originalClone(...args)
            })
            restoreClone = () => cloneSpy.mockRestore()

            const first = f.create('nested-first', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'nested-tip'
            }, false)
            const firstHydration = (f.engine as any).ensureSharedForkAttachments(
                source.id,
                'default',
                first.id,
                undefined,
                'nested-tip'
            ) as Promise<void>
            await cloneStarted

            const second = f.create('nested-second', {
                forkedFrom: first.id,
                forkedThroughMessageLocalId: 'nested-tip'
            }, false)
            const secondHydration = (f.engine as any).ensureSharedForkAttachments(
                first.id,
                'default',
                second.id,
                undefined,
                'nested-tip'
            ) as Promise<void>
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(cloneSpy).toHaveBeenCalledTimes(1)

            releaseClone?.()
            await firstHydration
            await secondHydration

            const firstAttachmentId = ((f.store.messages.getAllMessages(first.id)[0]?.content as any)
                ?.content?.attachments?.[0]?.attachmentId) as string | undefined
            const secondAttachmentId = ((f.store.messages.getAllMessages(second.id)[0]?.content as any)
                ?.content?.attachments?.[0]?.attachmentId) as string | undefined
            expect(firstAttachmentId).toBeDefined()
            expect(secondAttachmentId).toBeDefined()
            expect(secondAttachmentId).not.toBe(firstAttachmentId)
            expect((await f.store.attachments.readForSessionAsync(
                secondAttachmentId!, 'default', second.id
            ))?.data).toEqual(Buffer.from('nested original'))
        } finally {
            releaseClone?.()
            restoreClone?.()
            f.cleanup()
        }
    })

    it('keeps a historical shared fork boundary after the child reconnects', async () => {
        const f = fixture()
        try {
            const source = f.create('boundary-source')
            const beforeAttachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'before.txt',
                mimeType: 'text/plain',
                original: Buffer.from('before fork')
            })
            const afterAttachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'after.txt',
                mimeType: 'text/plain',
                original: Buffer.from('after fork')
            })
            const addSourceMessage = (localId: string, text: string, attachmentId: string) => {
                f.store.messages.addMessage(source.id, {
                    role: 'user',
                    content: {
                        type: 'text',
                        text,
                        attachments: [{
                            id: `${localId}-attachment`,
                            filename: localId,
                            mimeType: 'text/plain',
                            size: 1,
                            attachmentId
                        }]
                    },
                    meta: { sentFrom: 'webapp' }
                }, localId)
                f.store.messages.markMessagesInvoked(source.id, [localId], Date.now())
            }
            addSourceMessage('before-fork', 'before', beforeAttachment.id)
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: { type: 'text', text: 'boundary' },
                meta: { sentFrom: 'webapp' }
            }, 'fork-boundary')
            f.store.messages.markMessagesInvoked(source.id, ['fork-boundary'], Date.now())
            addSourceMessage('after-fork', 'after', afterAttachment.id)

            const child = f.create('boundary-child', {
                forkedFrom: source.id,
                forkedAtMessageLocalId: 'fork-boundary'
            }, false)
            f.engine.handleSessionReady({ sid: child.id, time: Date.now() })
            let clonedId: string | undefined
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const message = f.store.messages.getAllMessages(child.id)
                    .find((candidate) => candidate.localId === 'before-fork')
                const messageContent = message?.content as {
                    content?: { attachments?: Array<{ attachmentId?: string }> }
                } | undefined
                const candidate = messageContent?.content?.attachments?.[0]?.attachmentId
                if (candidate && f.store.attachments.getForSession(candidate, 'default', child.id)) {
                    clonedId = candidate
                    break
                }
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            expect(clonedId).toBeDefined()
            expect(f.store.messages.getAllMessages(child.id)
                .some((message) => message.localId === 'after-fork')).toBe(false)

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('before fork'))
            expect(f.store.attachments.getForSession(afterAttachment.id, 'default', source.id)).toBeNull()
        } finally {
            f.cleanup()
        }
    })

    it('keeps a current-tip shared fork boundary after the child reconnects', async () => {
        const f = fixture()
        try {
            const source = f.create('current-tip-source')
            const beforeAttachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'before-current-tip.txt',
                mimeType: 'text/plain',
                original: Buffer.from('before current tip')
            })
            const afterAttachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'after-current-tip.txt',
                mimeType: 'text/plain',
                original: Buffer.from('after current tip')
            })
            const addSourceMessage = (localId: string, text: string, attachmentId: string) => {
                f.store.messages.addMessage(source.id, {
                    role: 'user',
                    content: {
                        type: 'text',
                        text,
                        attachments: [{
                            id: `${localId}-attachment`,
                            filename: localId,
                            mimeType: 'text/plain',
                            size: 1,
                            attachmentId
                        }]
                    },
                    meta: { sentFrom: 'webapp' }
                }, localId)
                f.store.messages.markMessagesInvoked(source.id, [localId], Date.now())
            }
            addSourceMessage('before-tip', 'before', beforeAttachment.id)
            addSourceMessage('after-tip', 'after', afterAttachment.id)

            const child = f.create('current-tip-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'before-tip'
            }, false)
            f.engine.handleSessionReady({ sid: child.id, time: Date.now() })
            let clonedId: string | undefined
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const message = f.store.messages.getAllMessages(child.id)
                    .find((candidate) => candidate.localId === 'before-tip')
                const messageContent = message?.content as {
                    content?: { attachments?: Array<{ attachmentId?: string }> }
                } | undefined
                const candidate = messageContent?.content?.attachments?.[0]?.attachmentId
                if (candidate && f.store.attachments.getForSession(candidate, 'default', child.id)) {
                    clonedId = candidate
                    break
                }
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            expect(clonedId).toBeDefined()
            expect(clonedId).not.toBe(beforeAttachment.id)
            expect(f.store.messages.getAllMessages(child.id)
                .some((message) => message.localId === 'after-tip')).toBe(false)
            expect(f.store.attachments.getForSession(afterAttachment.id, 'default', child.id)).toBeNull()

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('before current tip'))
        } finally {
            f.cleanup()
        }
    })

    it('keeps an empty current-tip fork bounded before later parent messages', async () => {
        const f = fixture()
        try {
            const source = f.create('empty-current-tip-source')
            const child = f.create('empty-current-tip-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: ''
            }, false)
            f.engine.handleSessionReady({ sid: child.id, time: Date.now() })

            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'after-empty-tip.txt',
                mimeType: 'text/plain',
                original: Buffer.from('after empty tip')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'after empty tip',
                    attachments: [{
                        id: 'after-empty-tip-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                },
                meta: { sentFrom: 'webapp' }
            }, 'after-empty-tip')
            f.store.messages.markMessagesInvoked(source.id, ['after-empty-tip'], Date.now())
            await new Promise((resolve) => setTimeout(resolve, 20))

            expect(f.store.messages.getAllMessages(child.id)).toHaveLength(0)
            expect(f.store.attachments.getForSession(attachment.id, 'default', child.id)).toBeNull()
        } finally {
            f.cleanup()
        }
    })

    it('clears failed attachment hydration bookkeeping when a fork child is removed', async () => {
        const f = fixture()
        try {
            const source = f.create('failed-hydration-source')
            const child = f.create('failed-hydration-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'missing-tip'
            }, false)
            await expect((f.engine as any).ensureSharedForkAttachments(
                source.id, 'default', child.id, undefined, 'missing-tip'
            )).rejects.toThrow('Fork tip boundary message not found')

            const cachedChild = f.engine.getSession(child.id)
            if (cachedChild) cachedChild.active = false
            await f.engine.deleteSession(child.id)
            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await expect(f.engine.deleteSession(source.id)).resolves.toBeUndefined()
        } finally {
            f.cleanup()
        }
    })

    it('retains failed hydration protection until child deletion succeeds', async () => {
        const f = fixture()
        let restoreDelete: (() => void) | undefined
        try {
            const source = f.create('failed-deletion-source')
            const child = f.create('failed-deletion-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'missing-tip'
            }, false)
            await expect((f.engine as any).ensureSharedForkAttachments(
                source.id, 'default', child.id, undefined, 'missing-tip'
            )).rejects.toThrow('Fork tip boundary message not found')

            const cache = (f.engine as any).sessionCache
            const originalDelete = cache.deleteSession.bind(cache)
            let failDeletion = true
            cache.deleteSession = async (sessionId: string) => {
                if (failDeletion && sessionId === child.id) {
                    throw new Error('simulated child deletion failure')
                }
                return await originalDelete(sessionId)
            }
            restoreDelete = () => { cache.deleteSession = originalDelete }

            const cachedChild = f.engine.getSession(child.id)
            if (cachedChild) cachedChild.active = false
            await expect(f.engine.deleteSession(child.id)).rejects.toThrow('simulated child deletion failure')
            expect(f.engine.getSession(child.id)).toBeDefined()

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await expect(f.engine.deleteSession(source.id)).rejects.toThrow('Fork tip boundary message not found')

            failDeletion = false
            await expect(f.engine.deleteSession(child.id)).resolves.toBeUndefined()
            await expect(f.engine.deleteSession(source.id)).resolves.toBeUndefined()
        } finally {
            restoreDelete?.()
            f.cleanup()
        }
    })

    it('clears hydration failures after external child deletion finalization', async () => {
        const f = fixture()
        try {
            const source = f.create('externally-finalized-source')
            const child = f.create('externally-finalized-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'missing-tip'
            }, false)
            await expect((f.engine as any).ensureSharedForkAttachments(
                source.id, 'default', child.id, undefined, 'missing-tip'
            )).rejects.toThrow('Fork tip boundary message not found')

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            expect(f.store.sessions.deleteSession(child.id, 'default')).toBe(true)
            f.engine.finalizeDeletedSession(child.id, 'default')
            await expect(f.engine.deleteSession(source.id)).resolves.toBeUndefined()
        } finally {
            f.cleanup()
        }
    })

    it('settles child hydration before deleting an inactive shared fork child', async () => {
        const f = fixture()
        let releaseClone: (() => void) | undefined
        let restoreClone: (() => void) | undefined
        try {
            const source = f.create('settle-target-source')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'settle-target.txt',
                mimeType: 'text/plain',
                original: Buffer.from('settle target original')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'settle target',
                    attachments: [{
                        id: 'settle-target-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            }, 'settle-target-tip')
            f.store.messages.markMessagesInvoked(source.id, ['settle-target-tip'], Date.now())
            const child = f.create('settle-target-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'settle-target-tip',
                capabilities: { concurrentClients: false }
            }, false)
            const storedChild = f.store.sessions.getSession(child.id)
            if (!storedChild?.metadata) throw new Error('Missing child metadata')
            f.store.sessions.updateSessionMetadata(
                child.id,
                { ...storedChild.metadata, capabilities: { concurrentClients: true } },
                storedChild.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            ;(f.engine as any).sessionCache.refreshSession(child.id)
            const cachedChild = f.engine.getSession(child.id)
            if (cachedChild) cachedChild.active = false

            let signalCloneStarted!: () => void
            const cloneStarted = new Promise<void>((resolve) => { signalCloneStarted = resolve })
            const cloneGate = new Promise<void>((resolve) => { releaseClone = resolve })
            const originalClone = f.store.attachments.cloneMessageAttachments.bind(f.store.attachments)
            const cloneSpy = spyOn(f.store.attachments, 'cloneMessageAttachments').mockImplementation(async (...args) => {
                signalCloneStarted()
                await cloneGate
                return await originalClone(...args)
            })
            restoreClone = () => cloneSpy.mockRestore()

            const hydration = (f.engine as any).ensureSharedForkAttachments(
                source.id,
                'default',
                child.id,
                undefined,
                'settle-target-tip'
            ) as Promise<void>
            await cloneStarted
            const deletion = f.engine.deleteSession(child.id)
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(f.store.sessions.getSessionByNamespace(child.id, 'default')).not.toBeNull()
            releaseClone?.()
            await hydration
            await deletion
            restoreClone?.()
            restoreClone = undefined

            expect(f.store.sessions.getSessionByNamespace(child.id, 'default')).toBeNull()
            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await expect(f.engine.deleteSession(source.id)).resolves.toBeUndefined()
        } finally {
            releaseClone?.()
            restoreClone?.()
            f.cleanup()
        }
    })

    it('protects shared-fork attachments during automatic session consolidation', async () => {
        const f = fixture()
        try {
            const source = f.create('automatic-merge-source')
            const target = f.create('automatic-merge-target')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'automatic-merge.txt',
                mimeType: 'text/plain',
                original: Buffer.from('automatic merge original')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'automatic merge source',
                    attachments: [{
                        id: 'automatic-merge-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            }, 'automatic-merge-tip')
            f.store.messages.markMessagesInvoked(source.id, ['automatic-merge-tip'], Date.now())
            const child = f.create('automatic-merge-child', {
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'automatic-merge-tip',
                capabilities: { concurrentClients: false }
            }, false)
            const storedChild = f.store.sessions.getSession(child.id)
            if (!storedChild?.metadata) throw new Error('Missing child metadata')
            f.store.sessions.updateSessionMetadata(
                child.id,
                { ...storedChild.metadata, capabilities: { concurrentClients: true } },
                storedChild.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            ;(f.engine as any).sessionCache.refreshSession(child.id)
            for (const sessionId of [source.id, target.id, child.id]) {
                const cached = f.engine.getSession(sessionId)
                if (cached) cached.active = false
            }

            const cache = (f.engine as any).sessionCache
            await cache.mergeSessions(source.id, target.id, 'default')

            const childMessage = f.store.messages.getAllMessages(child.id)
                .find((message) => message.localId === 'automatic-merge-tip')
            const childAttachmentId = ((childMessage?.content as {
                content?: { attachments?: Array<{ attachmentId?: string }> }
            } | undefined)?.content?.attachments?.[0]?.attachmentId)
            expect(childAttachmentId).toBeDefined()
            expect(childAttachmentId).not.toBe(attachment.id)
            expect((await f.store.attachments.readForSessionAsync(
                childAttachmentId!,
                'default',
                child.id
            ))?.data).toEqual(Buffer.from('automatic merge original'))
            expect(f.store.attachments.getForSession(attachment.id, 'default', source.id)).toBeNull()
            expect(f.store.attachments.getForSession(attachment.id, 'default', target.id)).not.toBeNull()
        } finally {
            f.cleanup()
        }
    })

    it('rebuilds restart-safe fork hydration protection before deleting a source', async () => {
        const f = fixture()
        try {
            const source = f.create('restart-protection-source')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: source.id,
                filename: 'restart-protection.txt',
                mimeType: 'text/plain',
                original: Buffer.from('restart-protection')
            })
            f.store.messages.addMessage(source.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'restart protection',
                    attachments: [{
                        id: 'restart-protection-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            }, 'restart-protection-tip')
            f.store.messages.markMessagesInvoked(source.id, ['restart-protection-tip'], Date.now())

            // Simulate a Hub restart: the child row is durable, but no child
            // alive/ready event has rebuilt the in-memory hydration promise.
            const child = f.engine.getOrCreateSession('restart-protection-child', {
                ...((source.metadata ?? {}) as Record<string, unknown>),
                forkedFrom: source.id,
                forkedThroughMessageLocalId: 'restart-protection-tip'
            }, null, 'default')
            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)

            const childMessage = f.store.messages.getAllMessages(child.id)
                .find((message) => message.localId === 'restart-protection-tip')
            const clonedId = ((childMessage?.content as any)?.content?.attachments?.[0] as any)?.attachmentId
            expect(clonedId).toBeDefined()
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('restart-protection'))
        } finally {
            f.cleanup()
        }
    })

    it('preserves completed nested hydration after ancestor deletion and restart', async () => {
        const f = fixture()
        let restarted: SyncEngine | undefined
        try {
            const ancestor = f.create('restart-ancestor')
            const attachment = await f.store.attachments.create({
                namespace: 'default',
                sessionId: ancestor.id,
                filename: 'restart-chain.txt',
                mimeType: 'text/plain',
                original: Buffer.from('restart chain original')
            })
            f.store.messages.addMessage(ancestor.id, {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'restart chain',
                    attachments: [{
                        id: 'restart-chain-attachment',
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        attachmentId: attachment.id
                    }]
                }
            }, 'restart-chain-tip')
            f.store.messages.markMessagesInvoked(ancestor.id, ['restart-chain-tip'], Date.now())

            const child = f.create('restart-chain-child', {
                forkedFrom: ancestor.id,
                forkedThroughMessageLocalId: 'restart-chain-tip'
            }, false)
            await (f.engine as any).ensureSharedForkAttachments(
                ancestor.id,
                'default',
                child.id,
                undefined,
                'restart-chain-tip'
            )
            expect(((f.store.sessions.getSession(child.id)?.metadata ?? null) as Metadata | null)
                ?.sharedForkAttachmentsHydrated).toBe(true)

            const cachedAncestor = f.engine.getSession(ancestor.id)
            if (cachedAncestor) cachedAncestor.active = false
            await f.engine.deleteSession(ancestor.id)
            expect(f.store.sessions.getSession(child.id)).toBeDefined()

            f.engine.stop()
            restarted = new SyncEngine(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            await expect((restarted as any).ensureSharedForkAttachments(
                ancestor.id,
                'default',
                child.id,
                undefined,
                'restart-chain-tip'
            )).resolves.toBeUndefined()
            const childMetadata = { ...(restarted.getSession(child.id)?.metadata ?? {}) }
            delete (childMetadata as any).sharedForkAttachmentsHydrated
            const grandchild = restarted.getOrCreateSession('restart-chain-grandchild', {
                ...childMetadata,
                forkedFrom: child.id,
                forkedThroughMessageLocalId: 'restart-chain-tip'
            }, null, 'default')
            const hydration = (restarted as any).ensureSharedForkAttachments(
                child.id,
                'default',
                grandchild.id,
                undefined,
                'restart-chain-tip'
            ) as Promise<void>
            await hydration

            const grandchildMessage = f.store.messages.getAllMessages(grandchild.id)
                .find((message) => message.localId === 'restart-chain-tip')
            const grandchildAttachmentId = ((grandchildMessage?.content as any)
                ?.content?.attachments?.[0] as any)?.attachmentId as string | undefined
            expect(grandchildAttachmentId).toBeDefined()
            expect((await f.store.attachments.readForSessionAsync(
                grandchildAttachmentId!, 'default', grandchild.id
            ))?.data).toEqual(Buffer.from('restart chain original'))

            const cachedChild = restarted.getSession(child.id)
            if (cachedChild) cachedChild.active = false
            await restarted.deleteSession(child.id)
            expect((await f.store.attachments.readForSessionAsync(
                grandchildAttachmentId!, 'default', grandchild.id
            ))?.data).toEqual(Buffer.from('restart chain original'))
        } finally {
            restarted?.stop()
            f.cleanup()
        }
    })
})
