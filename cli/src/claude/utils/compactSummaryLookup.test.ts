import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCompactSummaryFromTranscript, findLatestCompactSummary } from './compactSummaryLookup';

function entry(text: string, isCompactSummary = true): string {
    return JSON.stringify({
        type: 'user',
        uuid: `u-${Math.random().toString(36).slice(2)}`,
        isCompactSummary,
        message: { role: 'user', content: text },
        sessionId: 's-1'
    });
}

describe('extractCompactSummaryFromTranscript', () => {
    it('returns the text of the last isCompactSummary entry', () => {
        const content = [
            entry('older summary'),
            entry('not a summary', false),
            entry('newer summary')
        ].join('\n');

        expect(extractCompactSummaryFromTranscript(content)).toBe('newer summary');
    });

    it('returns null when no entry carries isCompactSummary', () => {
        const content = [entry('plain turn', false)].join('\n');
        expect(extractCompactSummaryFromTranscript(content)).toBeNull();
    });

    it('returns null for empty or malformed lines without throwing', () => {
        expect(extractCompactSummaryFromTranscript('')).toBeNull();
        expect(extractCompactSummaryFromTranscript('{broken json\n[]\n')).toBeNull();
    });

    it('extracts joined text from array-style message content', () => {
        const content = JSON.stringify({
            type: 'user',
            uuid: 'u-1',
            isCompactSummary: true,
            message: { role: 'user', content: [{ type: 'text', text: 'part one\n' }, { type: 'text', text: 'part two' }] }
        });

        expect(extractCompactSummaryFromTranscript(content)).toBe('part one\npart two');
    });
});

describe('findLatestCompactSummary', () => {
    it('ignores summaries written before the baseline offset', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'compact-summary-'));
        try {
            const filePath = join(dir, 's-1.jsonl');
            const stale = entry('stale summary from a previous compaction') + '\n';
            await writeFile(filePath, stale);
            const baselineBytes = Buffer.byteLength(stale, 'utf8');
            // A resumed or second-compact session already carries a summary row.
            // With the baseline recorded before the new compaction started, the
            // stale row must not satisfy the lookup while the new row is delayed.
            const pending = findLatestCompactSummary(filePath, {
                attempts: 3,
                intervalMs: 5,
                sleep: async () => {},
                minBytes: baselineBytes
            });
            await new Promise((r) => setTimeout(r, 20));
            expect(await pending).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns only the summary written after the baseline offset', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'compact-summary-'));
        try {
            const filePath = join(dir, 's-1.jsonl');
            const stale = entry('stale summary') + '\n';
            await writeFile(filePath, stale);
            const baselineBytes = Buffer.byteLength(stale, 'utf8');
            const pending = findLatestCompactSummary(filePath, {
                attempts: 5,
                intervalMs: 5,
                sleep: async () => {},
                minBytes: baselineBytes
            });
            await writeFile(filePath, stale + entry('fresh summary') + '\n');
            await expect(pending).resolves.toBe('fresh summary');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('resolves the summary once the transcript contains an isCompactSummary entry', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'compact-summary-'));
        try {
            const filePath = join(dir, 's-1.jsonl');
            const sleeps: number[] = [];
            const pending = findLatestCompactSummary(filePath, {
                attempts: 5,
                intervalMs: 7,
                sleep: async (ms) => { sleeps.push(ms); }
            });
            await writeFile(filePath, entry('late summary') + '\n');
            await expect(pending).resolves.toBe('late summary');
            expect(sleeps.length).toBeGreaterThan(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns null after exhausting attempts when the entry never appears', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'compact-summary-'));
        try {
            const filePath = join(dir, 'missing.jsonl');
            const summary = await findLatestCompactSummary(filePath, {
                attempts: 3,
                intervalMs: 1,
                sleep: async () => {}
            });
            expect(summary).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('stops polling when aborted', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'compact-summary-'));
        try {
            const controller = new AbortController();
            const pending = findLatestCompactSummary(join(dir, 'missing.jsonl'), {
                attempts: 10,
                intervalMs: 10_000,
                signal: controller.signal
            });
            controller.abort();
            await expect(pending).resolves.toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
