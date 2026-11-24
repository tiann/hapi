import { randomUUID } from 'node:crypto';

/**
 * How an agent tool call id was seen:
 * - `start`: an ACP `tool_call` (the agent announces a call)
 * - `update`: a non-terminal `tool_call_update`
 * - `terminal`: a `tool_call_update` with status completed/failed
 * - `request`: a permission request, form elicitation or extension request
 *   that names the call
 */
export type ToolCallEventKind = 'start' | 'update' | 'terminal' | 'request';

/** `main` for the prompted ACP session, `child:<id>` for an OpenCode child session. */
export type ToolCallScope = string;

export const MAIN_TOOL_CALL_SCOPE: ToolCallScope = 'main';

export function childToolCallScope(childSessionId: string): ToolCallScope {
    return `child:${childSessionId}`;
}

const LIFETIME_SEPARATOR = '#';
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LIFETIME_ID_PATTERN = new RegExp(`^(.+)${LIFETIME_SEPARATOR}(${UUID_PATTERN})$`, 'i');

/**
 * The id HAPI uses for one lifetime of an agent tool call. The agent id stays
 * as the prefix so logs and the tool-id auto-approval hints still see it; the
 * UUID makes it unique even when the agent reuses its id (for example,
 * `question:0`, `shell:0`) and across process restarts.
 */
export function formatToolCallLifetimeId(agentToolCallId: string, uuid: string = randomUUID()): string {
    return `${agentToolCallId}${LIFETIME_SEPARATOR}${uuid}`;
}

/** The agent id inside a lifetime id, or null for any other (legacy) id. */
export function parseToolCallLifetimeId(id: string): string | null {
    const match = LIFETIME_ID_PATTERN.exec(id);
    return match ? match[1] : null;
}

type Lifetime = {
    id: string;
    agentToolCallId: string;
    scope: ToolCallScope;
    /** Scope generation the lifetime was opened in. */
    generation: number;
    /** A `start` event mapped to this lifetime. */
    startSeen: boolean;
    /** A terminal update mapped to this lifetime. */
    terminal: boolean;
    /** The scope was cancelled while this lifetime was open. */
    cancelled: boolean;
    /** A permission request or question for this lifetime was answered. */
    requestSettled: boolean;
    /** A `start` no longer joins this lifetime; the next one opens a new lifetime. */
    closedForStart: boolean;
    /** A request no longer joins this lifetime. Updates and results always still map here. */
    closedForRequest: boolean;
    /** Rebuilt from stored state after a restart. */
    restored: boolean;
    /** Requests asked under this lifetime so far (each gets its own request id). */
    requests: number;
    /** When the call opened (epoch ms), kept across restarts for the age limit. */
    openedAt: number;
};

/** A lifetime that may still receive events, as persisted across a restart. */
export type StoredToolCallLifetime = { agentToolCallId: string; scope: ToolCallScope; id: string; openedAt?: number };

/** `open`: a lifetime that may receive events was added; `close`: one was finished, cancelled or forgotten. */
export type ToolCallLifetimeChange = 'open' | 'close';

/**
 * Most lifetimes kept per connection. Closed lifetimes are forgotten first,
 * then open ones left over from earlier prompts (calls that never reported a
 * result), then the oldest open ones. A late event for a forgotten lifetime
 * opens a new one, so the bound is generous.
 */
export const MAX_TRACKED_TOOL_CALL_LIFETIMES = 8192;

function lifetimeKey(scope: ToolCallScope, agentToolCallId: string): string {
    return `${scope}\u0000${agentToolCallId}`;
}

/**
 * Maps agent tool call ids to HAPI tool call lifetime ids for one ACP session.
 *
 * Lifetimes are keyed by scope (the prompted session or an OpenCode child
 * session) and agent id, so a child reusing its parent's ids never touches
 * the parent's calls. Every key has at most one current lifetime. Updates and
 * results always map to the current lifetime, so a call that spans prompts,
 * child-session turns, a cancel or a user message keeps one id, and a
 * duplicate result lands on the same card. A new lifetime opens only when the
 * agent starts (or asks about) a call whose current lifetime can no longer be
 * joined:
 * - it ended with a terminal result (the usual reuse: `shell:0` again), or
 * - its scope was cancelled and the cancelled prompt has since ended (an
 *   aborted call the agent never finished, e.g. an aborted `question:0`), or
 * - for a start only: its request was answered and a later prompt has begun
 *   (an answered call whose result never arrived; a further request of the
 *   same call still joins it), or
 * - for a start only: it was rebuilt from stored state after a restart (the
 *   old process is gone, so a fresh start is a different call).
 * A result that arrived before its call opens the lifetime; the call joins it
 * when it follows in the same scope generation.
 */
export class AcpToolCallLifetimes {
    private readonly lifetimes = new Map<string, Lifetime>();
    private readonly keysById = new Map<string, string>();
    private readonly generations = new Map<ToolCallScope, number>();

    constructor(
        private readonly createId: (agentToolCallId: string) => string = (id) => formatToolCallLifetimeId(id),
        /** Called whenever the set of lifetimes that may still receive events changes. */
        /** `lifetime` is the one that opened, or the one that finished. */
        private readonly onOpenSetChange: (change: ToolCallLifetimeChange, lifetime?: StoredToolCallLifetime) => void = () => {}
    ) {}

    resolve(agentToolCallId: string, kind: ToolCallEventKind, scope: ToolCallScope = MAIN_TOOL_CALL_SCOPE): string {
        let key = lifetimeKey(scope, agentToolCallId);
        let current = this.lifetimes.get(key);
        if (!current && kind === 'request') {
            // A child's request may name the root session: join that child's
            // open call when exactly one scope has one.
            const elsewhere = this.findJoinableElsewhere(agentToolCallId, scope);
            if (elsewhere) {
                key = lifetimeKey(elsewhere.scope, agentToolCallId);
                current = elsewhere;
            }
        }
        if (!current) {
            return this.open(agentToolCallId, kind, scope).id;
        }

        if (kind === 'update') {
            return current.id;
        }
        if (kind === 'terminal') {
            this.markTerminal(current);
            return current.id;
        }
        if (kind === 'request') {
            return current.closedForRequest ? this.open(agentToolCallId, kind, scope).id : current.id;
        }
        if (!current.closedForStart) {
            current.startSeen = true;
            return current.id;
        }
        if (
            !current.startSeen
            && !current.restored
            && !current.cancelled
            && current.generation === this.generationOf(current.scope)
        ) {
            // Result before call, in the same prompt: the call joins it.
            current.startSeen = true;
            return current.id;
        }
        return this.open(agentToolCallId, kind, scope).id;
    }

    /**
     * The id for the next permission request or question asked under
     * `lifetimeId`. The first request uses the lifetime id itself; later ones
     * (a second permission of the same call, a question re-asked after a
     * restart) get their own id, so a settled earlier request never hides
     * them. Writers keep the lifetime id as the request's toolCallId, which
     * is how clients attach every request to the call's card.
     */
    allocateRequestId(lifetimeId: string): string {
        const lifetime = this.byId(lifetimeId);
        const index = lifetime ? lifetime.requests++ : 1;
        // `~` is unreserved in URLs; request ids travel in permission routes.
        return index === 0 ? lifetimeId : `${lifetimeId}~${randomUUID()}`;
    }

    /**
     * A new prompt (main scope) or child-session turn begins. Lifetimes the
     * scope cancelled can no longer be joined; lifetimes whose request was
     * answered in an earlier prompt no longer accept a new start.
     */
    beginGeneration(scope: ToolCallScope = MAIN_TOOL_CALL_SCOPE): void {
        this.generations.set(scope, this.generationOf(scope) + 1);
        for (const lifetime of this.lifetimes.values()) {
            if (lifetime.scope === scope && lifetime.requestSettled) {
                lifetime.closedForStart = true;
            }
        }
        this.settleCancelled(scope);
    }

    /** A permission request or question of the lifetime `lifetimeId` was answered. */
    settleRequest(lifetimeId: string): void {
        const lifetime = this.byId(lifetimeId);
        if (lifetime) lifetime.requestSettled = true;
    }

    /**
     * The scope was cancelled. A start of the same id is a new call from now
     * on; requests stop joining once the cancel settles. The cancelled call's
     * own updates and results still map to it.
     */
    cancel(scope: ToolCallScope = MAIN_TOOL_CALL_SCOPE): void {
        for (const lifetime of this.lifetimes.values()) {
            if (lifetime.scope === scope && !lifetime.terminal) {
                lifetime.cancelled = true;
                lifetime.closedForStart = true;
            }
        }
    }

    /** The cancelled prompt or child turn has ended.
     *  Returns the HAPI lifetime ids closed by this settle so callers can
     *  publish a scoped hub settlement (parent cancel must not close child
     *  scopes that keep running). */
    settleCancelled(scope: ToolCallScope = MAIN_TOOL_CALL_SCOPE): string[] {
        const settledIds: string[] = [];
        for (const [key, lifetime] of this.lifetimes) {
            if (lifetime.scope === scope && lifetime.cancelled && !lifetime.closedForRequest) {
                lifetime.closedForStart = true;
                lifetime.closedForRequest = true;
                this.touch(key, lifetime);
                settledIds.push(lifetime.id);
            }
        }
        if (settledIds.length > 0) this.changed('close');
        return settledIds;
    }

    /**
     * Lifetimes that may still receive events from the agent: not finished
     * (a cancelled call may still report). Persisted so a restart keeps
     * their ids.
     */
    openLifetimes(): StoredToolCallLifetime[] {
        const open: StoredToolCallLifetime[] = [];
        for (const lifetime of this.lifetimes.values()) {
            if (!lifetime.terminal) {
                open.push({
                    agentToolCallId: lifetime.agentToolCallId,
                    scope: lifetime.scope,
                    id: lifetime.id,
                    openedAt: lifetime.openedAt
                });
            }
        }
        return open;
    }

    /**
     * Rebuilds lifetimes stored before a restart. They keep receiving the
     * call's updates, results and requests under the stored id; a fresh
     * start opens a new lifetime. A lifetime of the live connection wins.
     */
    restore(stored: Iterable<StoredToolCallLifetime>): void {
        let changed = false;
        for (const entry of stored) {
            // No age limit: a call may legitimately run for days.
            const openedAt = entry.openedAt ?? Date.now();
            const key = lifetimeKey(entry.scope, entry.agentToolCallId);
            if (this.lifetimes.has(key) || this.keysById.has(entry.id)) continue;
            this.insert(key, {
                id: entry.id,
                agentToolCallId: entry.agentToolCallId,
                scope: entry.scope,
                generation: -1,
                startSeen: true,
                terminal: false,
                cancelled: false,
                requestSettled: false,
                closedForStart: true,
                closedForRequest: false,
                restored: true,
                // Its earlier request (if any) died with the old process.
                requests: 1,
                openedAt
            });
            changed = true;
        }
        if (changed) {
            this.prune();
            this.changed('close');
        }
    }

    private findJoinableElsewhere(agentToolCallId: string, scope: ToolCallScope): Lifetime | null {
        let found: Lifetime | null = null;
        for (const lifetime of this.lifetimes.values()) {
            if (lifetime.agentToolCallId !== agentToolCallId || lifetime.scope === scope || lifetime.closedForRequest) continue;
            if (found) return null;
            found = lifetime;
        }
        return found;
    }

    private open(agentToolCallId: string, kind: ToolCallEventKind, scope: ToolCallScope): Lifetime {
        const lifetime: Lifetime = {
            id: this.createId(agentToolCallId),
            agentToolCallId,
            scope,
            generation: this.generationOf(scope),
            startSeen: kind === 'start',
            terminal: false,
            cancelled: false,
            requestSettled: false,
            closedForStart: false,
            closedForRequest: false,
            restored: false,
            requests: 0,
            openedAt: Date.now()
        };
        const key = lifetimeKey(scope, agentToolCallId);
        const previous = this.lifetimes.get(key);
        if (previous) this.keysById.delete(previous.id);
        this.insert(key, lifetime);
        this.prune();
        this.changed('open', { agentToolCallId, scope, id: lifetime.id, openedAt: lifetime.openedAt });
        if (kind === 'terminal') {
            this.markTerminal(lifetime);
        }
        return lifetime;
    }

    private insert(key: string, lifetime: Lifetime): void {
        // Re-insert so Map order tracks recency for pruning.
        this.lifetimes.delete(key);
        this.lifetimes.set(key, lifetime);
        this.keysById.set(lifetime.id, key);
    }

    private touch(key: string, lifetime: Lifetime): void {
        this.lifetimes.delete(key);
        this.lifetimes.set(key, lifetime);
    }

    private markTerminal(lifetime: Lifetime): void {
        if (lifetime.terminal) return;
        lifetime.terminal = true;
        lifetime.closedForStart = true;
        lifetime.closedForRequest = true;
        this.touch(lifetimeKey(lifetime.scope, lifetime.agentToolCallId), lifetime);
        this.prune();
        this.changed('close', { agentToolCallId: lifetime.agentToolCallId, scope: lifetime.scope, id: lifetime.id });
    }

    private byId(lifetimeId: string): Lifetime | undefined {
        const key = this.keysById.get(lifetimeId);
        const lifetime = key ? this.lifetimes.get(key) : undefined;
        return lifetime?.id === lifetimeId ? lifetime : undefined;
    }

    private prune(): void {
        if (this.lifetimes.size <= MAX_TRACKED_TOOL_CALL_LIFETIMES) return;
        const tiers: Array<(lifetime: Lifetime) => boolean> = [
            (lifetime) => lifetime.terminal || lifetime.closedForRequest,
            (lifetime) => lifetime.generation < this.generationOf(lifetime.scope),
            () => true
        ];
        for (const evictable of tiers) {
            for (const [key, lifetime] of this.lifetimes) {
                if (this.lifetimes.size <= MAX_TRACKED_TOOL_CALL_LIFETIMES) return;
                if (!evictable(lifetime)) continue;
                this.lifetimes.delete(key);
                this.keysById.delete(lifetime.id);
            }
        }
    }

    private changed(change: ToolCallLifetimeChange, lifetime?: StoredToolCallLifetime): void {
        this.onOpenSetChange(change, lifetime);
    }

    private generationOf(scope: ToolCallScope): number {
        return this.generations.get(scope) ?? 0;
    }
}
