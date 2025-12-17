import type { SessionMetadataSummary } from '@/types/api'

export function resolveDisplayPath(path: string, metadata: SessionMetadataSummary | null): string {
    if (!metadata?.path) return path

    const root = metadata.path
    const lowerPath = path.toLowerCase()
    const lowerRoot = root.toLowerCase()
    if (!lowerPath.startsWith(lowerRoot)) return path

    const remainder = path.slice(root.length)
    if (remainder !== '' && !remainder.startsWith('/') && !remainder.startsWith('\\')) return path

    let out = remainder
    if (out.startsWith('/') || out.startsWith('\\')) {
        out = out.slice(1)
    }
    return out.length === 0 ? '<root>' : out
}

export function basename(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : path
}

