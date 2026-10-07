import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { isIndeterminateError } from '../codexAppServerClient';

const InputSchema = z.array(z.object({ type: z.string() }).passthrough());
export const SubmissionSchema = z.object({ id: z.string(), input: InputSchema, clientUserMessageId: z.string() });
const StateSchema = z.enum(['unknown', 'queued', 'consumed', 'canceled', 'rejected', 'released']);
const EntrySchema = z.object({
    input: InputSchema, state: StateSchema, nativeId: z.string().optional(), batchId: z.string().optional()
});
const MemberSchema = z.object({ id: z.string(), input: InputSchema });
const RemovalSchema = z.object({
    id: z.string(), input: InputSchema, intent: z.enum(['cancel', 'replace', 'steer']).default('cancel')
});
const VersionSchema = z.object({
    input: InputSchema, members: z.array(MemberSchema), removed: z.array(RemovalSchema).optional(),
    status: z.enum(['eligible', 'superseded', 'consumed']).default('eligible')
});
const BatchSchema = z.object({
    clientId: z.string(), nativeId: z.string(), key: z.string(), state: StateSchema,
    current: z.number().int().nonnegative().default(0), versions: z.array(VersionSchema)
});
const LedgerSchema = z.record(z.string(), EntrySchema);
const LedgerV2Schema = z.object({
    version: z.literal(2), entries: LedgerSchema, batches: z.record(z.string(), BatchSchema)
});
export type QueueInput = z.infer<typeof InputSchema>;
type Entry = z.infer<typeof EntrySchema>;
type Member = z.infer<typeof MemberSchema>;
type Removal = z.infer<typeof RemovalSchema>;
type Version = z.infer<typeof VersionSchema>;
type Batch = z.infer<typeof BatchSchema>;
type Submission = z.infer<typeof SubmissionSchema>;

const NATIVE_MUTATIONS = new Set([
    'thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start'
]);

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
/** Normalize only the documented absent-versus-empty text_elements representation, never text bytes. */
function normalizeContent(value: unknown): string {
    const parts = Array.isArray(value) ? value : record(value).text_elements;
    if (!Array.isArray(parts)) return '[]';
    return JSON.stringify(parts.map(part => {
        const source = record(part); const copy: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            if (key === 'text_elements') {
                if (Array.isArray(source[key]) && (source[key] as unknown[]).length > 0) copy[key] = source[key];
                continue;
            }
            copy[key] = source[key];
        }
        return copy;
    }));
}
/** Only a proven native rejection may detach an unaccepted member; generic errors stay unknown. */
function queuedSubmissionNotFound(error: unknown): boolean {
    return error instanceof Error && /queued submission not found/i.test(error.message);
}
function indeterminate(error: unknown): boolean {
    return isIndeterminateError(error) || error instanceof z.ZodError;
}

/** Native queue is the only drainer. The ledger records uncertainty, not a second queue. */
export class SharedCodexQueue {
    private entries: Record<string, Entry> = {};
    private batches: Record<string, Batch> = {};
    private operations: Promise<unknown> = Promise.resolve();
    private writes = Promise.resolve();
    constructor(private readonly client: Pick<CodexAppServerClient, 'request'>, readonly threadId: string,
        private readonly file: string, private readonly consumed: (ids: string[], steered?: boolean) => void,
        private readonly uncertain: (ids: string[]) => void,
        private readonly mirror?: (id: string, input: QueueInput | null) => void,
        private readonly requeued?: (ids: string[]) => Promise<unknown>) {}

    async load(): Promise<void> {
        let raw: unknown;
        try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
        const current = LedgerV2Schema.safeParse(raw);
        if (current.success) { this.entries = current.data.entries; this.batches = current.data.batches; return; }
        // Old record-only ledger: no batches, entries are authoritative.
        this.entries = LedgerSchema.parse(raw); this.batches = {};
    }

    private save(): Promise<void> {
        const snapshot = JSON.stringify({ version: 2, entries: this.entries, batches: this.batches });
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

    private nativeIdFor(entry: Entry): string | undefined {
        // An append can lose its ACK before the new member receives nativeId.
        // Its persisted group still identifies the sole native submission.
        return (entry.batchId ? this.batches[entry.batchId]?.nativeId : undefined) || entry.nativeId;
    }

    private version(input: QueueInput, members: Member[], removed?: Removal[]): Version {
        return { input, members, ...(removed ? { removed } : {}), status: 'eligible' };
    }
    private currentVersion(batch: Batch): Version | undefined {
        return batch.versions[batch.current] ?? batch.versions.at(-1);
    }
    private memberInput(members: Member[]): QueueInput {
        return members.flatMap(member => member.input);
    }
    /** A confirmed atomic replacement or an authoritative matching newer queued
     * version supersedes older unconsumed versions. A consumed version is history. */
    private supersedeOlder(batch: Batch, version: Version): void {
        const index = batch.versions.indexOf(version);
        if (index < 0) return;
        for (let i = 0; i < index; i += 1) {
            if (batch.versions[i].status === 'eligible') batch.versions[i].status = 'superseded';
        }
        // Never revive a version an event-before-ACK already consumed.
        if (version.status !== 'consumed') version.status = 'eligible';
        batch.current = index;
    }
    /** Eligible versions only: a native tail must be an unconsumed applied version. */
    private matchVersion(batch: Batch, normalized: string): Version | undefined {
        const matches = batch.versions.filter(candidate => candidate.status === 'eligible' && normalizeContent(candidate.input) === normalized);
        return matches.length === 1 ? matches[0] : undefined;
    }
    /** Exact accepted content: an eligible version or an exact consumed replay, never superseded. */
    private matchAccepted(batch: Batch, normalized: string): Version | undefined {
        const matches = batch.versions.filter(candidate => candidate.status !== 'superseded' && normalizeContent(candidate.input) === normalized);
        return matches.length === 1 ? matches[0] : undefined;
    }
    /** Validate a native update response: same native id, same batch client id, accepted input. */
    private validateUpdate(response: unknown, batch: Batch, expected: QueueInput): void {
        const submission = z.object({ queuedSubmission: SubmissionSchema }).parse(response).queuedSubmission;
        if (submission.id !== batch.nativeId || submission.clientUserMessageId !== batch.clientId
            || normalizeContent(submission.input) !== normalizeContent(expected)) throw new z.ZodError([]);
    }
    private withdrawRemovals(version: Version): void {
        for (const removal of version.removed ?? []) {
            // Steer removals are owned by the steer path and must never be canceled here.
            if (removal.intent === 'steer') continue;
            const entry = this.entries[removal.id];
            if (entry && entry.state !== 'consumed') { entry.state = 'canceled'; this.mirror?.(removal.id, null); }
        }
    }

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

    /** History may prove acceptance after execution replacement, before hub
     * redelivery. For a batch synthetic client ID, only an exact accepted
     * content match may acknowledge that version's original members. */
    async committed(id: string): Promise<void>;
    async committed(id: string, actualContent: unknown): Promise<Array<{ id: string; input: QueueInput }> | undefined>;
    async committed(id: string, actualContent?: unknown): Promise<Array<{ id: string; input: QueueInput }> | undefined | void> {
        const batch = this.batches[id];
        if (!batch) {
            const entry = this.entries[id] ??= { state: 'consumed', input: [] };
            entry.state = 'consumed';
            await this.save(); this.consumed([id]);
            return undefined;
        }
        const version = this.matchAccepted(batch, normalizeContent(actualContent));
        // Unproven or ambiguous input never ACKs members and never creates a synthetic row.
        if (!version) {
            const affected = (this.currentVersion(batch)?.members ?? []).filter(member => {
                const entry = this.entries[member.id];
                return entry && entry.state !== 'consumed' && entry.state !== 'canceled';
            }).map(member => member.id);
            if (affected.length) this.uncertain(affected);
            return [];
        }
        for (const member of version.members) {
            const entry = this.entries[member.id];
            if (entry) {
                // The Hub only edits pending rows. Mirror accepted content before
                // the consumed ACK, including an event that precedes an edit RPC ACK.
                if (normalizeContent(entry.input) !== normalizeContent(member.input)) {
                    entry.input = member.input; this.mirror?.(member.id, member.input);
                }
                entry.state = 'consumed';
            }
        }
        this.withdrawRemovals(version);
        version.status = 'consumed';
        if (batch.versions[batch.current] === version && batch.state !== 'canceled') batch.state = 'consumed';
        await this.save();
        const ids = version.members.map(member => member.id);
        if (ids.length) this.consumed(ids);
        return version.members.map(member => ({ id: member.id, input: member.input }));
    }

    async list(): Promise<Submission[]> {
        const items: Submission[] = [];
        let cursor: string | undefined;
        do {
            const page = z.object({ data: z.array(SubmissionSchema), nextCursor: z.string().nullish() }).parse(
                await this.client.request('thread/queue/list', { threadId: this.threadId, cursor }));
            items.push(...page.data); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return items;
    }
    reconcile(): Promise<void> { return this.serial(() => this.reconcileLocked()); }
    private async reconcileLocked(): Promise<void> {
        const present = new Set<string>();
        const presentMembers = new Set<string>();
        for (const item of await this.list()) {
            const id = item.clientUserMessageId; present.add(id);
            const batch = this.batches[id];
            if (batch) { this.reconcileBatch(batch, item, presentMembers); continue; }
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
            if (entry.state !== 'queued') continue;
            if (entry.batchId ? !presentMembers.has(id) : !present.has(id)) entry.state = 'unknown';
        }
        for (const batch of Object.values(this.batches)) {
            if (!present.has(batch.clientId) && batch.state === 'queued') batch.state = 'unknown';
        }
        await this.save();
        const unknown = Object.entries(this.entries).filter(([, entry]) => entry.state === 'unknown').map(([id]) => id);
        if (unknown.length) this.uncertain(unknown);
        await this.publishReleased();
    }
    /** Mirror original members, never the synthetic batch client ID as a user row. */
    private reconcileBatch(batch: Batch, item: Submission, presentMembers: Set<string>): void {
        const normalized = normalizeContent(item.input);
        const matches = batch.versions.map((version, index) => ({ version, index }))
            .filter(candidate => candidate.version.status === 'eligible' && normalizeContent(candidate.version.input) === normalized);
        // Ambiguous authoritative proof: change nothing and fail closed.
        if (matches.length > 1) return;
        if (matches.length === 1) {
            const { version, index } = matches[0];
            // An older snapshot cannot prove an unresolved newer proposal failed.
            if (index >= batch.current) {
                this.supersedeOlder(batch, version);
                if (batch.state !== 'consumed' && batch.state !== 'canceled' && batch.state !== 'released') batch.state = 'queued';
            }
            batch.nativeId = item.id;
            this.adoptMembers(version, item, presentMembers);
            return;
        }
        // No known version: a native whole edit replaces group content.
        const applied = this.currentVersion(batch);
        const first = applied?.members.find(member => {
            const entry = this.entries[member.id];
            return !entry || (entry.state !== 'consumed' && entry.state !== 'canceled');
        });
        if (!first) return;
        const replaced: Removal[] = (applied?.members ?? []).filter(member => member.id !== first.id)
            .map(member => ({ id: member.id, input: member.input, intent: 'replace' as const }));
        const replacement = this.version(item.input, [{ id: first.id, input: item.input }], replaced);
        batch.versions.push(replacement); this.supersedeOlder(batch, replacement);
        batch.nativeId = item.id; batch.state = 'queued';
        for (const removal of replaced) {
            const entry = this.entries[removal.id];
            if (entry && entry.state !== 'consumed' && entry.state !== 'canceled') {
                entry.state = 'canceled'; this.mirror?.(removal.id, null);
            }
        }
        this.adoptMembers(replacement, item, presentMembers);
    }
    private adoptMembers(version: Version, item: Submission, presentMembers: Set<string>): void {
        for (const member of version.members) {
            presentMembers.add(member.id);
            const entry = this.entries[member.id] ??= { input: member.input, state: 'queued' };
            if (entry.state === 'consumed' || entry.state === 'canceled') continue;
            const changed = entry.nativeId !== item.id || JSON.stringify(entry.input) !== JSON.stringify(member.input);
            entry.nativeId = item.id; entry.input = member.input; entry.state = 'queued';
            if (changed) this.mirror?.(member.id, member.input);
        }
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
            try { await this.reconcileLocked(); } catch {
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
            const attempted = new Set<string>(); const deleted = new Set<string>();
            for (const [id, entry] of Object.entries(this.entries)) {
                if (!['queued', 'unknown'].includes(entry.state)) continue;
                // Persist uncertainty before deletion; a lost ACK cannot authorize replay.
                entry.state = 'unknown'; await this.save();
                const nativeId = this.nativeIdFor(entry);
                if (nativeId && !attempted.has(nativeId)) {
                    attempted.add(nativeId);
                    try {
                        const result = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                            threadId: this.threadId, queuedSubmissionId: nativeId
                        }));
                        if (result.deleted && this.state(id) !== 'consumed') deleted.add(nativeId);
                    } catch { /* Keep unknown unless an item event proved consumption. */ }
                }
                await this.save();
            }
            // A whole-submission delete proves every member of that submission gone.
            for (const [id, entry] of Object.entries(this.entries)) {
                const nativeId = this.nativeIdFor(entry);
                if (entry.state === 'unknown' && nativeId && deleted.has(nativeId)) entry.state = 'released';
            }
            for (const batch of Object.values(this.batches)) {
                if (deleted.has(batch.nativeId) && batch.state !== 'consumed') batch.state = 'released';
                else if (batch.state === 'queued') batch.state = 'unknown';
            }
            await this.save();
            const unknown = Object.entries(this.entries).filter(([, entry]) => entry.state === 'unknown').map(([id]) => id);
            if (unknown.length) this.uncertain(unknown);
            await this.publishReleased();
        });
    }

    /** Successful native deletion, observed at the gateway response barrier. */
    deleted(nativeId: string): Promise<void> {
        return this.serial(() => this.deletedLocked(nativeId));
    }
    private async deletedLocked(nativeId: string): Promise<void> {
        for (const [id, entry] of Object.entries(this.entries)) {
            if (this.nativeIdFor(entry) !== nativeId || entry.state === 'consumed') continue;
            entry.state = 'canceled'; this.mirror?.(id, null);
        }
        for (const batch of Object.values(this.batches)) {
            if (batch.nativeId === nativeId && batch.state !== 'consumed') batch.state = 'canceled';
        }
        await this.save();
    }

    /** Locked passthrough for external native queue mutations so no CAS race
     * can interleave with queue writes. Whole edits/deletes journal first. */
    nativeMutation(method: string, params: unknown): Promise<unknown> {
        return this.serial(async () => {
            if (!NATIVE_MUTATIONS.has(method)) throw new Error(`Unsupported native queue mutation: ${method}`);
            if (method === 'thread/queue/update') return await this.nativeUpdate(params);
            const values = record(params);
            const nativeId = string(values.queuedSubmissionId);
            if (method === 'thread/queue/delete' && nativeId) {
                // Journal group/member uncertainty before the RPC so a lost
                // response cannot authorize replay.
                for (const entry of Object.values(this.entries)) {
                    if (this.nativeIdFor(entry) === nativeId && ['queued', 'unknown'].includes(entry.state)) entry.state = 'unknown';
                }
                for (const batch of Object.values(this.batches)) {
                    if (batch.nativeId === nativeId && ['queued', 'unknown'].includes(batch.state)) batch.state = 'unknown';
                }
                await this.save();
            }
            const response = await this.client.request(method, values);
            if (method === 'thread/queue/delete' && nativeId && record(response).deleted === true) await this.deletedLocked(nativeId);
            return response;
        });
    }
    private async nativeUpdate(params: unknown): Promise<unknown> {
        const values = record(params);
        const nativeId = string(values.queuedSubmissionId);
        const input = InputSchema.parse(values.input);
        const batch = nativeId ? Object.values(this.batches).find(candidate => candidate.nativeId === nativeId) : undefined;
        if (!batch) return await this.client.request('thread/queue/update', values);
        // Persist the edit proposal before the RPC so an event arriving first can prove replacement.
        const applied = this.currentVersion(batch);
        const first = applied?.members.find(member => {
            const entry = this.entries[member.id];
            return !entry || (entry.state !== 'consumed' && entry.state !== 'canceled');
        });
        const replaced: Removal[] = (applied?.members ?? []).filter(member => member.id !== first?.id)
            .map(member => ({ id: member.id, input: member.input, intent: 'replace' as const }));
        const proposal = this.version(input, first ? [{ id: first.id, input }] : [], replaced);
        batch.versions.push(proposal); batch.current = batch.versions.length - 1;
        await this.save();
        try {
            const response = await this.client.request('thread/queue/update', values);
            this.validateUpdate(response, batch, input);
            this.supersedeOlder(batch, proposal);
            // Replaced members are withdrawn only after a definitive update response.
            for (const removal of replaced) {
                const entry = this.entries[removal.id];
                if (entry && entry.state !== 'consumed' && entry.state !== 'canceled') {
                    entry.state = 'canceled'; this.mirror?.(removal.id, null);
                }
            }
            if (first) {
                const entry = this.entries[first.id];
                if (entry && entry.state !== 'consumed') {
                    if (normalizeContent(entry.input) !== normalizeContent(input)) this.mirror?.(first.id, input);
                    entry.input = input; entry.state = 'queued';
                }
            }
            if (batch.state !== 'consumed' && batch.state !== 'canceled') batch.state = 'queued';
            await this.save();
            return response;
        } catch (error) {
            if (indeterminate(error)) { proposal.status = 'eligible'; batch.state = 'unknown'; }
            else { proposal.status = 'superseded'; batch.current = batch.versions.length - 2; }
            await this.save();
            throw error;
        }
    }

    replay(): void {
        for (const [id, entry] of Object.entries(this.entries)) {
            if (entry.state === 'queued' || entry.state === 'released') this.mirror?.(id, entry.input);
            if (entry.state === 'canceled') this.mirror?.(id, null);
        }
    }

    enqueue(id: string, input: QueueInput, resumeInterrupted = false, batchKey?: string): Promise<void> {
        return this.serial(() => batchKey ? this.enqueueBatched(id, input, resumeInterrupted, batchKey) : this.enqueueLegacy(id, input, resumeInterrupted));
    }
    private async enqueueLegacy(id: string, input: QueueInput, resumeInterrupted: boolean): Promise<void> {
        const existing = this.entries[id];
        if (existing && !['rejected', 'canceled', 'released'].includes(existing.state)) {
            if (existing.state === 'consumed') this.consumed([id]);
            else await this.reconcileLocked();
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
                entry.state = indeterminate(error) ? 'unknown' : 'rejected';
                await this.save();
                if (entry.state === 'unknown') this.uncertain([id]);
            }
            throw error;
        }
    }
    private async enqueueBatched(id: string, input: QueueInput, resumeInterrupted: boolean, batchKey: string): Promise<void> {
        const existing = this.entries[id];
        if (existing && !['rejected', 'canceled', 'released'].includes(existing.state)) {
            if (existing.state === 'consumed') this.consumed([id]);
            else await this.reconcileLocked();
            return;
        }
        if (existing?.state === 'released') input = existing.input;
        const entry: Entry = { state: 'unknown', input };
        this.entries[id] = entry; await this.save();
        const tail = (await this.list()).at(-1);
        const batch = tail ? this.batches[tail.clientUserMessageId] : undefined;
        // Never cross a mode boundary, and never extend a tail whose own append/update outcome is still unknown.
        const version = batch && batch.state === 'queued' && batch.key === batchKey
            ? this.matchVersion(batch, normalizeContent(tail?.input)) : undefined;
        if (batch && version) { await this.extendBatch(batch, version, entry, id, input, resumeInterrupted); return; }
        await this.createBatch(entry, id, input, resumeInterrupted, batchKey);
    }
    private async extendBatch(batch: Batch, version: Version, entry: Entry, id: string, input: QueueInput, resumeInterrupted: boolean): Promise<void> {
        entry.batchId = batch.clientId;
        const proposal = this.version([...version.input, ...input], [...version.members, { id, input }]);
        batch.versions.push(proposal); batch.current = batch.versions.length - 1;
        await this.save();
        try {
            const response = await this.client.request('thread/queue/update', {
                threadId: this.threadId, queuedSubmissionId: batch.nativeId, input: proposal.input
            });
            this.validateUpdate(response, batch, proposal.input);
            this.supersedeOlder(batch, proposal);
            if (entry.state !== 'consumed') { entry.state = 'queued'; entry.nativeId = batch.nativeId; }
            if (batch.state !== 'consumed' && batch.state !== 'canceled') batch.state = 'queued';
            await this.save();
            if (resumeInterrupted) await this.client.request('thread/queue/start', { threadId: this.threadId }).catch(() => {});
        } catch (error) {
            if (entry.state === 'consumed') return;
            if (queuedSubmissionNotFound(error)) {
                // Proven unaccepted: detach only this new member and enqueue it normally.
                batch.versions.pop(); batch.current = batch.versions.length - 1;
                delete entry.batchId; batch.state = 'unknown';
                await this.save();
                await this.createBatch(entry, id, input, resumeInterrupted, batch.key);
                return;
            }
            if (indeterminate(error)) { entry.state = 'unknown'; batch.state = 'unknown'; this.uncertain([id]); }
            else { entry.state = 'rejected'; proposal.status = 'superseded'; batch.current = batch.versions.length - 2; }
            await this.save();
            throw error;
        }
    }
    private async createBatch(entry: Entry, id: string, input: QueueInput, resumeInterrupted: boolean, batchKey: string): Promise<void> {
        // Never reuse an original member ID as the native client ID: steering a
        // member must not collide with batch consumption.
        const clientId = `hapi-batch-${randomUUID()}`;
        const batch: Batch = { clientId, nativeId: '', key: batchKey, state: 'unknown', current: 0,
            versions: [this.version(input, [{ id, input }])] };
        this.batches[clientId] = batch; entry.batchId = clientId;
        await this.save();
        try {
            const response = z.object({ queuedSubmission: SubmissionSchema }).parse(await this.client.request('thread/queue/add', {
                threadId: this.threadId, input, clientUserMessageId: clientId
            }));
            batch.nativeId = response.queuedSubmission.id;
            if (entry.state !== 'consumed') { entry.state = 'queued'; entry.nativeId = response.queuedSubmission.id; batch.state = 'queued'; }
            await this.save();
            if (resumeInterrupted) await this.client.request('thread/queue/start', { threadId: this.threadId }).catch(() => {});
        } catch (error) {
            if (entry.state !== 'consumed') {
                entry.state = indeterminate(error) ? 'unknown' : 'rejected';
                batch.state = entry.state === 'unknown' ? 'unknown' : 'rejected';
                await this.save();
                if (entry.state === 'unknown') this.uncertain([id]);
            }
            throw error;
        }
    }

    cancel(id: string): Promise<boolean | 'consumed' | 'indeterminate'> {
        return this.serial(async () => {
            const entry = this.entries[id];
            if (!entry) return 'indeterminate';
            if (entry.state === 'consumed') return 'consumed';
            if (entry.state === 'canceled' || entry.state === 'rejected' || entry.state === 'released') {
                entry.state = 'canceled'; await this.save(); return true;
            }
            if (entry.batchId) return this.cancelBatchMember(entry, id);
            try { await this.reconcileLocked(); }
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
    private async cancelBatchMember(entry: Entry, id: string): Promise<boolean | 'consumed' | 'indeterminate'> {
        const batch = this.batches[entry.batchId!];
        if (!batch) return 'indeterminate';
        try { await this.reconcileLocked(); }
        catch { this.uncertain([id]); return 'indeterminate'; }
        if (this.state(id) === 'consumed') return 'consumed';
        // Fail closed while the group's native content is unresolved: no replacement write.
        if (batch.state !== 'queued') return 'indeterminate';
        const version = this.currentVersion(batch);
        const member = version?.members.find(candidate => candidate.id === id);
        if (!version || !member) return 'indeterminate';
        const survivors = version.members.filter(candidate => candidate.id !== id);
        if (survivors.length === 0) {
            // Delete the native submission only when removing the final member.
            entry.state = 'unknown'; batch.state = 'unknown'; await this.save();
            try {
                const result = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                    threadId: this.threadId, queuedSubmissionId: batch.nativeId
                }));
                if (this.state(id) === 'consumed') return 'consumed';
                if (result.deleted) { entry.state = 'canceled'; batch.state = 'canceled'; await this.save(); this.mirror?.(id, null); return true; }
                this.uncertain([id]); return 'indeterminate';
            } catch { if (this.state(id) === 'consumed') return 'consumed'; this.uncertain([id]); return 'indeterminate'; }
        }
        // Keep the surviving members; the removed member is withdrawn after success.
        const proposal = this.version(this.memberInput(survivors), survivors,
            [...(version.removed ?? []), { id, input: member.input, intent: 'cancel' }]);
        batch.versions.push(proposal); batch.current = batch.versions.length - 1;
        entry.state = 'unknown'; await this.save();
        try {
            const response = await this.client.request('thread/queue/update', { threadId: this.threadId, queuedSubmissionId: batch.nativeId, input: proposal.input });
            this.validateUpdate(response, batch, proposal.input);
            this.supersedeOlder(batch, proposal);
            if (this.state(id) === 'consumed') return 'consumed';
            entry.state = 'canceled'; await this.save(); this.mirror?.(id, null);
            return true;
        } catch (error) {
            if (this.state(id) === 'consumed') return 'consumed';
            if (indeterminate(error) || queuedSubmissionNotFound(error)) {
                batch.state = 'unknown'; this.uncertain([id]); return 'indeterminate';
            }
            // Definite rejection: the proposal was not applied, so do not ACK it.
            proposal.status = 'superseded'; batch.current = batch.versions.length - 2;
            entry.state = 'queued'; await this.save();
            this.uncertain([id]); return 'indeterminate';
        }
    }

    steer(id: string, expectedTurnId: string, freshInput?: QueueInput): Promise<{ steered: boolean; indeterminate?: boolean; error?: string }> {
        return this.serial(async () => {
            let entry = this.entries[id];
            if (entry?.state === 'consumed') return { steered: false, error: 'Message already consumed' };
            if (entry?.batchId) return this.steerBatchMember(entry, id, expectedTurnId, freshInput);
            if (entry) {
                try { await this.reconcileLocked(); }
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
    private async steerBatchMember(entry: Entry, id: string, expectedTurnId: string, freshInput?: QueueInput): Promise<{ steered: boolean; indeterminate?: boolean; error?: string }> {
        const batch = this.batches[entry.batchId!];
        if (!batch) return { steered: false, error: 'Message not queued' };
        try { await this.reconcileLocked(); }
        catch { this.uncertain([id]); return { steered: false, indeterminate: true }; }
        if (this.state(id) === 'consumed') return { steered: false, error: 'Message already consumed' };
        // Fail closed while the group's native content is unresolved: no steer/replacement write.
        if (batch.state !== 'queued') return { steered: false, indeterminate: true };
        const version = this.currentVersion(batch);
        const member = version?.members.find(candidate => candidate.id === id);
        if (!version || !member) return { steered: false, indeterminate: true };
        const input = member.input;
        const survivors = version.members.filter(candidate => candidate.id !== id);
        let proposal: Version | undefined;
        if (survivors.length === 0) {
            entry.state = 'unknown'; batch.state = 'unknown'; await this.save();
            try {
                const result = z.object({ deleted: z.boolean() }).parse(await this.client.request('thread/queue/delete', {
                    threadId: this.threadId, queuedSubmissionId: batch.nativeId
                }));
                if (!result.deleted) { this.uncertain([id]); return { steered: false, indeterminate: true }; }
            } catch { this.uncertain([id]); return { steered: false, indeterminate: true }; }
        } else {
            proposal = this.version(this.memberInput(survivors), survivors,
                [...(version.removed ?? []), { id, input, intent: 'steer' }]);
            batch.versions.push(proposal); batch.current = batch.versions.length - 1;
            entry.state = 'unknown'; await this.save();
            try {
                const response = await this.client.request('thread/queue/update', { threadId: this.threadId, queuedSubmissionId: batch.nativeId, input: proposal.input });
                this.validateUpdate(response, batch, proposal.input);
                this.supersedeOlder(batch, proposal);
            } catch (error) {
                if (this.state(id) === 'consumed') return { steered: true };
                if (indeterminate(error) || queuedSubmissionNotFound(error)) {
                    batch.state = 'unknown'; this.uncertain([id]); return { steered: false, indeterminate: true };
                }
                proposal.status = 'superseded'; batch.current = batch.versions.length - 2;
                entry.state = 'queued'; await this.save();
                return { steered: false, error: error instanceof Error ? error.message : String(error) };
            }
        }
        try {
            await this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId, input, clientUserMessageId: id });
            entry.state = 'consumed'; await this.save(); this.consumed([id], true); return { steered: true };
        } catch (error) {
            if (this.state(id) === 'consumed') return { steered: true };
            if (isIndeterminateError(error)) { batch.state = 'unknown'; this.uncertain([id]); return { steered: false, indeterminate: true }; }
            // Definite rejection: restore the removed input safely, keeping siblings.
            if (proposal) {
                try {
                    const response = await this.client.request('thread/queue/update', { threadId: this.threadId, queuedSubmissionId: batch.nativeId, input: version.input });
                    this.validateUpdate(response, batch, version.input);
                    // The proven restored group is authoritative again; keep its aliases ACKable.
                    proposal.status = 'superseded';
                    this.supersedeOlder(batch, version);
                    entry.state = 'queued';
                } catch { entry.state = 'unknown'; batch.state = 'unknown'; this.uncertain([id]); }
            } else {
                try {
                    const response = z.object({ queuedSubmission: SubmissionSchema }).parse(await this.client.request('thread/queue/add', {
                        threadId: this.threadId, input, clientUserMessageId: id
                    }));
                    delete this.batches[batch.clientId]; delete entry.batchId;
                    entry.state = 'queued'; entry.nativeId = response.queuedSubmission.id;
                } catch { entry.state = 'unknown'; this.uncertain([id]); }
            }
            await this.save();
            return { steered: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async flush(): Promise<void> { await this.operations.catch(() => {}); await this.writes; }
}
