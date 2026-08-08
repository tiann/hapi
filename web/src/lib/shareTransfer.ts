import { shareTargetPathname } from './sharePath'
import { MAX_UPLOAD_BYTES } from './attachmentAdapter'

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

/**
 * Router search for `/share`: only SW redirect fields. Native deep-link
 * content must NOT live in the query string — it is logged by hub request
 * middleware (Hono `logger()`) and any upstream access log. Companions open
 * `/share#url=&text=&title=` instead; see `parseShareHash`.
 */
export type ShareSearch = {
    id?: string
    error?: string
}

/** Deep-link content fields (hash fragment only). */
export type ShareDeepLinkFields = {
    url?: string
    text?: string
    title?: string
    /**
     * Companion-hosted one-shot HTTP(S) URL for a shared file (image/video).
     * Fragment stays text-sized; the share page fetches bytes into IDB.
     * Not logged on the hub request line (fragment-only).
     */
    fileUrl?: string
    fileName?: string
    fileType?: string
}

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    // Emptiness uses trim, but return the original string so GET ingest
    // matches POST form-data (which preserves surrounding whitespace).
    return value.trim().length > 0 ? value : undefined
}

/** Router `validateSearch` for `/share` — id/error only. */
export function parseShareSearch(search: Record<string, unknown>): ShareSearch {
    const result: ShareSearch = {}
    if (typeof search.id === 'string' && search.id) {
        result.id = search.id
    }
    if (typeof search.error === 'string' && search.error) {
        result.error = search.error
    }
    return result
}

/** Parse url/text/title(/file*) from a flat record (hash params or tests). */
export function parseShareDeepLinkFields(
    fields: Record<string, unknown>
): ShareDeepLinkFields {
    const result: ShareDeepLinkFields = {}
    const url = nonEmptyString(fields.url)
    if (url) result.url = url
    const text = nonEmptyString(fields.text)
    if (text) result.text = text
    const title = nonEmptyString(fields.title)
    if (title) result.title = title
    const fileUrl = nonEmptyString(fields.fileUrl)
    if (fileUrl) result.fileUrl = fileUrl
    const fileName = nonEmptyString(fields.fileName)
    if (fileName) result.fileName = fileName
    const fileType = nonEmptyString(fields.fileType)
    if (fileType) result.fileType = fileType
    return result
}

/**
 * Read native deep-link content from the URL fragment.
 * Fragments are not sent on the HTTP request, so shared text never reaches
 * hub access logs. `hash` may include a leading `#`.
 */
export function parseShareHash(hash: string): ShareDeepLinkFields {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash
    if (!raw) return {}
    return parseShareDeepLinkFields(
        Object.fromEntries(new URLSearchParams(raw).entries())
    )
}

/** Drop the fragment from the address bar after reading (no navigation). */
export function scrubShareHashFromLocation(): void {
    if (typeof window === 'undefined') return
    if (!window.location.hash) return
    window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`
    )
}

/** True when deep-link content is present (id path is decided separately). */
export function hasShareDeepLinkContent(fields: ShareDeepLinkFields): boolean {
    return Boolean(fields.url || fields.text || fields.title || fields.fileUrl)
}

/**
 * Text/url/title payload (no fetch). Prefer {@link buildSharePayloadFromDeepLink}
 * when `fileUrl` may be present.
 */
export function buildSharePayloadFromSearchFields(
    fields: ShareDeepLinkFields,
    now: number = Date.now()
): ShareTransferPayload {
    return {
        title: fields.title ?? '',
        text: fields.text ?? '',
        url: fields.url ?? '',
        files: [],
        createdAt: now,
    }
}

/**
 * Native companion ingest: text fields plus optional `fileUrl` fetch into
 * `files[]` (same shape as Web Share Target POST). `fileUrl` must be
 * CORS-readable from the HAPI origin (companions send ACAO *).
 * Enforces {@link MAX_UPLOAD_BYTES} while streaming so a crafted link cannot
 * buffer an unbounded response into IndexedDB before the composer rejects it.
 */
export async function buildSharePayloadFromDeepLink(
    fields: ShareDeepLinkFields,
    now: number = Date.now(),
    deps: { fetch?: typeof fetch } = {}
): Promise<ShareTransferPayload> {
    const base = buildSharePayloadFromSearchFields(fields, now)
    const fileUrl = fields.fileUrl?.trim()
    if (!fileUrl) return base

    const doFetch = deps.fetch ?? fetch
    const response = await doFetch(fileUrl)
    if (!response.ok) {
        throw new Error(`share fileUrl fetch failed: ${response.status}`)
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength) {
        const declared = Number(contentLength)
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
            throw new Error(
                `share fileUrl too large: ${declared} bytes (max ${MAX_UPLOAD_BYTES})`
            )
        }
    }
    const blob = await readResponseBlobLimited(response, MAX_UPLOAD_BYTES)
    const headerType = response.headers.get('content-type')?.split(';')[0]?.trim()
    const type = fields.fileType?.trim()
        || headerType
        || blob.type
        || 'application/octet-stream'
    const name = fields.fileName?.trim() || guessFileName(fileUrl, type)
    return {
        ...base,
        files: [{ name, type, blob }],
    }
}

async function readResponseBlobLimited(
    response: Response,
    maxBytes: number
): Promise<Blob> {
    if (!response.body) {
        const blob = await response.blob()
        if (blob.size > maxBytes) {
            throw new Error(
                `share fileUrl too large: ${blob.size} bytes (max ${maxBytes})`
            )
        }
        return blob
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new Error(
                `share fileUrl too large: exceeds ${maxBytes} bytes`
            )
        }
        chunks.push(value)
    }
    const contentType = response.headers.get('content-type') ?? undefined
    return new Blob(chunks as BlobPart[], { type: contentType })
}

function guessFileName(fileUrl: string, type: string): string {
    try {
        const path = new URL(fileUrl).pathname
        const leaf = path.split('/').filter(Boolean).pop()
        if (leaf && leaf.includes('.')) return leaf
    } catch {
        // ignore invalid URL
    }
    const subtype = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
    return `shared.${subtype}`
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
    const sharePath = shareTargetPathname()
    return { redirectTo: `${sharePath}?id=${encodeURIComponent(id)}` }
}
