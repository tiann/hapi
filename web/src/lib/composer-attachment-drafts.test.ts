import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('composer-attachment-drafts', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', undefined)
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('keeps files available in memory when IndexedDB is unavailable', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['image bytes'], 'pasted.png', {
            type: 'image/png',
            lastModified: 123,
        })

        mod.saveDraftAttachments('session-1', [{ id: 'attachment-1', file }])
        const restored = await mod.getDraftAttachments('session-1')

        expect(restored).toHaveLength(1)
        expect(restored[0]).not.toBe(file)
        expect(restored[0]?.name).toBe('pasted.png')
        expect(restored[0]?.type).toBe('image/png')
        expect(restored[0]?.lastModified).toBe(123)
        expect(restored[0]?.size).toBe(file.size)
    })

    it('isolates attachment drafts by session', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-a', [{ id: 'a', file: new File(['a'], 'a.txt') }])
        mod.saveDraftAttachments('session-b', [{ id: 'b', file: new File(['b'], 'b.txt') }])

        expect((await mod.getDraftAttachments('session-a'))[0]?.name).toBe('a.txt')
        expect((await mod.getDraftAttachments('session-b'))[0]?.name).toBe('b.txt')
    })

    it('clears cached attachment drafts', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-1', [{ id: 'x', file: new File(['x'], 'x.txt') }])

        mod.clearDraftAttachments('session-1')

        expect(await mod.getDraftAttachments('session-1')).toEqual([])
    })

    it('does not read stale IndexedDB data while a clear is being persisted', async () => {
        const mod = await import('./composer-attachment-drafts')
        mod.saveDraftAttachments('session-1', [{ id: 'x', file: new File(['x'], 'x.txt') }])
        mod.clearDraftAttachments('session-1')
        await new Promise((resolve) => setTimeout(resolve, 0))

        const open = vi.fn(() => {
            throw new Error('cleared drafts must be served from the cache tombstone')
        })
        vi.stubGlobal('indexedDB', { open })

        expect(await mod.getDraftAttachments('session-1')).toEqual([])
        expect(open).not.toHaveBeenCalled()
    })

    it('retains completed upload metadata on restored files', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['image'], 'ready.png', { type: 'image/png' })
        mod.saveDraftAttachments('session-1', [{
            id: 'attachment-ready',
            file,
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        }])

        const [restored] = await mod.getDraftAttachments('session-1')

        expect(restored && mod.getRestoredUploadMetadata(restored)).toEqual({
            id: 'attachment-ready',
            path: '/uploads/ready.png',
            previewUrl: 'data:image/png;base64,aW1hZ2U=',
        })
    })

    it('retains stable ids for pathless pending files across persist passes', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['pending'], 'pending.txt')
        mod.saveDraftAttachments('session-1', [{ id: 'pending-1', file }])

        const [first] = await mod.getDraftAttachments('session-1')
        expect(first && mod.getRestoredUploadMetadata(first)?.id).toBe('pending-1')

        mod.saveDraftAttachments('session-1', [{
            id: mod.getRestoredUploadMetadata(first!)!.id,
            file: first!,
        }])
        const secondPass = await mod.getDraftAttachments('session-1')

        expect(secondPass).toHaveLength(1)
        expect(secondPass[0] && mod.getRestoredUploadMetadata(secondPass[0])?.id).toBe('pending-1')
    })

    it('moves attachments to the target and tombstones the source in cache', async () => {
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['payload'], 'notes.txt')
        mod.saveDraftAttachments('session-source', [{ id: 'a1', file }])

        await mod.moveDraftAttachments('session-source', 'session-target', () => [{ id: 'a1', file }])

        expect((await mod.getDraftAttachments('session-target')).map((item) => item.name)).toEqual(['notes.txt'])
        expect(await mod.getDraftAttachments('session-source')).toEqual([])
    })

    it('can surface IndexedDB read failures when throwOnError is set', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                const request: {
                    result: unknown
                    onsuccess: ((ev: unknown) => void) | null
                    onerror: ((ev: unknown) => void) | null
                    onupgradeneeded: ((ev: unknown) => void) | null
                    error: Error
                } = {
                    result: undefined,
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                    error: new Error('open failed'),
                }
                queueMicrotask(() => request.onerror?.({}))
                return request
            },
        })
        vi.resetModules()
        const mod = await import('./composer-attachment-drafts')

        await expect(mod.getDraftAttachments('session-1')).resolves.toEqual([])
        await expect(mod.getDraftAttachments('session-1', { throwOnError: true })).rejects.toThrow()
    })

    it('commits a put+delete move when IndexedDB is available', async () => {
        const store = new Map<string, unknown>()
        const fakeDb = {
            transaction(_name: string, _mode: string) {
                let pendingCallbacks = 0
                const finishLater = (cb: () => void) => {
                    pendingCallbacks += 1
                    queueMicrotask(() => {
                        cb()
                        pendingCallbacks -= 1
                        if (pendingCallbacks === 0) {
                            transaction.oncomplete?.({})
                        }
                    })
                }
                const objectStore = () => ({
                    put: (record: { sessionId: string }) => {
                        store.set(record.sessionId, record)
                    },
                    delete: (sessionId: string) => {
                        store.delete(sessionId)
                    },
                    getAll: () => {
                        const request: { onsuccess: ((ev: unknown) => void) | null; result?: unknown[] } = {
                            onsuccess: null,
                        }
                        finishLater(() => {
                            request.result = [...store.values()]
                            request.onsuccess?.({})
                        })
                        return request
                    },
                })
                const transaction = {
                    objectStore,
                    oncomplete: null as ((ev: unknown) => void) | null,
                    onerror: null as ((ev: unknown) => void) | null,
                    onabort: null as ((ev: unknown) => void) | null,
                }
                // If no async requests were scheduled, complete on next tick.
                queueMicrotask(() => {
                    if (pendingCallbacks === 0) transaction.oncomplete?.({})
                })
                return transaction
            },
            close() {},
        }
        vi.stubGlobal('indexedDB', {
            open: () => {
                const request: {
                    result: typeof fakeDb
                    onsuccess: ((ev: unknown) => void) | null
                    onerror: ((ev: unknown) => void) | null
                    onupgradeneeded: ((ev: unknown) => void) | null
                } = {
                    result: fakeDb,
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                }
                queueMicrotask(() => request.onsuccess?.({}))
                return request
            },
        })
        vi.resetModules()
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['payload'], 'notes.txt')
        mod.saveDraftAttachments('session-source', [{ id: 'a1', file }])
        await new Promise((resolve) => setTimeout(resolve, 0))

        await mod.moveDraftAttachments('session-source', 'session-target', () => [{ id: 'a1', file }])

        expect(store.has('session-target')).toBe(true)
        expect(store.has('session-source')).toBe(false)
        expect((await mod.getDraftAttachments('session-target')).map((item) => item.name)).toEqual(['notes.txt'])
        expect(await mod.getDraftAttachments('session-source')).toEqual([])
    })

    it('does not prune an unrelated draft when moving at the retention cap', async () => {
        const store = new Map<string, { sessionId: string; updatedAt: number; files: unknown[] }>()
        const fakeDb = {
            transaction(_name: string, _mode: string) {
                let pendingCallbacks = 0
                const finishLater = (cb: () => void) => {
                    pendingCallbacks += 1
                    queueMicrotask(() => {
                        cb()
                        pendingCallbacks -= 1
                        if (pendingCallbacks === 0) transaction.oncomplete?.({})
                    })
                }
                const objectStore = () => ({
                    put: (record: { sessionId: string; updatedAt: number; files: unknown[] }) => {
                        store.set(record.sessionId, record)
                    },
                    delete: (sessionId: string) => {
                        store.delete(sessionId)
                    },
                    getAll: () => {
                        const request: { onsuccess: ((ev: unknown) => void) | null; result?: unknown[] } = {
                            onsuccess: null,
                        }
                        finishLater(() => {
                            request.result = [...store.values()]
                            request.onsuccess?.({})
                        })
                        return request
                    },
                })
                const transaction = {
                    objectStore,
                    oncomplete: null as ((ev: unknown) => void) | null,
                    onerror: null as ((ev: unknown) => void) | null,
                    onabort: null as ((ev: unknown) => void) | null,
                }
                queueMicrotask(() => {
                    if (pendingCallbacks === 0) transaction.oncomplete?.({})
                })
                return transaction
            },
            close() {},
        }
        vi.stubGlobal('indexedDB', {
            open: () => {
                const request: {
                    result: typeof fakeDb
                    onsuccess: ((ev: unknown) => void) | null
                    onerror: ((ev: unknown) => void) | null
                    onupgradeneeded: ((ev: unknown) => void) | null
                } = {
                    result: fakeDb,
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                }
                queueMicrotask(() => request.onsuccess?.({}))
                return request
            },
        })
        vi.resetModules()
        const mod = await import('./composer-attachment-drafts')

        // Fill the retention cap with 49 unrelated drafts + the source (50 total).
        // Source is mid-range by updatedAt so it is not the oldest entry.
        for (let i = 0; i < 49; i++) {
            store.set(`keep-${i}`, {
                sessionId: `keep-${i}`,
                updatedAt: i + 1,
                files: [],
            })
        }
        const file = new File(['payload'], 'notes.txt')
        mod.saveDraftAttachments('session-source', [{ id: 'a1', file }])
        store.set('session-source', {
            sessionId: 'session-source',
            updatedAt: 25,
            files: [{ id: 'a1', name: 'notes.txt', type: '', lastModified: 0, blob: file }],
        })
        expect(store.size).toBe(50)
        await new Promise((resolve) => setTimeout(resolve, 0))

        await mod.moveDraftAttachments('session-source', 'session-target', () => [{ id: 'a1', file }])

        expect(store.has('session-target')).toBe(true)
        expect(store.has('session-source')).toBe(false)
        expect(store.has('keep-0')).toBe(true)
        expect(store.size).toBe(50)
    })

    it('rolls cache back and throws when the IndexedDB move transaction fails', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                const request: {
                    result: {
                        transaction: () => {
                            objectStore: () => {
                                put: () => void
                                delete: () => void
                                getAll: () => { onsuccess: null }
                            }
                            oncomplete: null
                            onerror: ((ev: unknown) => void) | null
                            onabort: null
                            error: Error
                        }
                        close: () => void
                    }
                    onsuccess: ((ev: unknown) => void) | null
                    onerror: ((ev: unknown) => void) | null
                    onupgradeneeded: ((ev: unknown) => void) | null
                } = {
                    result: {
                        transaction: () => {
                            const transaction = {
                                objectStore: () => ({
                                    put: () => {},
                                    delete: () => {},
                                    getAll: () => ({ onsuccess: null }),
                                }),
                                oncomplete: null,
                                onerror: null as ((ev: unknown) => void) | null,
                                onabort: null,
                                error: new Error('quota exceeded'),
                            }
                            queueMicrotask(() => transaction.onerror?.({}))
                            return transaction
                        },
                        close: () => {},
                    },
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                }
                queueMicrotask(() => request.onsuccess?.({}))
                return request
            },
        })
        vi.resetModules()
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['payload'], 'notes.txt')
        mod.saveDraftAttachments('session-source', [{ id: 'a1', file }])

        await expect(mod.moveDraftAttachments(
            'session-source',
            'session-target',
            () => [{ id: 'a1', file }],
        )).rejects.toThrow(/quota exceeded|Composer draft move failed/)

        expect((await mod.getDraftAttachments('session-source')).map((item) => item.name)).toEqual(['notes.txt'])
        expect(await mod.getDraftAttachments('session-target')).toEqual([])
    })

    it('propagates a rejected same-target queued write instead of treating it as durable', async () => {
        let failNextWrite = false
        vi.stubGlobal('indexedDB', {
            open: () => {
                const request: {
                    result: {
                        transaction: () => {
                            objectStore: () => {
                                put: (record: { sessionId: string }) => void
                                delete: (sessionId: string) => void
                                getAll: () => { onsuccess: null; result?: unknown[] }
                            }
                            oncomplete: ((ev: unknown) => void) | null
                            onerror: ((ev: unknown) => void) | null
                            onabort: null
                            error: Error | null
                        }
                        close: () => void
                    }
                    onsuccess: ((ev: unknown) => void) | null
                    onerror: ((ev: unknown) => void) | null
                    onupgradeneeded: ((ev: unknown) => void) | null
                } = {
                    result: {
                        transaction: () => {
                            const transaction = {
                                objectStore: () => ({
                                    put: () => {},
                                    delete: () => {},
                                    getAll: () => ({ onsuccess: null, result: [] as unknown[] }),
                                }),
                                oncomplete: null as ((ev: unknown) => void) | null,
                                onerror: null as ((ev: unknown) => void) | null,
                                onabort: null,
                                error: null as Error | null,
                            }
                            queueMicrotask(() => {
                                if (failNextWrite) {
                                    transaction.error = new Error('quota exceeded')
                                    transaction.onerror?.({})
                                    return
                                }
                                transaction.oncomplete?.({})
                            })
                            return transaction
                        },
                        close: () => {},
                    },
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                }
                queueMicrotask(() => request.onsuccess?.({}))
                return request
            },
        })
        vi.resetModules()
        const mod = await import('./composer-attachment-drafts')
        const file = new File(['payload'], 'notes.txt')
        failNextWrite = true

        await expect(mod.moveDraftAttachments(
            'session-target',
            'session-target',
            () => [{ id: 'a1', file }],
        )).rejects.toThrow(/quota exceeded|Composer draft/)
    })
})
