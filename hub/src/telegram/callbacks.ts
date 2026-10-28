/**
 * Callback Query Handlers for Telegram
 *
 * Handles InlineKeyboard button interactions for permission notifications.
 * Simplified to only support APPROVE and DENY actions.
 */

import { InlineKeyboard } from 'grammy'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { parseCallbackData, findSessionByPrefix } from './renderer'
import { hubT, type HubLocale } from '../i18n/hubI18n'

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
    namespace: string
    /** Language for the user-facing callback replies. */
    locale: HubLocale
    answerCallback: (text?: string) => Promise<void>
    editMessage: (text: string, keyboard?: InlineKeyboard) => Promise<void>
}

async function getSessionOrAnswer(
    ctx: CallbackContext,
    syncEngine: SyncEngine,
    sessionPrefix: string,
    options?: { requireActive?: boolean }
): Promise<Session | null> {
    const session = findSessionByPrefix(syncEngine.getSessionsByNamespace(ctx.namespace), sessionPrefix)
    if (!session) {
        await ctx.answerCallback(hubT(ctx.locale, 'callback.sessionNotFound'))
        return null
    }
    if (options?.requireActive && !session.active) {
        await ctx.answerCallback(hubT(ctx.locale, 'callback.sessionInactive'))
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
                    await ctx.answerCallback(hubT(ctx.locale, 'callback.requestMissing'))
                    return
                }

                await syncEngine.approvePermission(session.id, requestId)
                await ctx.answerCallback(hubT(ctx.locale, 'callback.approved'))

                // Update the notification message
                await ctx.editMessage(hubT(ctx.locale, 'callback.permissionApproved'), new InlineKeyboard())
                break
            }

            case ACTIONS.DENY: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const requestId = findRequestByPrefix(session, extra || '')
                if (!requestId) {
                    await ctx.answerCallback(hubT(ctx.locale, 'callback.requestMissing'))
                    return
                }

                await syncEngine.denyPermission(session.id, requestId)
                await ctx.answerCallback(hubT(ctx.locale, 'callback.denied'))

                // Update the notification message
                await ctx.editMessage(hubT(ctx.locale, 'callback.permissionDenied'), new InlineKeyboard())
                break
            }

            default:
                await ctx.answerCallback(hubT(ctx.locale, 'callback.unknownAction'))
        }
    } catch (error) {
        console.error('[Callback] Error:', error)
        await ctx.answerCallback(hubT(ctx.locale, 'callback.error'))
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
