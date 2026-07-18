import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GrokUpdateInterpreter, type GrokInterpreterEvent } from './GrokUpdateInterpreter';
import { logger } from '@/ui/logger';

export type GrokSessionScannerHandle = { cleanup(): Promise<void> };

export async function createGrokSessionScanner(opts: {
    sessionDir: string;
    skipExisting?: boolean;
    pollMs?: number;
    onEvent: (event: GrokInterpreterEvent) => void;
}): Promise<GrokSessionScannerHandle> {
    const file = join(opts.sessionDir, 'updates.jsonl');
    const interpreter = new GrokUpdateInterpreter(opts.onEvent);
    let offset = 0;
    let carry = '';
    let stopped = false;
    let busy = false;

    if (opts.skipExisting) {
        try { offset = (await stat(file)).size; } catch { offset = 0; }
    }

    const handleLine = (line: string) => {
        if (!line.trim()) return;
        try {
            const record = JSON.parse(line) as { method?: unknown; params?: unknown };
            if (typeof record.method === 'string') interpreter.handle(record.method, record.params);
        } catch (error) {
            logger.debug('[grok-storage] Invalid updates.jsonl entry', error);
        }
    };

    const poll = async (force = false) => {
        if ((!force && stopped) || busy) return;
        busy = true;
        let handle;
        try {
            const stats = await stat(file);
            const size = stats.size;
            if (size < offset) {
                offset = 0;
                carry = '';
            }
            if (size === offset) return;

            handle = await open(file, 'r');
            const length = size - offset;
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            offset += bytesRead;

            const chunk = buffer.subarray(0, bytesRead).toString('utf8');
            const lines = (carry + chunk).split(/\r?\n/u);
            carry = lines.pop() ?? '';
            for (const line of lines) handleLine(line);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') logger.debug('[grok-storage] Failed to tail updates.jsonl', error);
        } finally {
            if (handle) {
                try {
                    await handle.close();
                } catch (e) {
                    logger.debug('[grok-storage] Failed to close handle', e);
                }
            }
            busy = false;
        }
    };

    const interval = setInterval(() => { void poll(); }, opts.pollMs ?? 100);
    await poll();
    return {
        async cleanup() {
            stopped = true;
            clearInterval(interval);
            while (busy) await new Promise((resolve) => setTimeout(resolve, 5));
            await poll(true);
            const finalLine = carry;
            carry = '';
            handleLine(finalLine);
            interpreter.flush();
        }
    };
}
