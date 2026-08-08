const DB_NAME = 'hapi-composer-drafts'
const DB_VERSION = 1
const STORE = 'attachments'
const MAX_DRAFTS = 50

type StoredAttachment = {
    id: string
    name: string
    type: string
    lastModified: number
    blob: Blob
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

type StoredAttachmentDraft = {
    sessionId: string
    files: StoredAttachment[]
    updatedAt: number
}

const cache = new Map<string, File[]>()
const restoredUploadMetadata = new WeakMap<File, RestoredUploadMetadata>()
const pendingWrites = new Map<string, Promise<void>>()

export type AttachmentDraftInput = {
    id: string
    file: File
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

export type RestoredUploadMetadata = {
    id: string
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is unavailable'))
            return
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'sessionId' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Failed to open composer draft DB'))
    })
}

function copyFile(file: File): File {
    const copy = new File([file], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
    const metadata = restoredUploadMetadata.get(file)
    if (metadata) restoredUploadMetadata.set(copy, metadata)
    return copy
}

function toStoredFile(attachment: AttachmentDraftInput): StoredAttachment {
    const file = attachment.file
    return {
        id: attachment.id,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        blob: file,
        path: attachment.path,
        previewUrl: attachment.previewUrl,
        uploadSessionId: attachment.uploadSessionId,
    }
}

function toFile(file: StoredAttachment): File {
    const restored = new File([file.blob], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
    // Always retain the stored id so pathless pending picks (failed resume)
    // round-trip without inventing a synthetic id on the next persist pass.
    restoredUploadMetadata.set(restored, {
        id: file.id,
        path: file.path,
        previewUrl: file.previewUrl,
        uploadSessionId: file.uploadSessionId,
    })
    return restored
}

async function writeDraft(record: StoredAttachmentDraft | null, sessionId: string): Promise<void> {
    // No IndexedDB (tests / SSR): cache is already updated by the caller.
    if (typeof indexedDB === 'undefined') return
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        if (record) {
            store.put(record)
            const allRequest = store.getAll()
            allRequest.onsuccess = () => {
                const drafts = (allRequest.result as StoredAttachmentDraft[])
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                for (const stale of drafts.slice(MAX_DRAFTS)) {
                    store.delete(stale.sessionId)
                }
            }
        } else {
            store.delete(sessionId)
        }
        transaction.oncomplete = () => {
            db.close()
            resolve()
        }
        transaction.onerror = () => {
            db.close()
            reject(transaction.error ?? new Error('Composer draft transaction failed'))
        }
        transaction.onabort = transaction.onerror
    })
}

function queueWrite(record: StoredAttachmentDraft | null, sessionId: string): void {
    const previous = pendingWrites.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => writeDraft(record, sessionId))
    pendingWrites.set(sessionId, next)
    void next.catch(() => {}).finally(() => {
        if (pendingWrites.get(sessionId) === next) pendingWrites.delete(sessionId)
    })
}

async function awaitPendingWrites(...sessionIds: string[]): Promise<void> {
    const unique = [...new Set(sessionIds)]
    await Promise.all(unique.map(async (sessionId) => {
        const pending = pendingWrites.get(sessionId)
        // Propagate IndexedDB failures — same-target corrective writes must not
        // look durable when the queued transaction rejected.
        if (pending) await pending
    }))
}

function setCachedFiles(sessionId: string, files: File[]): void {
    cache.delete(sessionId)
    cache.set(sessionId, files)
    while (cache.size > MAX_DRAFTS) {
        const oldest = cache.keys().next().value as string | undefined
        if (!oldest) break
        cache.delete(oldest)
    }
}

export async function getDraftAttachments(
    sessionId: string,
    options: { throwOnError?: boolean } = {},
): Promise<File[]> {
    const cached = cache.get(sessionId)
    if (cached) return cached.map(copyFile)

    try {
        const db = await openDb()
        const record = await new Promise<StoredAttachmentDraft | undefined>((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readonly')
            const request = transaction.objectStore(STORE).get(sessionId)
            transaction.oncomplete = () => {
                db.close()
                resolve(request.result as StoredAttachmentDraft | undefined)
            }
            transaction.onerror = () => {
                db.close()
                reject(transaction.error ?? new Error('Composer draft transaction failed'))
            }
        })
        const files = record?.files.map(toFile) ?? []
        if (files.length > 0) setCachedFiles(sessionId, files)
        return files
    } catch (error) {
        if (options.throwOnError) throw error
        return []
    }
}

export function saveDraftAttachments(sessionId: string, attachments: AttachmentDraftInput[]): void {
    if (attachments.length === 0) {
        // Keep an empty cache entry as a tombstone until the queued IndexedDB
        // delete completes, so a fast remount cannot read and restore stale files.
        setCachedFiles(sessionId, [])
        queueWrite(null, sessionId)
        return
    }

    const storedFiles = attachments.map(toStoredFile)
    const copies = storedFiles.map(toFile)
    setCachedFiles(sessionId, copies)
    queueWrite({
        sessionId,
        files: storedFiles,
        updatedAt: Date.now(),
    }, sessionId)
}

/**
 * Atomically put the target draft and delete the source in one IndexedDB
 * transaction (after draining any queued writes). `resolveAttachments` runs
 * only after that drain so a mid-wait remove() is still honored.
 */
export async function moveDraftAttachments(
    sourceSessionId: string,
    targetSessionId: string,
    resolveAttachments: () => AttachmentDraftInput[],
): Promise<AttachmentDraftInput[]> {
    if (sourceSessionId === targetSessionId) {
        const attachments = resolveAttachments()
        saveDraftAttachments(targetSessionId, attachments)
        await awaitPendingWrites(targetSessionId)
        return attachments
    }

    await awaitPendingWrites(sourceSessionId, targetSessionId)

    // Re-sample after the drain — cancellation during awaitPendingWrites must win.
    const attachments = resolveAttachments()
    const storedFiles = attachments.map(toStoredFile)
    const copies = storedFiles.map(toFile)

    const previousSource = cache.has(sourceSessionId)
        ? (cache.get(sourceSessionId) ?? []).map(copyFile)
        : null
    const previousTarget = cache.has(targetSessionId)
        ? (cache.get(targetSessionId) ?? []).map(copyFile)
        : null

    setCachedFiles(targetSessionId, copies)
    // Tombstone the source immediately so unmount cleanup / remount cannot
    // re-read and re-persist the obsolete session id while the commit runs.
    setCachedFiles(sourceSessionId, [])

    // Environments without IndexedDB (tests / SSR) stay memory-only, matching
    // saveDraftAttachments. Real IDB open/transaction failures must not look durable.
    if (typeof indexedDB === 'undefined') {
        return attachments
    }

    const restoreCaches = () => {
        if (previousSource === null) {
            cache.delete(sourceSessionId)
        } else {
            setCachedFiles(sourceSessionId, previousSource)
        }
        if (previousTarget === null) {
            cache.delete(targetSessionId)
        } else {
            setCachedFiles(targetSessionId, previousTarget)
        }
    }

    try {
        const db = await openDb()
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite')
            const store = transaction.objectStore(STORE)
            // Delete the source before put/prune so a full 50-draft store does not
            // briefly look like 51 rows and evict an unrelated session.
            store.delete(sourceSessionId)
            if (attachments.length === 0) {
                store.delete(targetSessionId)
            } else {
                store.put({
                    sessionId: targetSessionId,
                    files: storedFiles,
                    updatedAt: Date.now(),
                })
                const allRequest = store.getAll()
                allRequest.onsuccess = () => {
                    const drafts = (allRequest.result as StoredAttachmentDraft[])
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                    for (const stale of drafts.slice(MAX_DRAFTS)) {
                        if (stale.sessionId === targetSessionId) continue
                        store.delete(stale.sessionId)
                    }
                }
            }
            transaction.oncomplete = () => {
                db.close()
                resolve()
            }
            transaction.onerror = () => {
                db.close()
                reject(transaction.error ?? new Error('Composer draft move failed'))
            }
            transaction.onabort = transaction.onerror
        })
        return attachments
    } catch (error) {
        restoreCaches()
        throw error instanceof Error ? error : new Error('Composer draft move failed')
    }
}

export function clearDraftAttachments(sessionId: string): void {
    saveDraftAttachments(sessionId, [])
}

export function getRestoredUploadMetadata(file: File): RestoredUploadMetadata | undefined {
    return restoredUploadMetadata.get(file)
}
