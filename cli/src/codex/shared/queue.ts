import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { isIndeterminateError } from '../codexAppServerClient';

const InputSchema = z.array(z.object({ type: z.string() }).passthrough());
export const SubmissionSchema = z.object({ id: z.string(), input: InputSchema, clientUserMessageId: z.string() });
const LedgerSchema = z.record(z.string(), z.object({
    input: InputSchema, state: z.enum(['unknown', 'queued', 'consumed', 'canceled', 'rejected', 'released']), nativeId: z.string().optional()
}));
export type QueueInput = z.infer<typeof InputSchema>;
type Entry = z.infer<typeof LedgerSchema>[string];

/** Native queue is the only drainer. The ledger records uncertainty, not a second queue. */
export class SharedCodexQueue {
    private entries: Record<string, Entry> = {};
    private operations: Promise<unknown> = Promise.resolve();
    private writes = Promise.resolve();
    constructor(private readonly client: Pick<CodexAppServerClient, 'request'>, readonly threadId: string,
        private readonly file: string, private readonly consumed: (ids: string[], steered?: boolean) => void,
        private readonly uncertain: (ids: string[]) => void,
        private readonly mirror?: (id: string, input: QueueInput | null) => void,
        private readonly requeued?: (ids: string[]) => Promise<unknown>) {}

    async load(): Promise<void> {
        try { this.entries = LedgerSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }

    private save(): Promise<void> {
        const snapshot = JSON.stringify(this.entries);
        this.writes = this.writes.catch(() => {}).then(async () => {
            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            const temp = `${this.file}.${randomUUID()}.tmp`;
            await writeFile(temp, snapshot, { mode: 0o600 });
            await rename(temp, this.file);
        });
        return this.writes;
    }
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.operations.catch(() => {}).then(work); this.operations = next; return next;
    }
    owns(id: string): boolean { return id in this.entries; }
    state(id: string): Entry['state'] | undefined { return this.entries[id]?.state; }
    /** Slash commands can mutate native state too. Crash/redelivery must not
     * repeat /new, /compact, or a settings change whose outcome was lost. */
    command(id: string, work: () => Promise<string | null>): Promise<string | null> {
        return this.serial(async () => {
            const existing = this.entries[id];
            if (existing?.state === 'consumed') { this.consumed([id]); return null; }
            if (existing && !['rejected', 'canceled'].includes(existing.state)) {
                this.uncertain([id]); throw new Error('Previous command outcome is unknown; not replaying');
            }
            this.entries[id] = { input: [], state: 'unknown' }; await this.save();
            try {
                const result = await work();
                if (result === null) await this.committed(id);
                else { delete this.entries[id]; await this.save(); }
                return result;
            } catch (error) { this.uncertain([id]); throw error; }
        });
    }
    async committed(id: string): Promise<void> {
        // History may prove acceptance after execution replacement, before hub
        // redelivery. Remember it even when this generation did not enqueue it.
        const entry = this.entries[id] ??= { state: 'consumed', input: [] };
        entry.state = 'consumed';
        await this.save(); this.consumed([id]);
    }

    async list(): Promise<Array<z.infer<typeof SubmissionSchema>>> {
        const items: Array<z.infer<typeof SubmissionSchema>> = [];
        let cursor: string | undefined;
        do {
            const page = z.object({ data: z.array(SubmissionSchema), nextCursor: z.string().nullish() }).parse(
                await this.client.request('thread/queue/list', { threadId: this.threadId, cursor }));
            items.push(...page.data); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return items;
    }
    reconcile(): Promise<void> { return this.serial(() => this.reconcileNow()); }
    private async reconcileNow(): Promise<void> {
        const present = new Set<string>();
        for (const item of await this.list()) {
            const id = item.clientUserMessageId; present.add(id);
            const entry = this.entries[id] ??= { input: item.input, state: 'queued' };
            if (entry.state !== 'consumed' && entry.state !== 'canceled') {
                const changed = entry.nativeId !== item.id || JSON.stringify(entry.input) !== JSON.stringify(item.input);
                entry.nativeId = item.id; entry.input = item.input; entry.state = 'queued';
                if (changed) this.mirror?.(id, item.input);
            }
        }
        // Absence could mean consumed, removed, or lost during engine restart.
        // Only an item event/history or a successful delete can decide which.
        for (const [id, entry] of Object.entries(this.entries)) {
            if (entry.state === 'queued' && !present.has(id)) entry.state = 'unknown';
        }
        await this.save();
        const unknown = Object.entries(this.entries).filter(([, entry]) => entry.state === 'unknown').map(([id]) => id);
        if (unknown.length) this.uncertain(unknown);
        await this.publishReleased();
    }

    private async publishReleased(): Promise<void> {
        const released = Object.entries(this.entries).filter(([, entry]) => entry.state === 'released');
        for (const [id, entry] of released) this.mirror?.(id, entry.input);
        // A crash between the ledger write and hub ACK is recovered on bind,
        // before the existing hub replay delivers these messages again.
        if (released.length) await this.requeued?.(released.map(([id]) => id));
    }

    /** Return proven unexecuted input to the hub's existing resume queue.
     * Run only after all frontends stop submitting; no second native drainer. */
    suspend(): Promise<void> {
        return this.serial(async () => {
            try { await this.reconcileNow(); } catch {
                // Without a fresh snapshot even the input may have been edited.
                // Do not delete and later restore stale contents from the ledger.
                const unknown: string[] = [];
                for (const [id, entry] of Object.entries(this.entries)) {
                    if (entry.state === 'queued') entry.state = 'unknown';
                    if (entry.state === 'unknown') unknown.push(id);
                }
                await this.save(); if (unknown.length) this.uncertain(unknown);
                return;
            }
            for (const [id, entry] of Object.entries(this.entries)) {
                if (!['queued', 'unknown'].includes(entry.state)) continue;
                // Persist uncertainty before deletion; a lost ACK cannot authorize replay.
                entry.state = 'unknown'; await this.save();
                if (entry.nativeId) {
                    try {
                        const result = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                            threadId: this.threadId, queuedSubmissionId: entry.nativeId
                        }));
                        if (result.deleted && this.state(id) !== 'consumed') entry.state = 'released';
                    } catch { /* Keep unknown unless an item event proved consumption. */ }
                }
                await this.save();
                if (entry.state === 'unknown') this.uncertain([id]);
            }
            await this.publishReleased();
        });
    }

    /** Successful native deletion, observed at the gateway response barrier. */
    deleted(nativeId: string): Promise<void> {
        return this.serial(async () => {
            for (const [id, entry] of Object.entries(this.entries)) {
                if (entry.nativeId !== nativeId || entry.state === 'consumed') continue;
                entry.state = 'canceled'; await this.save(); this.mirror?.(id, null);
            }
        });
    }

    replay(): void {
        for (const [id, entry] of Object.entries(this.entries)) {
            if (entry.state === 'queued' || entry.state === 'released') this.mirror?.(id, entry.input);
            if (entry.state === 'canceled') this.mirror?.(id, null);
        }
    }

    enqueue(id: string, input: QueueInput, resumeInterrupted = false): Promise<void> {
        return this.serial(async () => {
            const existing = this.entries[id];
            if (existing && !['rejected', 'canceled', 'released'].includes(existing.state)) {
                if (existing.state === 'consumed') this.consumed([id]);
                else await this.reconcileNow();
                return;
            }
            // Preserve native edits and non-text input when the hub redelivers.
            if (existing?.state === 'released') input = existing.input;
            const entry: Entry = { state: 'unknown', input };
            this.entries[id] = entry; await this.save();
            try {
                const response = z.object({ queuedSubmission: SubmissionSchema }).parse(await this.client.request('thread/queue/add', {
                    threadId: this.threadId, input, clientUserMessageId: id
                }));
                if (entry.state !== 'consumed') { entry.state = 'queued'; entry.nativeId = response.queuedSubmission.id; }
                await this.save();
                if (resumeInterrupted) {
                    // Atomic idle precondition upstream: a competing terminal cannot turn this into steer.
                    await this.client.request('thread/queue/start', { threadId: this.threadId }).catch(() => {});
                }
            } catch (error) {
                if (entry.state !== 'consumed') {
                    entry.state = isIndeterminateError(error) || error instanceof z.ZodError ? 'unknown' : 'rejected';
                    await this.save();
                    if (entry.state === 'unknown') this.uncertain([id]);
                }
                throw error;
            }
        });
    }

    cancel(id: string): Promise<boolean | 'consumed' | 'indeterminate'> {
        return this.serial(async () => {
            const entry = this.entries[id];
            if (!entry) return 'indeterminate';
            if (entry.state === 'consumed') return 'consumed';
            if (entry.state === 'canceled' || entry.state === 'rejected' || entry.state === 'released') {
                entry.state = 'canceled'; await this.save(); return true;
            }
            try { await this.reconcileNow(); }
            catch { this.uncertain([id]); return 'indeterminate'; }
            if (this.state(id) === 'consumed') return 'consumed';
            if (!entry.nativeId) return 'indeterminate';
            entry.state = 'unknown'; await this.save();
            try {
                const result = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                    threadId: this.threadId, queuedSubmissionId: entry.nativeId
                }));
                if (this.state(id) === 'consumed') return 'consumed';
                if (result.deleted) { entry.state = 'canceled'; await this.save(); return true; }
                this.uncertain([id]); return 'indeterminate';
            } catch { this.uncertain([id]); return 'indeterminate'; }
        });
    }

    steer(id: string, expectedTurnId: string, freshInput?: QueueInput): Promise<{ steered: boolean; indeterminate?: boolean; error?: string }> {
        return this.serial(async () => {
            let entry = this.entries[id];
            if (entry?.state === 'consumed') return { steered: false, error: 'Message already consumed' };
            if (entry) {
                try { await this.reconcileNow(); }
                catch { this.uncertain([id]); return { steered: false, indeterminate: true }; }
                if (this.state(id) === 'consumed') return { steered: false, error: 'Message already consumed' };
                if (!entry.nativeId || entry.state !== 'queued') return { steered: false, indeterminate: true };
                entry.state = 'unknown'; await this.save();
                try {
                    const response = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                        threadId: this.threadId, queuedSubmissionId: entry.nativeId
                    }));
                    if (!response.deleted) { this.uncertain([id]); return { steered: false, indeterminate: true }; }
                } catch { this.uncertain([id]); return { steered: false, indeterminate: true }; }
            } else if (freshInput) {
                entry = { input: freshInput, state: 'unknown' }; this.entries[id] = entry; await this.save();
            } else return { steered: false, error: 'Message not queued' };
            try {
                await this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId, input: entry.input, clientUserMessageId: id });
                entry.state = 'consumed'; await this.save(); this.consumed([id], true); return { steered: true };
            } catch (error) {
                if (this.state(id) === 'consumed') return { steered: true };
                if (isIndeterminateError(error)) { this.uncertain([id]); return { steered: false, indeterminate: true }; }
                // Definitely rejected; restoring a removed queued item is safe. Never restore an unknown dispatch.
                if (!freshInput) {
                    try {
                        const response = z.object({ queuedSubmission: SubmissionSchema }).parse(await this.client.request('thread/queue/add', {
                            threadId: this.threadId, input: entry.input, clientUserMessageId: id
                        }));
                        if (entry.state !== 'consumed') { entry.state = 'queued'; entry.nativeId = response.queuedSubmission.id; }
                    } catch { if (this.state(id) !== 'consumed') { entry.state = 'unknown'; this.uncertain([id]); } }
                } else entry.state = 'rejected';
                await this.save(); return { steered: false, error: error instanceof Error ? error.message : String(error) };
            }
        });
    }

    async flush(): Promise<void> { await this.operations.catch(() => {}); await this.writes; }
}
