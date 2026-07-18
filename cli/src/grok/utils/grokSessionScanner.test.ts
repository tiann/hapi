import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGrokSessionScanner } from './grokSessionScanner';

describe('createGrokSessionScanner', () => {
    it('tails only the exact session updates file and preserves extension notifications', async () => {
        const root = await mkdtemp(join(tmpdir(), 'grok-scanner-'));
        const sessionDir = join(root, 'session');
        await mkdir(sessionDir);
        const updates = join(sessionDir, 'updates.jsonl');
        await writeFile(updates, JSON.stringify({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } } }) + '\n');
        const seen: any[] = [];
        const scanner = await createGrokSessionScanner({ sessionDir, skipExisting: true, pollMs: 10, onEvent: (event) => seen.push(event) });
        await appendFile(updates, JSON.stringify({ method: '_x.ai/future', params: { value: 1 } }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 60));
        await scanner.cleanup();
        expect(seen).toEqual([{ type: 'unknown', method: '_x.ai/future', params: { value: 1 } }]);
        await rm(root, { recursive: true, force: true });
    });

    it('final-polls and emits one unterminated JSONL record appended immediately before cleanup', async () => {
        const root = await mkdtemp(join(tmpdir(), 'grok-scanner-final-'));
        const sessionDir = join(root, 'session');
        await mkdir(sessionDir);
        const updates = join(sessionDir, 'updates.jsonl');
        await writeFile(updates, '');
        const seen: any[] = [];
        const scanner = await createGrokSessionScanner({
            sessionDir,
            pollMs: 60_000,
            onEvent: (event) => seen.push(event)
        });

        await appendFile(updates, JSON.stringify({
            method: '_x.ai/final-event',
            params: { value: 1 }
        }));
        await scanner.cleanup();

        expect(seen).toEqual([{
            type: 'unknown',
            method: '_x.ai/final-event',
            params: { value: 1 }
        }]);
        await rm(root, { recursive: true, force: true });
    });
});
