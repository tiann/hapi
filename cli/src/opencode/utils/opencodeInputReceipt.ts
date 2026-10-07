import type { FetchLike } from './opencodeCompactBridge';

export type OpencodeUserMessage = { id: string; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Native user entries prove input acceptance independently of model completion. */
export async function fetchOpencodeUserMessages(opts: {
    baseUrl: string | null;
    sessionId: string | null;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}): Promise<OpencodeUserMessage[] | null> {
    if (!opts.baseUrl || !opts.sessionId) return null;
    try {
        const response = await (opts.fetchImpl ?? fetch)(
            `${opts.baseUrl}/session/${encodeURIComponent(opts.sessionId)}/message`,
            { method: 'GET', signal: AbortSignal.any([AbortSignal.timeout(1_000), ...(opts.signal ? [opts.signal] : [])]) }
        );
        if (!response.ok) return null;
        const data: unknown = await response.json();
        if (!Array.isArray(data)) return null;
        const messages: OpencodeUserMessage[] = [];
        const ids = new Set<string>();
        for (const entry of data) {
            if (!isRecord(entry) || !isRecord(entry.info)) return null;
            if (entry.info.role !== 'user') continue;
            const id = entry.info.id;
            if (typeof id !== 'string' || !id || ids.has(id) || !Array.isArray(entry.parts)) return null;
            let text = '';
            for (const part of entry.parts) {
                if (!isRecord(part)) return null;
                if (part.type !== 'text') continue;
                if (typeof part.text !== 'string') return null;
                text += part.text;
            }
            ids.add(id);
            messages.push({ id, text });
        }
        return messages;
    } catch {
        return null;
    }
}
