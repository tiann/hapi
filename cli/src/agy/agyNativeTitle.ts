import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeNativeSessionTitle } from '@/agent/nativeSessionTitle'
import { logger } from '@/ui/logger'
import { cleanPromptForTitle } from './agySessionTitle'

const AGY_CONVERSATION_SUMMARIES_DB = join(
    homedir(),
    '.gemini',
    'antigravity-cli',
    'conversation_summaries.db',
)
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type AgyConversationSummaryRow = {
    title?: unknown
    preview?: unknown
}

export type ReadAgyConversationTitle = (conversationId: string) => Promise<string | null>

type QueryAgyConversationTitle = (conversationId: string) => Promise<unknown>

/** Reads a native Anti-Gravity title and applies HAPI's placeholder filtering. */
export async function readAgyConversationTitle(
    conversationId: string,
    query: QueryAgyConversationTitle = queryAgyConversationTitle,
): Promise<string | null> {
    if (!CANONICAL_UUID_RE.test(conversationId)) {
        return null
    }

    try {
        const result = await query(conversationId)
        if (typeof result === 'object' && result !== null) {
            const row = result as AgyConversationSummaryRow
            return normalizeNativeSessionTitle(row.title) ?? cleanPromptForTitle(row.preview)
        }
        return normalizeNativeSessionTitle(result)
    } catch (error) {
        logger.debug('[agy-title] native title lookup unavailable', error)
        return null
    }
}

async function queryAgyConversationTitle(conversationId: string): Promise<unknown> {
    const { Database } = await import('bun:sqlite')
    const db = new Database(AGY_CONVERSATION_SUMMARIES_DB, { readonly: true })
    try {
        const row = db.query(
            'SELECT title, preview FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
        ).get(conversationId) as AgyConversationSummaryRow | null
        return row
    } finally {
        db.close()
    }
}
