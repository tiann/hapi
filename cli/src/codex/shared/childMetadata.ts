import { open } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { record, string } from './gateway';

export type ChildExecution = { turnId: string; model: string | null; reasoningEffort: string | null; source: 'codex-turn-context' | 'codex-model-rerouted' };

export function childIdentity(thread: unknown): Record<string, string> {
    const t = record(thread);
    const spawn = record(record(record(t.source).subAgent ?? record(t.source).subagent).thread_spawn);
    const path = string(spawn.agent_path);
    const nickname = string(t.agentNickname) ?? string(spawn.agent_nickname);
    const role = string(t.agentRole) ?? string(spawn.agent_role);
    return { ...(path ? { agentPath: path, taskName: path.split('/').filter(Boolean).at(-1)! } : {}),
        ...(nickname ? { nickname } : {}), ...(role ? { role } : {}) };
}

/** Read only Codex's own child rollout. Configuration snapshots are not turn evidence. */
export class ChildTurnContexts {
    private path?: string;
    private requestedPath?: string;
    private work: Promise<ChildExecution | undefined> = Promise.resolve(undefined);
    private fileIdentity?: string;
    private offset = 0;
    private pending = '';
    private verified = false;
    private headerSeen = false;
    private composite = false;
    private readonly ownedTurns = new Set<string>();
    private readonly contexts = new Map<string, ChildExecution>();
    constructor(private readonly threadId: string) {}
    setPath(path: unknown): void {
        if (typeof path === 'string' && isAbsolute(path)) this.requestedPath = path;
    }
    read(turnId: string, liveThreadId?: string): Promise<ChildExecution | undefined> {
        const result = this.work.then(() => this.readNow(turnId, liveThreadId));
        this.work = result.catch(() => undefined);
        return result;
    }
    private resetFile(): void {
        this.offset = 0; this.pending = ''; this.verified = false; this.headerSeen = false;
        this.composite = false; this.contexts.clear(); this.ownedTurns.clear();
    }
    private async readNow(turnId: string, liveThreadId?: string): Promise<ChildExecution | undefined> {
        if (this.path !== this.requestedPath) {
            this.path = this.requestedPath; this.resetFile();
        }
        if (!this.path) return;
        let file;
        try {
            const normalized = this.path.replace(/\\/g, '/');
            const marker = normalized.lastIndexOf('/sessions/');
            // Codex thread/read can retain the pre-archive rollout path. Only try its
            // conventional archive counterparts, then verify the same child session ID.
            const candidates = [this.path, ...(marker >= 0 ? [
                join(normalized.slice(0, marker), 'archived_sessions', basename(this.path)),
                join(normalized.slice(0, marker), 'archived_sessions', normalized.slice(marker + '/sessions/'.length))
            ] : [])];
            for (const path of candidates) {
                try { file = await open(path, 'r'); break; } catch { /* Native rollout may be archived or unavailable. */ }
            }
            if (!file) return;
            const stat = await file.stat();
            if (!stat.isFile()) return;
            const size = stat.size;
            const identity = `${stat.dev}:${stat.ino}`;
            if (identity !== this.fileIdentity || size < this.offset) this.resetFile();
            this.fileIdentity = identity;
            const buffer = Buffer.alloc(64 * 1024);
            while (this.offset < size) {
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
                if (!bytesRead) break;
                this.offset += bytesRead;
                this.pending += buffer.subarray(0, bytesRead).toString('utf8');
                const lines = this.pending.split('\n'); this.pending = lines.pop()!;
                for (const line of lines) {
                    let entry;
                    try { entry = record(JSON.parse(line)); } catch {
                        if (!this.headerSeen) { this.headerSeen = true; this.verified = false; }
                        continue;
                    }
                    const payload = record(entry.payload);
                    if (!this.headerSeen) {
                        // The first record identifies the file. Inherited headers are content,
                        // not a change of owner; a later matching header cannot repair a wrong file.
                        this.headerSeen = true;
                        this.verified = entry.type === 'session_meta' && payload.id === this.threadId;
                        this.composite = Boolean(payload.forked_from_id || payload.parent_thread_id
                            || payload.subagent_history_start_ordinal != null);
                    } else if (entry.type === 'session_meta' && payload.id !== this.threadId) {
                        this.composite = true;
                    }
                    if (!this.verified) continue;
                    // A composite rollout contains ancestor contexts. Only child-bound native
                    // events prove an own turn. root_turn_id and current thread settings do not.
                    if ((entry.type === 'event_msg' || entry.type === 'token_usage_record')
                        && payload.thread_id === this.threadId && string(payload.turn_id)) {
                        this.ownedTurns.add(string(payload.turn_id)!);
                    }
                    if (entry.type !== 'turn_context') continue;
                    const id = string(payload.turn_id);
                    if (id) this.contexts.set(id, { turnId: id, model: string(payload.model) ?? null,
                        reasoningEffort: string(payload.effort) ?? null, source: 'codex-turn-context' });
                }
                // A malformed oversized line must not retain an unbounded buffer.
                if (this.pending.length > 8 * 1024 * 1024) this.pending = '';
            }
            if (this.composite && liveThreadId !== this.threadId && !this.ownedTurns.has(turnId)) return;
            return this.contexts.get(turnId);
        } catch { return; } finally { await file?.close(); }
    }
}
