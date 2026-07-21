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
}

export type RestoredUploadMetadata = {
    id: string
    path: string
    previewUrl?: string
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
    }
}

function toFile(file: StoredAttachment): File {
    const restored = new File([file.blob], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
    if (file.path) {
        restoredUploadMetadata.set(restored, {
            id: file.id,
            path: file.path,
            previewUrl: file.previewUrl,
        })
    }
    return restored
}

async function writeDraft(record: StoredAttachmentDraft | null, sessionId: string): Promise<void> {
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

function setCachedFiles(sessionId: string, files: File[]): void {
    cache.delete(sessionId)
    cache.set(sessionId, files)
    while (cache.size > MAX_DRAFTS) {
        const oldest = cache.keys().next().value as string | undefined
        if (!oldest) break
        cache.delete(oldest)
    }
}

export async function getDraftAttachments(sessionId: string): Promise<File[]> {
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
    } catch {
        return []
    }
}

export function saveDraftAttachments(sessionId: string, attachments: AttachmentDraftInput[]): void {
    if (attachments.length === 0) {
        cache.delete(sessionId)
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

export function clearDraftAttachments(sessionId: string): void {
    saveDraftAttachments(sessionId, [])
}

export function getRestoredUploadMetadata(file: File): RestoredUploadMetadata | undefined {
    return restoredUploadMetadata.get(file)
}
