import { SESSION_EXPORT_MAX_BYTES } from '@hapi/protocol/sessionExport'
import type { ApiClient } from '@/api/client'
import type {
    HapiSessionExport,
    HapiSessionExportResponse,
    HapiSessionExportWarning
} from '@/types/api'
import { serializeSessionMarkdown } from './markdown'

export type SessionExportFormat = 'json' | 'markdown'

export type SessionExportDownloadResult =
    | { type: 'warning'; warning: HapiSessionExportWarning }
    | { type: 'too-large'; count: number; estimatedBytes: number; maxBytes: number }
    | { type: 'downloaded'; filename: string; messageCount: number }

export const SESSION_EXPORT_FORMAT_STORAGE_KEY = 'hapi.sessionExportFormat'

function isSessionExportWarning(response: HapiSessionExportResponse): response is HapiSessionExportWarning {
    return 'type' in response && response.type === 'warning'
}

export function readSessionExportFormat(): SessionExportFormat {
    if (typeof window === 'undefined') return 'json'
    const value = window.localStorage.getItem(SESSION_EXPORT_FORMAT_STORAGE_KEY)
    return value === 'markdown' ? 'markdown' : 'json'
}

export function writeSessionExportFormat(format: SessionExportFormat): void {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SESSION_EXPORT_FORMAT_STORAGE_KEY, format)
}

function getSessionTitle(payload: HapiSessionExport): string {
    const metadata = payload.session.metadata
    return metadata?.name
        ?? metadata?.summary?.text
        ?? metadata?.path?.split('/').filter(Boolean).at(-1)
        ?? payload.session.id.slice(0, 8)
}

function slugify(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
        .replace(/^-+|-+$/g, '')
    return slug || 'session'
}

function formatDate(value: number): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
    return date.toISOString().slice(0, 10)
}

export function buildSessionExportFilename(payload: HapiSessionExport, format: SessionExportFormat): string {
    const extension = format === 'json' ? 'json' : 'md'
    const slug = slugify(getSessionTitle(payload)).slice(0, 80)
    const shortId = payload.session.id.slice(0, 8)
    return `${slug}-${shortId}-${formatDate(payload.exportedAt)}.${extension}`
}

function downloadBlobFile(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function downloadSessionExport(
    api: ApiClient,
    sessionId: string,
    format: SessionExportFormat,
    options?: { force?: boolean; signal?: AbortSignal }
): Promise<SessionExportDownloadResult> {
    const response: HapiSessionExportResponse = await api.getSessionExport(sessionId, {
        force: options?.force,
        signal: options?.signal
    })
    if (isSessionExportWarning(response)) {
        return { type: 'warning', warning: response }
    }

    const payload: HapiSessionExport = response
    const filename = buildSessionExportFilename(payload, format)
    const text = format === 'json'
        ? `${JSON.stringify(payload, null, 2)}\n`
        : serializeSessionMarkdown(payload)
    const mimeType = format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
    const blob = new Blob([text], { type: mimeType })
    const estimatedBytes = blob.size
    if (estimatedBytes > SESSION_EXPORT_MAX_BYTES) {
        return {
            type: 'too-large',
            count: payload.messages.length,
            estimatedBytes,
            maxBytes: SESSION_EXPORT_MAX_BYTES
        }
    }
    downloadBlobFile(filename, blob)
    return { type: 'downloaded', filename, messageCount: payload.messages.length }
}
