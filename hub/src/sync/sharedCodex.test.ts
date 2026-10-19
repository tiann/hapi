import { describe, expect, it } from 'bun:test'
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

            const cachedSource = f.engine.getSession(source.id)
            if (cachedSource) cachedSource.active = false
            await f.engine.deleteSession(source.id)
            expect((await f.store.attachments.readForSessionAsync(clonedId!, 'default', child.id))?.data)
                .toEqual(Buffer.from('native fork original'))
        } finally {
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
})
