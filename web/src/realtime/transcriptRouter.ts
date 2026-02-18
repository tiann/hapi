import type { Session } from '@/types/api'

export type SessionStore = {
    getSession: (sessionId: string) => Session | null
    sendMessage: (sessionId: string, message: string) => void
    approvePermission: (sessionId: string, requestId: string) => Promise<void>
    denyPermission: (sessionId: string, requestId: string) => Promise<void>
}

const ALLOW_RE = /^(yes|yeah|yep|allow|approve|go ahead|continue)\b/
const DENY_RE = /^(no|nope|deny|decline|stop|cancel)\b/

export async function routeTranscript(
    store: SessionStore,
    sessionId: string,
    transcript: string
): Promise<void> {
    const normalized = transcript.toLowerCase()
    const session = store.getSession(sessionId)
    const requests = session?.agentState?.requests
    const requestId = requests ? Object.keys(requests)[0] : null

    if (requestId && ALLOW_RE.test(normalized)) {
        await store.approvePermission(sessionId, requestId)
        speak('Allowed.')
        return
    }

    if (requestId && DENY_RE.test(normalized)) {
        await store.denyPermission(sessionId, requestId)
        speak('Denied.')
        return
    }

    store.sendMessage(sessionId, transcript)
}

export function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        return
    }

    const cleaned = text.trim()
    if (!cleaned) {
        return
    }

    const utterance = new SpeechSynthesisUtterance(cleaned)
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
}
