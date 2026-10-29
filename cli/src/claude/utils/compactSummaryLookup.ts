import { open, type FileHandle } from 'node:fs/promises';
import { RawJSONLinesSchema } from '../types';

/**
 * Looks up the compact summary body Claude Code writes to the local session
 * transcript (`<projectDir>/<sessionId>.jsonl`). The SDK stream carries only
 * the boundary metadata, so the transcript is the sole source for the summary
 * text. Claude Code may flush it slightly after the result arrives, hence the
 * bounded polling.
 */

export function extractCompactSummaryFromTranscript(content: string): string | null {
    let latest: string | null = null;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const parsed = RawJSONLinesSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== 'user' || !parsed.data.isCompactSummary) {
            continue;
        }
        const text = extractText((parsed.data.message as { content?: unknown } | undefined)?.content);
        if (text !== null) latest = text;
    }
    return latest;
}

function extractText(content: unknown): string | null {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(content)) {
        const joined = content
            .filter((block): block is { type: 'text'; text: string } =>
                typeof block === 'object' && block !== null &&
                (block as any).type === 'text' && typeof (block as any).text === 'string')
            .map((block) => block.text.trim())
            .join('\n')
            .trim();
        return joined.length > 0 ? joined : null;
    }
    return null;
}

export async function findLatestCompactSummary(
    transcriptPath: string,
    opts?: {
        attempts?: number;
        intervalMs?: number;
        sleep?: (ms: number) => Promise<void>;
        signal?: AbortSignal;
        // Byte offset recorded before the compaction started. Rows below it
        // belong to earlier turns (e.g. a previous compaction's summary in a
        // resumed or second-compact session) and must not satisfy this lookup
        // while the fresh row is still being flushed.
        minBytes?: number;
    }
): Promise<string | null> {
    const attempts = opts?.attempts ?? 10;
    const intervalMs = opts?.intervalMs ?? 500;
    const minBytes = opts?.minBytes ?? 0;
    const signal = opts?.signal;
    const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    }));
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (signal?.aborted) return null;
        let handle: FileHandle | undefined;
        try {
            // Range-read only the tail written after the baseline: the
            // transcript is append-only and can be large, and this poll runs
            // every attempt while the compaction result is already in flight.
            handle = await open(transcriptPath, 'r');
            const size = (await handle.stat()).size;
            if (size > minBytes) {
                const buf = Buffer.alloc(size - minBytes);
                // FileHandle.read() may fulfill fewer bytes than requested —
                // loop until the requested range is fully read (the session
                // scanner's incremental reader follows the same contract).
                let bytesRead = 0;
                while (bytesRead < buf.length) {
                    const result = await handle.read(buf, bytesRead, buf.length - bytesRead, minBytes + bytesRead);
                    if (result.bytesRead === 0) break;
                    bytesRead += result.bytesRead;
                }
                const summary = extractCompactSummaryFromTranscript(buf.toString('utf8'));
                if (summary !== null) return summary;
            }
        } catch {
            // Missing or unreadable transcript: keep polling until attempts run out.
        } finally {
            await handle?.close().catch(() => {});
        }
        if (attempt < attempts - 1) await sleep(intervalMs);
    }
    return null;
}
