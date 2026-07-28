import type { Locale } from '@/lib/use-translation'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatFileSize(bytes: number | undefined): string | null {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
    if (bytes < 1024) return `${bytes} B`

    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
    const value = bytes / (1024 ** unitIndex)
    const formatted = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')
    return `${formatted} ${BYTE_UNITS[unitIndex]}`
}

export function formatModifiedTime(modified: number | undefined, locale: Locale): string | null {
    if (modified === undefined || !Number.isFinite(modified)) return null
    const date = new Date(modified)
    if (Number.isNaN(date.getTime())) return null

    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date)
}

export function formatFileMetadata(size: number | undefined, modified: number | undefined, locale: Locale): string | null {
    return [formatModifiedTime(modified, locale), formatFileSize(size)].filter(Boolean).join(' · ') || null
}
