import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** JSON payloads at or above this many chars are stored zstd-compressed (BLOB).
 *  Below it the plaintext JSON is kept: zstd gains little on tiny strings and
 *  plaintext rows stay grep-able when inspecting the DB by hand. */
export const COMPRESS_MIN_CHARS = 256

/** Per-string cap inside agent message content. Tool results above this are
 *  head+tail truncated at ingest — a single file read or build log can otherwise
 *  persist megabytes that no client ever renders in full. */
export const TRUNCATE_STRING_LIMIT = 64 * 1024
const TRUNCATE_HEAD = 48 * 1024
const TRUNCATE_TAIL = 12 * 1024

function truncateString(value: string): string {
    const removed = value.length - TRUNCATE_HEAD - TRUNCATE_TAIL
    // head + tail + marker stays well under TRUNCATE_STRING_LIMIT so the
    // function is idempotent — codexDesktop compares stored rows against
    // freshly-normalized transcripts and must get identical strings on both sides.
    return `${value.slice(0, TRUNCATE_HEAD)}\n…[hapi: truncated ${removed} chars]…\n${value.slice(value.length - TRUNCATE_TAIL)}`
}

/** Returns the same reference when nothing was truncated so callers can use
 *  identity to detect change. */
function truncateDeep(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > TRUNCATE_STRING_LIMIT ? truncateString(value) : value
    }
    if (Array.isArray(value)) {
        let copy: unknown[] | null = null
        for (let i = 0; i < value.length; i++) {
            const item = truncateDeep(value[i])
            if (item !== value[i]) {
                copy ??= value.slice()
                copy[i] = item
            }
        }
        return copy ?? value
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        let copy: Record<string, unknown> | null = null
        for (const key of Object.keys(record)) {
            const item = truncateDeep(record[key])
            if (item !== record[key]) {
                copy ??= { ...record }
                copy[key] = item
            }
        }
        return copy ?? value
    }
    return value
}

/** Truncate oversized strings inside agent-role message content.
 *
 *  Only role === 'agent' envelopes are touched: user messages are queued in the
 *  DB and later *delivered* to the CLI verbatim (getMatureScheduledMessages /
 *  getDeliverableMessagesAfter), so truncating them would corrupt real prompts,
 *  not just display history. Idempotent: re-applying to already-truncated
 *  content returns the same reference. */
export function truncateOversizedMessageContent(content: unknown): unknown {
    if (content === null || typeof content !== 'object') return content
    if ((content as Record<string, unknown>).role !== 'agent') return content
    return truncateDeep(content)
}

/** Compress a JSON string for the messages.content column.
 *  Storage contract: TEXT value = plaintext JSON, BLOB value = zstd(JSON). */
export function compressContentJson(json: string): string | Buffer {
    if (json.length < COMPRESS_MIN_CHARS) return json
    const compressed = zstdCompressSync(Buffer.from(json, 'utf8'))
    // Guard against incompressible payloads (already-compressed base64 etc.)
    return compressed.length < Buffer.byteLength(json, 'utf8') ? compressed : json
}

export function encodeMessageContent(content: unknown): string | Buffer {
    return compressContentJson(JSON.stringify(content))
}

function safeParse(json: string): unknown | null {
    try {
        return JSON.parse(json) as unknown
    } catch {
        return null
    }
}

/** Inverse of encodeMessageContent; tolerant like safeJsonParse (null on any
 *  malformed row) because readers treat content as best-effort display data. */
export function decodeMessageContent(raw: string | Uint8Array | null): unknown | null {
    if (raw === null) return null
    if (typeof raw === 'string') return safeParse(raw)
    try {
        return safeParse(zstdDecompressSync(raw).toString('utf8'))
    } catch {
        return null
    }
}
