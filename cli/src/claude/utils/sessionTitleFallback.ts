import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { getProjectPath } from './path'

const MAX_FALLBACK_TITLE_LENGTH = 80

export function createSessionTitleFallback(message: string): string | null {
    const normalized = message.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    if (normalized.length <= MAX_FALLBACK_TITLE_LENGTH) return normalized

    return normalized.slice(0, MAX_FALLBACK_TITLE_LENGTH - 1).trimEnd() + '…'
}

/** Drop the @path references prepended for uploads; upload filenames contain no whitespace. */
export function stripAttachmentReferences(message: string): string {
    const prefix = `@${getHapiBlobsDir()}${sep}`
    return message.split(/(\s+)/).filter((part) => !part.startsWith(prefix)).join('')
}

export function applySessionTitleFallback(
    client: Pick<ApiSessionClient, 'updateMetadata'>,
    message: string
): boolean {
    const title = createSessionTitleFallback(message)
    if (!title) return false

    client.updateMetadata((metadata) => {
        if (metadata.name?.trim() || metadata.summary?.text.trim()) return metadata

        return {
            ...metadata,
            summary: {
                text: title,
                updatedAt: Date.now()
            }
        }
    })
    return true
}

/** Latest Claude Code ai-title from the session transcript, or null. */
export async function readNativeSessionTitle(workingDirectory: string, sessionId: string): Promise<string | null> {
    let content: string
    try {
        content = await readFile(join(getProjectPath(workingDirectory), `${sessionId}.jsonl`), 'utf8')
    } catch {
        return null
    }

    let title: string | null = null
    for (const line of content.split('\n')) {
        if (!line.includes('"ai-title"')) continue
        try {
            const entry = JSON.parse(line)
            if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') title = entry.aiTitle
        } catch {
            // Partial trailing line while Claude is still writing.
        }
    }
    return title
}
