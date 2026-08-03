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

/**
 * Stream older history, then deliver bootstrap context — same order on every backend.
 * ElevenLabs dynamicVariables alone are insufficient unless the agent prompt references
 * {{initialConversationContext}}; contextual updates are the reliable delivery path.
 */
export async function deliverVoiceSessionContextAfterConnect(options: {
    streamContextChunks?: string[]
    initialContext?: string
    sendChunk: (chunk: string) => void
    streamDelayMs?: number
}): Promise<void> {
    const streamChunks = options.streamContextChunks ?? []
    if (streamChunks.length > 0) {
        await streamDeferredVoiceContext(options.sendChunk, streamChunks, {
            delayMs: options.streamDelayMs
        })
    }
    const bootstrap = options.initialContext?.trim()
    if (bootstrap) {
        options.sendChunk(bootstrap)
    }
}

export function isVoiceProactiveSummaryEnabled(): boolean {
    return localStorage.getItem('hapi-voice-proactive') === 'true'
}
