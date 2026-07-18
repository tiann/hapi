import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyCodexThreadTitleToMetadata,
    applyHapiTitleToMetadata,
    createCodexThreadTitlePoller,
    readCodexThreadTitle,
    writeCodexThreadTitle,
    syncHapiMetadataTitleToCodexThread,
    syncCodexThreadTitleToMetadata
} from './codexThreadTitle';
import type { Metadata } from '@/api/types';

describe('Codex thread title sync', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('stores the desktop Codex thread title separately from changing HAPI summaries', () => {
        expect(applyCodexThreadTitleToMetadata({
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            summary: {
                text: 'Latest HAPI change_title summary',
                updatedAt: 1
            }
        }, 'Desktop Codex Title')).toEqual({
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            summary: {
                text: 'Latest HAPI change_title summary',
                updatedAt: 1
            },
            title: 'Desktop Codex Title'
        });
    });

    it('does not update metadata for blank Codex titles', async () => {
        const updates: unknown[] = [];
        const didSync = await syncCodexThreadTitleToMetadata({
            updateMetadata(handler: (metadata: Metadata) => Metadata) {
                updates.push(handler({ path: '/repo', host: 'mac' }));
            }
        }, 'thread-1', {
            readTitle: () => '   '
        });

        expect(didSync).toBe(false);
        expect(updates).toEqual([]);
    });

    it('pushes a readable Codex DB title through the HAPI session metadata channel', async () => {
        const updates: unknown[] = [];
        const didSync = await syncCodexThreadTitleToMetadata({
            updateMetadata(handler: (metadata: Metadata) => Metadata) {
                updates.push(handler({
                    path: '/repo',
                    host: 'mac',
                    flavor: 'codex',
                    codexSessionId: 'thread-1',
                    summary: {
                        text: 'HAPI title',
                        updatedAt: 1
                    }
                }));
            }
        }, 'thread-1', {
            readTitle: () => ' Desktop Codex Title '
        });

        expect(didSync).toBe(true);
        expect(updates).toEqual([{
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            summary: {
                text: 'HAPI title',
                updatedAt: 1
            },
            title: 'Desktop Codex Title'
        }]);
    });

    it('reads the latest Codex desktop thread name from session_index.jsonl', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codex-thread-title-test-'));
        try {
            const dbPath = join(dir, 'state_5.sqlite');
            const sessionIndexPath = join(dir, 'session_index.jsonl');
            execFileSync('sqlite3', [dbPath, `
                create table threads (
                    id text primary key,
                    title text,
                    updated_at_ms integer
                );
                insert into threads (id, title, updated_at_ms)
                values ('thread-1', 'SQLite Title', 1000);
            `]);
            execFileSync('sqlite3', [dbPath, 'select 1;']);
            writeFileSync(sessionIndexPath, [
                JSON.stringify({
                    id: 'thread-1',
                    thread_name: 'Desktop App Title',
                    updated_at: '2026-04-19T10:16:17.131288Z'
                }),
                ''
            ].join('\n'));

            expect(readCodexThreadTitle('thread-1', { dbPath, sessionIndexPath })).toBe('Desktop App Title');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('stores HAPI title changes in the shared Codex title field and clears stale HAPI-only names', () => {
        expect(applyHapiTitleToMetadata({
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            name: 'Old HAPI Name',
            title: 'Old Codex Title'
        }, 'New Shared Title', 1234)).toEqual({
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            title: 'New Shared Title',
            titleUpdatedAt: 1234
        });
    });

    it('writes HAPI title changes back to the Codex thread title store', async () => {
        const writes: unknown[] = [];
        const didSync = await syncHapiMetadataTitleToCodexThread({
            path: '/repo',
            host: 'mac',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            title: 'New Shared Title'
        }, {
            writeTitle: (threadId, title) => {
                writes.push({ threadId, title });
                return true;
            }
        });

        expect(didSync).toBe(true);
        expect(writes).toEqual([{ threadId: 'thread-1', title: 'New Shared Title' }]);
    });

    it('writes a HAPI title into a Codex thread that does not have a title yet', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codex-thread-title-test-'));
        try {
            const dbPath = join(dir, 'state_5.sqlite');
            execFileSync('sqlite3', [dbPath, `
                create table threads (
                    id text primary key,
                    title text,
                    updated_at integer,
                    updated_at_ms integer
                );
                insert into threads (id, title, updated_at, updated_at_ms)
                values ('thread-1', null, 0, 0);
            `]);

            expect(writeCodexThreadTitle('thread-1', 'First Shared Title', {
                dbPath,
                sessionIndexPath: join(dir, 'session_index.jsonl'),
                nowMs: 12_345
            })).toBe(true);

            const rows = JSON.parse(execFileSync('sqlite3', [
                '-json',
                dbPath,
                `select title, updated_at, updated_at_ms from threads where id = 'thread-1';`
            ], { encoding: 'utf8' }));

            expect(rows).toEqual([{
                title: 'First Shared Title',
                updated_at: 12,
                updated_at_ms: 12_345
            }]);

            const sessionIndexLines = readFileSync(join(dir, 'session_index.jsonl'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            expect(sessionIndexLines).toEqual([{
                id: 'thread-1',
                thread_name: 'First Shared Title',
                updated_at: '1970-01-01T00:00:12.345Z'
            }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('polls the Codex thread title while a HAPI runner session is idle', async () => {
        vi.useFakeTimers();
        const syncs: string[] = [];
        let threadId: string | null = 'thread-1';

        const poller = createCodexThreadTitlePoller({
            client: { updateMetadata: () => {} },
            getThreadId: () => threadId,
            intervalMs: 100,
            syncTitle: async (_client, id) => {
                syncs.push(id);
                return true;
            }
        });

        await vi.advanceTimersByTimeAsync(250);
        threadId = null;
        await vi.advanceTimersByTimeAsync(100);
        poller.stop();

        expect(syncs).toEqual(['thread-1', 'thread-1']);
    });
});
