import { getExecutionControl, isCodexDesktopMirrorSession } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'

export type ResolveSendTargetAction = 'takeover' | 'resume' | 'none'

export function describeResolveSendTargetSession(
    session: Session | null,
    messages: DecryptedMessage[] | null | undefined
): { action: ResolveSendTargetAction } {
    if (!session) {
        return { action: 'none' }
    }

    const control = getExecutionControl(session.metadata)
    const isDesktopMirror = isCodexDesktopMirrorSession({
        metadata: session.metadata,
        messages
    })

    if (isDesktopMirror && control?.owner !== 'hapi-runner') {
        return { action: 'takeover' }
    }
    if (!session.active) {
        return { action: 'resume' }
    }
    return { action: 'none' }
}

export function getResolveSendTargetSessionFailureToast(
    action: Exclude<ResolveSendTargetAction, 'none'>,
    error: unknown
): { title: string; body: string } {
    const fallback = action === 'takeover' ? 'Takeover failed' : 'Resume failed'
    return {
        title: fallback,
        body: error instanceof Error ? error.message : fallback
    }
}

export function useResolveSendTargetSession(
    api: ApiClient | null,
    session: Session | null,
    messages?: DecryptedMessage[] | null
) {
    return {
        async resolve(currentSessionId: string): Promise<string> {
            if (!api || !session) return currentSessionId

            const { action } = describeResolveSendTargetSession(session, messages)
            if (action === 'takeover') {
                return await api.takeoverSession(currentSessionId)
            }
            if (action === 'resume') {
                return await api.resumeSession(currentSessionId)
            }
            return currentSessionId
        }
    }
}
