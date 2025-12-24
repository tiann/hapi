/**
 * Callback Query Handlers for Telegram
 *
 * Handles InlineKeyboard button interactions for permission notifications.
 * Simplified to only support APPROVE and DENY actions.
 */

import { InlineKeyboard } from 'grammy'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { parseCallbackData, findSessionByPrefix } from './renderer'

// Callback action types (simplified - only permission actions)
export const ACTIONS = {
    APPROVE: 'ap',
    DENY: 'dn',
} as const

/**
 * Callback handler context
 */
export interface CallbackContext {
    syncEngine: SyncEngine
    answerCallback: (text?: string) => Promise<void>
    editMessage: (text: string, keyboard?: InlineKeyboard) => Promise<void>
}

async function getSessionOrAnswer(
    ctx: CallbackContext,
    syncEngine: SyncEngine,
    sessionPrefix: string,
    options?: { requireActive?: boolean }
): Promise<Session | null> {
    const session = findSessionByPrefix(syncEngine.getSessions(), sessionPrefix)
    if (!session) {
        await ctx.answerCallback('Session not found')
        return null
    }
    if (options?.requireActive && !session.active) {
        await ctx.answerCallback('Session is inactive')
        return null
    }
    return session
}

/**
 * Handle callback query
 */
export async function handleCallback(
    data: string,
    ctx: CallbackContext
): Promise<void> {
    const { action, sessionPrefix, extra } = parseCallbackData(data)
    const { syncEngine } = ctx

    try {
        switch (action) {
            case ACTIONS.APPROVE: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const requestId = findRequestByPrefix(session, extra || '')
                if (!requestId) {
                    await ctx.answerCallback('Request not found or already processed')
                    return
                }

                await syncEngine.approvePermission(session.id, requestId)
                await ctx.answerCallback('Approved!')

                // Update the notification message
                await ctx.editMessage('Permission approved.', new InlineKeyboard())
                break
            }

            case ACTIONS.DENY: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const requestId = findRequestByPrefix(session, extra || '')
                if (!requestId) {
                    await ctx.answerCallback('Request not found or already processed')
                    return
                }

                await syncEngine.denyPermission(session.id, requestId)
                await ctx.answerCallback('Denied')

                // Update the notification message
                await ctx.editMessage('Permission denied.', new InlineKeyboard())
                break
            }

            default:
                await ctx.answerCallback('Unknown action')
        }
    } catch (error) {
        console.error('[Callback] Error:', error)
        await ctx.answerCallback('An error occurred')
    }
}

/**
 * Find request ID by prefix
 */
function findRequestByPrefix(session: Session, prefix: string): string | undefined {
    const requests = session.agentState?.requests
    if (!requests) return undefined

    for (const reqId of Object.keys(requests)) {
        if (reqId.startsWith(prefix)) {
            return reqId
        }
    }

    // If no prefix match, return the first request
    const keys = Object.keys(requests)
    return keys.length > 0 ? keys[0] : undefined
}
