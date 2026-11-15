import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A per-root admission barrier, held until the hub acknowledges its durable truncate.
 * An uncertain native mutation is never unlocked by a timer or process restart. */
export class SharedRewindBarrier {
    private token?: string;
    private completed?: string;
    private writers = 0;
    private completing?: Promise<void>;
    constructor(private readonly file: string) {}

    get blocked(): boolean { return this.token !== undefined; }
    async load(): Promise<void> {
        try { await readFile(this.file); this.token = 'reconciliation-required'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    assertOpen(): void {
        if (this.blocked) throw new Error('Conversation rewind is pending or requires reconciliation; new operations are blocked');
    }
    enter(): () => void {
        this.assertOpen(); this.writers++;
        let released = false;
        return () => { if (!released) { released = true; this.writers--; } };
    }
    async begin(): Promise<string> {
        this.assertOpen();
        if (this.writers) throw new Error('Session has operations in flight');
        const token = this.token = randomUUID();
        try {
            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            await writeFile(this.file, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
        } catch (error) { this.token = undefined; throw error; }
        return token;
    }
    /** Only before native dispatch: rejection is proven, so no reconciliation is needed. */
    async cancel(): Promise<void> {
        await unlink(this.file); this.token = undefined;
    }
    async complete(token: string, reconcile: () => Promise<void>): Promise<void> {
        if (this.completing) await this.completing;
        if (!this.blocked && this.completed === token) return;
        if (!this.token || token !== this.token || token === 'reconciliation-required') throw new Error('Invalid rewind transaction');
        this.completing = (async () => {
            await reconcile();
            await unlink(this.file);
            this.completed = token; this.token = undefined;
        })();
        try { await this.completing; } finally { this.completing = undefined; }
    }
}

/** Reads do not change context; unknown/new native methods are writes by default. */
export function isNativeHistoryRead(method: string): boolean {
    return ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/queue/list',
        'thread/goal/get', 'thread/memory/read'].includes(method);
}
