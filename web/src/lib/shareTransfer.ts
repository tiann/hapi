/**
 * Share-target transfer storage.
 *
 * Android Chrome's Web Share Target API delivers a multipart POST to
 * /share. The service worker can't hand the resulting Blob objects to the
 * SPA via window state (the form POST is processed before any window
 * exists), so we stash the payload in IndexedDB under a transfer id and
 * 303-redirect to /share?id=<transferId>. The SPA route then pulls the
 * payload out.
 *
 * Two concerns live in this module:
 *
 * 1. Persistence — wraps an IDB object store (`transfers`) with a typed
 *    put/get/delete and an opportunistic TTL sweep. IDB is used because it
 *    survives the SW->document hop and accepts Blobs directly; localStorage
 *    is string-only and would force an expensive base64 round-trip.
 *
 * 2. Form parsing — `buildSharePayloadFromFormData` and `ingestShareRequest`
 *    are pure functions that the service worker calls. Keeping them out of
 *    the SW lifecycle code lets unit tests cover the multipart shape
 *    without spinning up a real ServiceWorkerGlobalScope.
 */

const DB_NAME = 'hapi-share-transfers'
const DB_VERSION = 1
const STORE = 'transfers'
export const SHARE_TRANSFER_TTL_MS = 60 * 60 * 1000

export type ShareTransferFile = {
    name: string
    type: string
    blob: Blob
}

export type ShareTransferPayload = {
    title: string
    text: string
    url: string
    files: ShareTransferFile[]
    createdAt: number
}

type StoredRecord = ShareTransferPayload & { id: string }

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Failed to open share-transfer DB'))
    })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
    return new Promise((resolve, reject) => {
        openDb().then((db) => {
            const transaction = db.transaction(STORE, mode)
            const store = transaction.objectStore(STORE)
            const request = run(store)
            transaction.oncomplete = () => {
                db.close()
                resolve(request ? request.result : null)
            }
            transaction.onerror = () => {
                db.close()
                reject(transaction.error ?? new Error('share-transfer tx failed'))
            }
            transaction.onabort = () => {
                db.close()
                reject(transaction.error ?? new Error('share-transfer tx aborted'))
            }
        }, reject)
    })
}

export async function putShareTransfer(payload: ShareTransferPayload): Promise<string> {
    const id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const record: StoredRecord = { id, ...payload }
    await tx<IDBValidKey>('readwrite', (store) => store.put(record))
    return id
}

export async function getShareTransfer(id: string): Promise<ShareTransferPayload | null> {
    const record = await tx<StoredRecord | undefined>('readonly', (store) => store.get(id))
    if (!record) return null
    const { id: _id, ...payload } = record
    return payload
}

export async function deleteShareTransfer(id: string): Promise<void> {
    await tx<undefined>('readwrite', (store) => store.delete(id))
}

export async function cleanupExpiredShareTransfers(now: number = Date.now()): Promise<number> {
    return new Promise((resolve, reject) => {
        openDb().then((db) => {
            const transaction = db.transaction(STORE, 'readwrite')
            const store = transaction.objectStore(STORE)
            const cursorReq = store.openCursor()
            let removed = 0
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result
                if (!cursor) return
                const value = cursor.value as StoredRecord
                if (now - value.createdAt > SHARE_TRANSFER_TTL_MS) {
                    cursor.delete()
                    removed++
                }
                cursor.continue()
            }
            transaction.oncomplete = () => {
                db.close()
                resolve(removed)
            }
            transaction.onerror = () => {
                db.close()
                reject(transaction.error ?? new Error('share-transfer cleanup failed'))
            }
        }, reject)
    })
}

/**
 * Pure form-data -> payload conversion. Exposed for unit tests.
 *
 * The Web Share Target manifest declares `title`, `text`, `url`, and a
 * `files` part. Android Chrome sometimes omits parts the source app didn't
 * supply, so each text field falls back to '' and `files` filters out
 * non-File entries (string parts named 'files' have been observed when an
 * app shares text-only).
 */
export async function buildSharePayloadFromFormData(
    formData: FormData,
    now: number = Date.now()
): Promise<ShareTransferPayload> {
    const title = stringField(formData, 'title')
    const text = stringField(formData, 'text')
    const url = stringField(formData, 'url')
    const fileEntries = formData.getAll('files').filter((entry): entry is File => entry instanceof File)
    const files: ShareTransferFile[] = fileEntries.map((file) => ({
        name: file.name,
        type: file.type || 'application/octet-stream',
        blob: file
    }))
    return { title, text, url, files, createdAt: now }
}

function stringField(formData: FormData, name: string): string {
    const value = formData.get(name)
    return typeof value === 'string' ? value : ''
}

export type ShareIngestDeps = {
    put: (payload: ShareTransferPayload) => Promise<string>
    now?: () => number
}

export type ShareIngestResult = { redirectTo: string }

/**
 * Service-worker entry point. Reads the multipart form, persists it via the
 * injected `put` (defaulting to IndexedDB in production), and returns the
 * relative URL to redirect to. The 303 status that converts the POST into
 * a GET is set by the SW caller.
 */
export async function ingestShareRequest(
    request: Request,
    deps: ShareIngestDeps
): Promise<ShareIngestResult> {
    const now = deps.now ? deps.now() : Date.now()
    const formData = await request.formData()
    const payload = await buildSharePayloadFromFormData(formData, now)
    const id = await deps.put(payload)
    return { redirectTo: `/share?id=${encodeURIComponent(id)}` }
}
