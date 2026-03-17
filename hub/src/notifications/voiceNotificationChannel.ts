import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from './notificationTypes'
import { getAgentName, getSessionName } from './sessionInfo'
import type { SSEManager } from '../sse/sseManager'

/**
 * Notification channel that sends voice-notification SSE events.
 * The web client speaks these aloud using Web Speech API or ElevenLabs TTS.
 */
export class VoiceNotificationChannel implements NotificationChannel {
    constructor(private readonly sseManager: SSEManager) {}

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ?? 'a tool'

        const text = `${getAgentName(session)} needs permission to use ${toolName} in ${name}.`

        await this.sseManager.sendVoiceNotification(session.namespace, {
            type: 'voice-notification',
            data: {
                text,
                sessionId: session.id,
                priority: 'high',
                category: 'permission'
            }
        })
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const text = `${agentName} is ready for input in ${name}.`

        await this.sseManager.sendVoiceNotification(session.namespace, {
            type: 'voice-notification',
            data: {
                text,
                sessionId: session.id,
                priority: 'normal',
                category: 'ready'
            }
        })
    }
}
