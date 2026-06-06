import type { ApiClient } from '@/api/client'
import type { HapiSessionExport } from '@/types/api'
import { serializeSessionMarkdown } from './markdown'

export type SessionExportFormat = 'json' | 'markdown'

export const SESSION_EXPORT_FORMAT_STORAGE_KEY = 'hapi.sessionExportFormat'

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

function downloadTextFile(filename: string, text: string, mimeType: string): void {
    const blob = new Blob([text], { type: mimeType })
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
    options?: { signal?: AbortSignal }
): Promise<{ filename: string; messageCount: number }> {
    const payload = await api.getSessionExport(sessionId, { signal: options?.signal })
    const filename = buildSessionExportFilename(payload, format)
    if (format === 'json') {
        downloadTextFile(filename, `${JSON.stringify(payload, null, 2)}\n`, 'application/json;charset=utf-8')
    } else {
        downloadTextFile(filename, serializeSessionMarkdown(payload), 'text/markdown;charset=utf-8')
    }
    return { filename, messageCount: payload.messages.length }
}
