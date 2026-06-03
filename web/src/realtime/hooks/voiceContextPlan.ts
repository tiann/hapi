import {
    ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES,
    VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES,
    truncateUtf8ByteLength,
    utf8ByteLength
} from '@hapi/protocol/voice-personality'
import type { DecryptedMessage, Session } from '@/types/api'
import { formatMessage } from './contextFormatters'
import { VOICE_CONFIG } from '../voiceConfig'

const BOOTSTRAP_RECENT_MESSAGES = 2

export interface SessionVoiceContextPlan {
    bootstrap: string
    streamChunks: string[]
    truncated: boolean
    totalMessages: number
    messagesInBootstrap: number
    messagesStreamed: number
    notice: string | null
}

function formatSessionHeader(session: Session): string {
    const summary = session.metadata?.summary?.text?.trim()
    const path = session.metadata?.path
    const lines = [
        'THIS IS AN ACTIVE SESSION.',
        `# Session ID: ${session.id}`,
        path ? `# Project path: ${path}` : '',
        summary ? `# Session summary:\n${summary}` : ''
    ].filter(Boolean)
    return lines.join('\n\n')
}

function sortedMessages(messages: DecryptedMessage[]): DecryptedMessage[] {
    return [...messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

function chunkTextByBytes(parts: string[], maxBytes: number): string[] {
    const chunks: string[] = []
    let current = ''

    const flush = () => {
        if (current.trim()) {
            chunks.push(current.trim())
            current = ''
        }
    }

    for (const part of parts) {
        const candidate = current ? `${current}\n\n${part}` : part
        if (utf8ByteLength(candidate) <= maxBytes) {
            current = candidate
            continue
        }
        flush()
        if (utf8ByteLength(part) <= maxBytes) {
            current = part
        } else {
            chunks.push(truncateUtf8ByteLength(part, maxBytes))
        }
    }
    flush()
    return chunks
}

/**
 * Small handshake context for startSession; remainder is streamed after connect.
 */
export function buildSessionVoiceContextPlan(
    session: Session | null,
    messages: DecryptedMessage[]
): SessionVoiceContextPlan {
    if (!session) {
        return {
            bootstrap: 'Session not available',
            streamChunks: [],
            truncated: false,
            totalMessages: 0,
            messagesInBootstrap: 0,
            messagesStreamed: 0,
            notice: null
        }
    }

    const all = sortedMessages(messages)
    const capped = VOICE_CONFIG.MAX_HISTORY_MESSAGES > 0
        ? all.slice(-VOICE_CONFIG.MAX_HISTORY_MESSAGES)
        : all

    const formatted = capped
        .map((m) => formatMessage(m))
        .filter((line): line is string => Boolean(line))

    const recentCount = Math.min(BOOTSTRAP_RECENT_MESSAGES, formatted.length)
    const bootstrapMessages = formatted.slice(-recentCount)
    const streamMessages = formatted.slice(0, -recentCount)

    let bootstrap = formatSessionHeader(session)
    if (bootstrapMessages.length > 0) {
        bootstrap += '\n\n## Recent messages\n\n' + bootstrapMessages.join('\n\n')
    }

    const bootstrapBeforeCap = bootstrap
    bootstrap = truncateUtf8ByteLength(bootstrap, ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)

    const streamChunks = chunkTextByBytes(
        streamMessages.map((line) => `[Session history]\n${line}`),
        VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES
    )

    const truncated = bootstrap.length < bootstrapBeforeCap.length
        || streamMessages.length < formatted.length - recentCount

    let notice: string | null = null
    if (streamChunks.length > 0) {
        notice = `Streaming ${streamChunks.length} context update(s) after connect (${streamMessages.length} older messages).`
    }
    if (truncated) {
        notice = [notice, 'Some session context was shortened to fit voice wire limits.'].filter(Boolean).join(' ')
    }

    return {
        bootstrap,
        streamChunks,
        truncated,
        totalMessages: formatted.length,
        messagesInBootstrap: bootstrapMessages.length,
        messagesStreamed: streamMessages.length,
        notice
    }
}
