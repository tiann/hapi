import { getCurrentRealtimeSessionId } from './RealtimeSession'
import { VOICE_CONFIG } from './voiceConfig'

// Store for session state and API client
let sessionStore: {
    getSession: (sessionId: string) => { agentState?: { requests?: Record<string, unknown> } } | null
    sendMessage: (sessionId: string, message: string) => void
    approvePermission: (sessionId: string, requestId: string) => Promise<void>
    denyPermission: (sessionId: string, requestId: string) => Promise<void>
} | null = null

/**
 * Register the session store for client tools to access
 */
export function registerSessionStore(store: typeof sessionStore) {
    sessionStore = store
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code.
 */
export const realtimeClientTools = {
    /**
     * Send a message to the active coding agent
     */
    messageCodingAgent: async (parameters: unknown) => {
        const params = parameters as { message?: string }

        if (!params.message || typeof params.message !== 'string' || params.message.trim() === '') {
            console.error('[Voice] Invalid message parameter:', parameters)
            return 'error (invalid message parameter)'
        }

        const message = params.message.trim()
        const sessionId = getCurrentRealtimeSessionId()

        if (!sessionId) {
            console.error('[Voice] No active session')
            return 'error (no active session)'
        }

        if (!sessionStore) {
            console.error('[Voice] Session store not registered')
            return 'error (session store not available)'
        }

        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] messageCodingAgent called with:', message)
            console.log('[Voice] Sending message to session:', sessionId)
        }

        sessionStore.sendMessage(sessionId, message)
        return "sent [DO NOT say anything else, simply say 'sent']"
    },

    /**
     * Process a permission request from Claude Code
     */
    processPermissionRequest: async (parameters: unknown) => {
        const params = parameters as { decision?: string }

        if (!params.decision || (params.decision !== 'allow' && params.decision !== 'deny')) {
            console.error('[Voice] Invalid decision parameter:', parameters)
            return "error (invalid decision parameter, expected 'allow' or 'deny')"
        }

        const decision = params.decision
        const sessionId = getCurrentRealtimeSessionId()

        if (!sessionId) {
            console.error('[Voice] No active session')
            return 'error (no active session)'
        }

        if (!sessionStore) {
            console.error('[Voice] Session store not registered')
            return 'error (session store not available)'
        }

        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] processPermissionRequest called with:', decision)
        }

        // Get the current session to check for permission requests
        const session = sessionStore.getSession(sessionId)
        const requests = session?.agentState?.requests

        if (!requests || Object.keys(requests).length === 0) {
            console.error('[Voice] No active permission request')
            return 'error (no active permission request)'
        }

        const requestId = Object.keys(requests)[0]

        try {
            if (decision === 'allow') {
                await sessionStore.approvePermission(sessionId, requestId)
            } else {
                await sessionStore.denyPermission(sessionId, requestId)
            }
            return "done [DO NOT say anything else, simply say 'done']"
        } catch (error) {
            console.error('[Voice] Failed to process permission:', error)
            return `error (failed to ${decision} permission)`
        }
    }
}
