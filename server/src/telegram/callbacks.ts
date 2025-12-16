/**
 * Callback Query Handlers for Telegram
 *
 * Handles InlineKeyboard button interactions for sessions, permissions, etc.
 */

import { InlineKeyboard } from 'grammy'
import type { Session, Machine, SyncEngine } from '../sync/syncEngine'
import {
    createCallbackData,
    parseCallbackData,
    findSessionByPrefix,
    findMachineByPrefix,
    formatSessionList,
    formatMachineList,
    getSessionName,
    getSessionStatusEmoji
} from './renderer'
import {
    formatSessionDetailView,
    createSessionDetailKeyboard as createDetailKeyboard,
    formatSettingsView,
    createSettingsKeyboard
} from './sessionView'

// Callback action types
export const ACTIONS = {
    // Session actions
    VIEW_SESSION: 'vs',
    REFRESH_SESSION: 'rs',
    BACK_TO_LIST: 'bl',

    // Permission actions
    APPROVE: 'ap',
    APPROVE_EDITS: 'ae',
    APPROVE_BYPASS: 'ab',
    DENY: 'dn',

    // Session control
    ABORT: 'at',
    SETTINGS: 'st',
    BACK_TO_SESSION: 'bs',

    // Settings - Permission Mode
    SET_MODE_DEFAULT: 'md',
    SET_MODE_EDITS: 'me',
    SET_MODE_BYPASS: 'mb',
    SET_MODE_PLAN: 'mp',

    // Settings - Model
    SET_MODEL_DEFAULT: 'xd',
    SET_MODEL_SONNET: 'xs',
    SET_MODEL_OPUS: 'xo',

    // Machine actions
    VIEW_MACHINE: 'vm',
    SPAWN_SESSION: 'sp',

    // Navigation
    REFRESH_LIST: 'rl',
    REFRESH_MACHINES: 'rm'
} as const

/**
 * Create session list keyboard
 */
export function createSessionListKeyboard(sessions: Session[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()

    // Add view buttons for first 5 sessions (2 per row)
    const display = sessions.slice(0, 8)
    for (let i = 0; i < display.length; i++) {
        const session = display[i]
        const name = getSessionName(session)
        const emoji = getSessionStatusEmoji(session)
        const label = `${emoji} ${name.slice(0, 15)}`
        const callback = createCallbackData(ACTIONS.VIEW_SESSION, session.id)

        keyboard.text(label, callback)

        // 2 buttons per row
        if (i % 2 === 1) {
            keyboard.row()
        }
    }

    // Add refresh button
    keyboard.row()
    keyboard.text('🔄 Refresh', createCallbackData(ACTIONS.REFRESH_LIST, 'list'))

    return keyboard
}

/**
 * Create session detail keyboard
 * Re-export from sessionView for backward compatibility
 */
export function createSessionDetailKeyboard(session: Session): InlineKeyboard {
    return createDetailKeyboard(session)
}

/**
 * Create machine list keyboard
 */
export function createMachineListKeyboard(machines: Machine[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()

    // Add spawn session buttons for each machine
    for (const machine of machines.slice(0, 6)) {
        const name = machine.metadata?.displayName || machine.metadata?.host || 'Unknown'
        const label = `📡 ${name.slice(0, 20)}`
        const callback = createCallbackData(ACTIONS.SPAWN_SESSION, machine.id)

        keyboard.text(label, callback)
        keyboard.row()
    }

    // Add refresh button
    keyboard.text('🔄 Refresh', createCallbackData(ACTIONS.REFRESH_MACHINES, 'machines'))

    return keyboard
}

/**
 * Callback handler context
 */
export interface CallbackContext {
    syncEngine: SyncEngine
    answerCallback: (text?: string) => Promise<void>
    editMessage: (text: string, keyboard?: InlineKeyboard) => Promise<void>
    sendMessage: (text: string, keyboard?: InlineKeyboard) => Promise<void>
}

/**
 * Safely edit message, ignoring "message not modified" errors
 */
async function safeEditMessage(
    ctx: CallbackContext,
    text: string,
    keyboard?: InlineKeyboard
): Promise<void> {
    try {
        await ctx.editMessage(text, keyboard)
    } catch (error: any) {
        // Ignore "message is not modified" error (error code 400)
        if (error?.error_code === 400 && error?.description?.includes('message is not modified')) {
            // Message content is the same, ignore
            return
        }
        throw error
    }
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
            case ACTIONS.VIEW_SESSION: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix)
                if (!session) {
                    return
                }

                // Fetch messages for this session
                await syncEngine.fetchMessages(session.id)
                const messages = syncEngine.getSessionMessages(session.id)

                const text = formatSessionDetailView(session, messages)
                const keyboard = createSessionDetailKeyboard(session)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback()
                break
            }

            case ACTIONS.REFRESH_SESSION: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix)
                if (!session) {
                    return
                }

                await syncEngine.fetchMessages(session.id)
                const messages = syncEngine.getSessionMessages(session.id)

                const text = formatSessionDetailView(session, messages)
                const keyboard = createSessionDetailKeyboard(session)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback('Refreshed')
                break
            }

            case ACTIONS.BACK_TO_LIST: {
                const sessions = syncEngine.getActiveSessions()
                const text = formatSessionList(sessions)
                const keyboard = createSessionListKeyboard(sessions)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback()
                break
            }

            case ACTIONS.REFRESH_LIST: {
                const sessions = syncEngine.getActiveSessions()
                const text = formatSessionList(sessions)
                const keyboard = createSessionListKeyboard(sessions)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback('Refreshed')
                break
            }

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

                // Refresh the view
                const messages = syncEngine.getSessionMessages(session.id)
                const updatedSession = syncEngine.getSession(session.id)
                if (updatedSession) {
                    const text = formatSessionDetailView(updatedSession, messages)
                    const keyboard = createSessionDetailKeyboard(updatedSession)
                    await safeEditMessage(ctx, text, keyboard)
                }
                break
            }

            case ACTIONS.APPROVE_EDITS: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const requestId = findRequestByPrefix(session, extra || '')
                if (!requestId) {
                    await ctx.answerCallback('Request not found or already processed')
                    return
                }

                await syncEngine.approvePermission(session.id, requestId, 'acceptEdits')
                await ctx.answerCallback('Approved with Accept Edits!')

                // Refresh the view
                const messages = syncEngine.getSessionMessages(session.id)
                const updatedSession = syncEngine.getSession(session.id)
                if (updatedSession) {
                    const text = formatSessionDetailView(updatedSession, messages)
                    const keyboard = createSessionDetailKeyboard(updatedSession)
                    await safeEditMessage(ctx, text, keyboard)
                }
                break
            }

            case ACTIONS.APPROVE_BYPASS: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const requestId = findRequestByPrefix(session, extra || '')
                if (!requestId) {
                    await ctx.answerCallback('Request not found or already processed')
                    return
                }

                await syncEngine.approvePermission(session.id, requestId, 'bypassPermissions')
                await ctx.answerCallback('Approved with Bypass!')

                // Refresh the view
                const messages = syncEngine.getSessionMessages(session.id)
                const updatedSession = syncEngine.getSession(session.id)
                if (updatedSession) {
                    const text = formatSessionDetailView(updatedSession, messages)
                    const keyboard = createSessionDetailKeyboard(updatedSession)
                    await safeEditMessage(ctx, text, keyboard)
                }
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

                // Refresh the view
                const messages = syncEngine.getSessionMessages(session.id)
                const updatedSession = syncEngine.getSession(session.id)
                if (updatedSession) {
                    const text = formatSessionDetailView(updatedSession, messages)
                    const keyboard = createSessionDetailKeyboard(updatedSession)
                    await safeEditMessage(ctx, text, keyboard)
                }
                break
            }

            case ACTIONS.ABORT: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                await syncEngine.abortSession(session.id)
                await ctx.answerCallback('Session aborted')

                // Refresh the view
                const messages = syncEngine.getSessionMessages(session.id)
                const updatedSession = syncEngine.getSession(session.id)
                if (updatedSession) {
                    const text = formatSessionDetailView(updatedSession, messages)
                    const keyboard = createSessionDetailKeyboard(updatedSession)
                    await safeEditMessage(ctx, text, keyboard)
                }
                break
            }

            case ACTIONS.SETTINGS: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix)
                if (!session) {
                    return
                }

                const text = formatSettingsView(session)
                const keyboard = createSettingsKeyboard(session)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback()
                break
            }

            case ACTIONS.BACK_TO_SESSION: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix)
                if (!session) {
                    return
                }

                const messages = syncEngine.getSessionMessages(session.id)
                const text = formatSessionDetailView(session, messages)
                const keyboard = createSessionDetailKeyboard(session)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback()
                break
            }

            case ACTIONS.SET_MODE_DEFAULT:
            case ACTIONS.SET_MODE_EDITS:
            case ACTIONS.SET_MODE_BYPASS:
            case ACTIONS.SET_MODE_PLAN: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const modeMap: Record<string, 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'> = {
                    [ACTIONS.SET_MODE_DEFAULT]: 'default',
                    [ACTIONS.SET_MODE_EDITS]: 'acceptEdits',
                    [ACTIONS.SET_MODE_BYPASS]: 'bypassPermissions',
                    [ACTIONS.SET_MODE_PLAN]: 'plan'
                }
                const mode = modeMap[action]

                try {
                    await syncEngine.setPermissionMode(session.id, mode)
                    await ctx.answerCallback(`Mode set to ${mode}`)

                    // Refresh settings view
                    const updatedSession = syncEngine.getSession(session.id)
                    if (updatedSession) {
                        const text = formatSettingsView(updatedSession)
                        const keyboard = createSettingsKeyboard(updatedSession)
                        await safeEditMessage(ctx, text, keyboard)
                    }
                } catch (error) {
                    console.error('[Callback] Failed to set mode:', error)
                    await ctx.answerCallback('Failed to change mode')
                }
                break
            }

            case ACTIONS.SET_MODEL_DEFAULT:
            case ACTIONS.SET_MODEL_SONNET:
            case ACTIONS.SET_MODEL_OPUS: {
                const session = await getSessionOrAnswer(ctx, syncEngine, sessionPrefix, { requireActive: true })
                if (!session) {
                    return
                }

                const modelMap: Record<string, 'default' | 'sonnet' | 'opus'> = {
                    [ACTIONS.SET_MODEL_DEFAULT]: 'default',
                    [ACTIONS.SET_MODEL_SONNET]: 'sonnet',
                    [ACTIONS.SET_MODEL_OPUS]: 'opus'
                }
                const model = modelMap[action]

                try {
                    await syncEngine.setModelMode(session.id, model)
                    await ctx.answerCallback(`Model set to ${model}`)

                    // Refresh settings view
                    const updatedSession = syncEngine.getSession(session.id)
                    if (updatedSession) {
                        const text = formatSettingsView(updatedSession)
                        const keyboard = createSettingsKeyboard(updatedSession)
                        await safeEditMessage(ctx, text, keyboard)
                    }
                } catch (error) {
                    console.error('[Callback] Failed to set model:', error)
                    await ctx.answerCallback('Failed to change model')
                }
                break
            }

            case ACTIONS.REFRESH_MACHINES: {
                const machines = syncEngine.getOnlineMachines()
                const text = formatMachineList(machines)
                const keyboard = createMachineListKeyboard(machines)
                await safeEditMessage(ctx, text, keyboard)
                await ctx.answerCallback('Refreshed')
                break
            }

            case ACTIONS.SPAWN_SESSION: {
                // Handled directly in bot.ts setupCallbacks()
                // This case shouldn't be reached, but handle gracefully
                await ctx.answerCallback('Use /new to create a session')
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
