import { normalizeNativeSessionTitle } from '@/agent/nativeSessionTitle'
import type { ApiSessionClient } from '@/api/apiSession'
import type { Metadata } from '@/api/types'

const MAX_TITLE_LENGTH = 60
const URL_REGEX = /https?:\/\/[^\s]+/gi
const MD_LINK_REGEX = /\[([^\]]+)\]\(([^)]*)\)/g
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g
const INLINE_CODE_REGEX = /`([^`]+)`/g

type AgyTitleClient = Pick<ApiSessionClient, 'updateMetadata'>

/**
 * Strips raw URLs, code blocks, and markdown noise from prompts or previews,
 * extracting substantive human intent for session titling.
 */
export function cleanPromptForTitle(raw: unknown): string | null {
    if (typeof raw !== 'string') return null

    // 1. Strip code blocks
    let text = raw.replace(CODE_BLOCK_REGEX, ' ')

    // 2. Expand markdown links: preserve label unless it's a bare UUID or internal path
    text = text.replace(MD_LINK_REGEX, (_match, label: string, url: string) => {
        const trimmedLabel = label.trim()
        if (/\/sessions\/[0-9a-f-]+/i.test(url) || /session:\/\//i.test(url)) {
            if (/^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(trimmedLabel)) {
                return ' '
            }
            return ` ${trimmedLabel} `
        }
        return ` ${trimmedLabel} `
    })

    // 3. Strip inline code marks
    text = text.replace(INLINE_CODE_REGEX, '$1')

    // 4. Handle raw URLs: strip them if substantive text exists; else extract concise host/path
    const textWithoutUrls = text.replace(URL_REGEX, ' ').replace(/\s+/g, ' ').trim()
    const hasSubstantiveContent = /[\u4e00-\u9fa5]|\b[a-zA-Z0-9_-]{2,}\b/.test(textWithoutUrls)

    if (hasSubstantiveContent) {
        text = textWithoutUrls
    } else {
        const urlMatch = raw.match(URL_REGEX)
        if (urlMatch && urlMatch[0]) {
            try {
                const parsed = new URL(urlMatch[0])
                const pathname = parsed.pathname.replace(/\/+$/, '')
                text = `${parsed.hostname}${pathname}`
            } catch {
                text = urlMatch[0].replace(/^https?:\/\//i, '').split(/[?#]/)[0] || urlMatch[0]
            }
        } else {
            text = textWithoutUrls
        }
    }

    // 5. Clean leading/trailing markdown headers, bullets, and excessive spaces
    text = text
        .replace(/^[#>*+\s\-:=]+/, '')
        .replace(/\s+/g, ' ')
        .trim()

    if (!text) return null

    // 6. Enforce unicode character limit
    const characters = Array.from(text)
    const normalized = characters.length > MAX_TITLE_LENGTH
        ? characters.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd() + '…'
        : text

    return normalizeNativeSessionTitle(normalized)
}

/**
 * Returns true if the current summary title is missing or is a raw uncleaned URL
 * left by an older session before URL stripping was introduced.
 */
export function isBrokenOrMissingSummaryTitle(value: unknown): boolean {
    if (typeof value !== 'string') return true
    const trimmed = value.trim()
    if (!trimmed) return true
    return /^https?:\/\/\S+$/i.test(trimmed)
}

/**
 * Immediately sets an initial clean title fallback so new sessions display
 * a meaningful title during turn 1 with 0ms delay.
 */
export function applyAgySessionTitleFallback(
    client: AgyTitleClient,
    prompt: string,
): boolean {
    const title = cleanPromptForTitle(prompt)
    if (!title) return false

    client.updateMetadata((metadata: Metadata) => {
        if (metadata.name?.trim() || metadata.acpManualTitle || !isBrokenOrMissingSummaryTitle(metadata.summary?.text)) {
            return metadata
        }
        return {
            ...metadata,
            summary: {
                text: title,
                updatedAt: Date.now(),
            },
        }
    })
    return true
}
