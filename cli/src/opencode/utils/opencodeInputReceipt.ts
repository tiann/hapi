import type { FetchLike } from './opencodeCompactBridge';

/** Null text retains a native identity without treating internal content as input proof. */
export type OpencodeUserMessage = { id: string; text: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Submitted native text can prove acceptance; internal rows retain identity only. */
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
            let hasSubmittedText = false;
            let hasInternalText = false;
            let internal = entry.info.type === 'compaction' || entry.info.summary === true;
            for (const part of entry.parts) {
                if (!isRecord(part)) return null;
                // Overflow replay can turn a file into unmarked placeholder
                // text, so this history cannot establish text-only identity.
                if (part.type === 'file') return null;
                if (part.type === 'compaction'
                    || (isRecord(part.metadata) && part.metadata.compaction_continue === true)) internal = true;
                if (part.type !== 'text') continue;
                if (typeof part.text !== 'string') return null;
                if ((part.synthetic !== undefined && typeof part.synthetic !== 'boolean')
                    || (part.ignored !== undefined && typeof part.ignored !== 'boolean')) return null;
                if (part.synthetic === true || part.ignored === true) { hasInternalText = true; continue; }
                hasSubmittedText = true;
                text += part.text;
            }
            // updateMessage precedes updatePart: an incomplete ordinary row
            // may still acquire text that a later compaction can replay.
            if (!internal && !hasSubmittedText && !hasInternalText) return null;
            ids.add(id);
            messages.push({ id, text: !internal && hasSubmittedText ? text : null });
        }
        return messages;
    } catch {
        return null;
    }
}
