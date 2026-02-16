import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted } from '../RealtimeSession'
import {
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline
} from './contextFormatters'
import { VOICE_CONFIG } from '../voiceConfig'
import type { DecryptedMessage, Session } from '@/types/api'
import { isReadyAnnouncementsEnabled } from '@/lib/settings'

interface SessionMetadata {
    summary?: { text?: string }
    path?: string
    machineId?: string
}

// Track which sessions have been reported
const shownSessions = new Set<string>()
let lastFocusSession: string | null = null
const lastReadyAt = new Map<string, number>()
const READY_DEBOUNCE_MS = 20_000

// Session and message store references
let sessionGetter: ((sessionId: string) => Session | null) | null = null
let messagesGetter: ((sessionId: string) => DecryptedMessage[]) | null = null

/**
 * Register the session and message getters for voice hooks
 */
export function registerVoiceHooksStore(
    getSession: (sessionId: string) => Session | null,
    getMessages: (sessionId: string) => DecryptedMessage[]
) {
    sessionGetter = getSession
    messagesGetter = getMessages
}

function reportContextualUpdate(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('[Voice] Reporting contextual update:', update)
    }
    if (!update) return
    const voice = getVoiceSession()
    if (!voice || !isVoiceSessionStarted()) return
    voice.sendContextualUpdate(update)
}

function reportTextUpdate(update: string | null | undefined) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
        console.log('[Voice] Reporting text update:', update)
    }
    if (!update) return
    const voice = getVoiceSession()
    if (!voice || !isVoiceSessionStarted()) return
    voice.sendTextMessage(update)
}

function reportSession(sessionId: string) {
    if (shownSessions.has(sessionId)) return
    shownSessions.add(sessionId)

    const session = sessionGetter?.(sessionId) ?? null
    if (!session) return

    const messages = messagesGetter?.(sessionId) ?? []
    const contextUpdate = formatSessionFull(session, messages)
    reportContextualUpdate(contextUpdate)
}

export const voiceHooks = {
    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return

        reportSession(sessionId)
        const contextUpdate = formatSessionOnline(sessionId, metadata)
        reportContextualUpdate(contextUpdate)
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return

        reportSession(sessionId)
        const contextUpdate = formatSessionOffline(sessionId, metadata)
        reportContextualUpdate(contextUpdate)
    },

    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return
        if (lastFocusSession === sessionId) return
        lastFocusSession = sessionId
        reportSession(sessionId)
        reportContextualUpdate(formatSessionFocus(sessionId, metadata))
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: unknown) {
        if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return

        reportSession(sessionId)
        reportTextUpdate(formatPermissionRequest(sessionId, requestId, toolName, toolArgs))
    },

    /**
     * Called when agent sends messages
     */
    onMessages(sessionId: string, messages: DecryptedMessage[]) {
        if (VOICE_CONFIG.DISABLE_MESSAGES) return

        reportSession(sessionId)
        reportContextualUpdate(formatNewMessages(sessionId, messages))
    },

    /**
     * Called when voice session starts - returns initial context
     */
    onVoiceStarted(sessionId: string): string {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] Voice session started for:', sessionId)
        }
        shownSessions.clear()

        const session = sessionGetter?.(sessionId) ?? null
        const messages = messagesGetter?.(sessionId) ?? []

        let prompt = 'THIS IS AN ACTIVE SESSION: \n\n' + formatSessionFull(session, messages)
        shownSessions.add(sessionId)

        return prompt
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     */
    onReady(sessionId: string) {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) return
        if (!isReadyAnnouncementsEnabled()) return
        const now = Date.now()
        const previous = lastReadyAt.get(sessionId)
        if (previous && now - previous < READY_DEBOUNCE_MS) {
            return
        }
        lastReadyAt.set(sessionId, now)

        reportSession(sessionId)
        reportTextUpdate(formatReadyEvent(sessionId))
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] Voice session stopped')
        }
        shownSessions.clear()
        lastReadyAt.clear()
        lastFocusSession = null
    }
}
