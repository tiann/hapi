import { VOICE_CONTEXT_NOTICE_STORAGE_KEY } from '@hapi/protocol/voice-personality'

export function storeVoiceContextNotice(notice: string | null | undefined): void {
    if (!notice?.trim()) {
        localStorage.removeItem(VOICE_CONTEXT_NOTICE_STORAGE_KEY)
        return
    }
    localStorage.setItem(VOICE_CONTEXT_NOTICE_STORAGE_KEY, notice.trim())
}

export function readVoiceContextNotice(): string | null {
    return localStorage.getItem(VOICE_CONTEXT_NOTICE_STORAGE_KEY)
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Push deferred session history after the voice transport is connected. */
export async function streamDeferredVoiceContext(
    send: (chunk: string) => void,
    chunks: string[],
    options?: { delayMs?: number }
): Promise<void> {
    const delayMs = options?.delayMs ?? 40
    for (const chunk of chunks) {
        if (!chunk.trim()) continue
        send(chunk)
        if (delayMs > 0) {
            await delay(delayMs)
        }
    }
}

export function isVoiceProactiveSummaryEnabled(): boolean {
    return localStorage.getItem('hapi-voice-proactive') === 'true'
}
