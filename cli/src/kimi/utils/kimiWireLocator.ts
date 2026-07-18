import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '@/ui/logger';
import { getKimiCodeHome } from './config';

export type LocatedKimiWire = {
    sessionId: string;
    wirePath: string;
};

export type KimiWireLocator = {
    ready: Promise<void>;
    cleanup: () => Promise<void>;
};

type KimiWireLocatorOptions = {
    cwd: string;
    startupTimestampMs: number;
    resumeSessionId?: string | null;
    intervalMs?: number;
    onLocated: (located: LocatedKimiWire) => void;
    onAmbiguous?: (sessionIds: string[]) => void;
};

const DEFAULT_LOCATOR_INTERVAL_MS = 500;
// Grace for filesystem timestamp skew between hapi recording its launch time
// and kimi-code creating the session directory right after.
const STARTUP_GRACE_MS = 2000;

const WORKDIR_KEY_PREFIX = 'wd_';
const WORKDIR_HASH_LENGTH = 12;
const MAX_WORKDIR_SLUG_LENGTH = 40;

function slugifyWorkDirName(name: string): string {
    const slug = name
        .toLowerCase()
        .replaceAll(/[^a-z0-9._-]+/g, '-')
        .replaceAll(/^-+|-+$/g, '')
        .slice(0, MAX_WORKDIR_SLUG_LENGTH)
        .replaceAll(/^-+|-+$/g, '');
    return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

/**
 * Mirrors kimi-code's workspace identity (`packages/agent-core-v2/src/_base/utils/workdir-slug.ts`):
 * `wd_<slug>_<sha256(normalizedWorkDir).slice(0,12)>`. Sessions for a working
 * directory live under `<KIMI_CODE_HOME>/sessions/<workspaceId>/session_<id>/`.
 */
export function encodeKimiWorkDirKey(workDir: string): string {
    const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = normalized.split('/').pop() ?? normalized;
    const slug = slugifyWorkDirName(base);
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, WORKDIR_HASH_LENGTH);
    return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export function getKimiWorkspaceDir(workDir: string): string {
    return join(getKimiCodeHome(), 'sessions', encodeKimiWorkDirKey(workDir));
}

export function getKimiWirePath(sessionDir: string): string {
    return join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

/**
 * Polls the kimi-code session storage for the session the locally spawned
 * `kimi` process just created in this working directory, and resolves with
 * its wire transcript path. Mirrors the codex transcript locator: sessions
 * created before hapi's launch are ignored; multiple fresh candidates are
 * treated as ambiguous rather than attaching to the wrong session.
 */
export function createKimiWireLocator(options: KimiWireLocatorOptions): KimiWireLocator {
    const locator = new KimiWireLocatorImpl(options);
    const ready = locator.start().catch((error) => {
        logger.debug('[kimi-wire-locator] Failed to initialize', error);
    });
    return {
        ready,
        cleanup: async () => {
            await locator.cleanup();
            await ready;
        }
    };
}

class KimiWireLocatorImpl {
    private readonly workspaceDir: string;
    private readonly targetCwd: string;
    private readonly startupTimestampMs: number;
    private readonly resumeSessionId: string | null;
    private readonly intervalMs: number;
    private readonly onLocated: KimiWireLocatorOptions['onLocated'];
    private readonly onAmbiguous?: KimiWireLocatorOptions['onAmbiguous'];
    private readonly initialSessionIds = new Set<string>();
    private interval: ReturnType<typeof setInterval> | null = null;
    private scanPromise: Promise<void> | null = null;
    private stopped = false;

    constructor(options: KimiWireLocatorOptions) {
        this.workspaceDir = getKimiWorkspaceDir(options.cwd);
        this.targetCwd = normalizePath(options.cwd);
        this.startupTimestampMs = options.startupTimestampMs;
        this.resumeSessionId = options.resumeSessionId ?? null;
        this.intervalMs = options.intervalMs ?? DEFAULT_LOCATOR_INTERVAL_MS;
        this.onLocated = options.onLocated;
        this.onAmbiguous = options.onAmbiguous;
    }

    async start(): Promise<void> {
        if (!this.resumeSessionId) {
            // Snapshot pre-existing sessions: only directories that appear
            // AFTER this locator starts may belong to the process hapi just
            // spawned. Without this, an immediate retry could bind to the
            // previous launch's session (created inside the birth-time grace
            // window) before the new process has written anything.
            try {
                const entries = await readdir(this.workspaceDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory() && entry.name.startsWith('session_')) {
                        this.initialSessionIds.add(entry.name);
                    }
                }
            } catch {
                // Workspace dir does not exist yet — nothing to exclude.
            }
        }
        if (this.stopped) return;

        void this.scan();
        this.interval = setInterval(() => void this.scan(), this.intervalMs);
        this.interval.unref?.();
    }

    async cleanup(): Promise<void> {
        this.stopped = true;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        await this.scanPromise?.catch(() => {});
    }

    private stopPolling(): void {
        this.stopped = true;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    private async scan(): Promise<void> {
        if (this.stopped || this.scanPromise) {
            return this.scanPromise ?? Promise.resolve();
        }
        this.scanPromise = this.runScan();
        try {
            await this.scanPromise;
        } finally {
            this.scanPromise = null;
        }
    }

    private async runScan(): Promise<void> {
        const candidates = await this.listCandidates();
        if (this.stopped || candidates.length === 0) {
            return;
        }

        if (candidates.length > 1) {
            logger.warn(
                `[kimi-wire-locator] Ambiguous kimi sessions (${candidates.length} fresh candidates); refusing attachment`,
                candidates.map((candidate) => candidate.sessionId)
            );
            this.stopPolling();
            this.onAmbiguous?.(candidates.map((candidate) => candidate.sessionId));
            return;
        }

        const [located] = candidates;
        logger.debug(`[kimi-wire-locator] Located ${located.sessionId} at ${located.wirePath}`);
        this.stopPolling();
        this.onLocated(located);
    }

    private async listCandidates(): Promise<LocatedKimiWire[]> {
        let entries;
        try {
            entries = await readdir(this.workspaceDir, { withFileTypes: true });
        } catch {
            return [];
        }

        const candidates: LocatedKimiWire[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('session_')) {
                continue;
            }
            if (this.resumeSessionId && entry.name !== this.resumeSessionId) {
                continue;
            }

            const sessionDir = join(this.workspaceDir, entry.name);
            const wirePath = getKimiWirePath(sessionDir);
            const wireStats = await stat(wirePath).catch(() => null);
            if (!wireStats || !wireStats.isFile()) {
                continue;
            }

            if (!this.resumeSessionId) {
                if (this.initialSessionIds.has(entry.name)) {
                    continue;
                }
                const dirStats = await stat(sessionDir).catch(() => null);
                const createdMs = dirStats?.birthtimeMs && dirStats.birthtimeMs > 0
                    ? dirStats.birthtimeMs
                    : dirStats?.mtimeMs ?? 0;
                if (createdMs < this.startupTimestampMs - STARTUP_GRACE_MS) {
                    continue;
                }
                if (!(await this.matchesWorkDir(sessionDir))) {
                    continue;
                }
            }

            candidates.push({ sessionId: entry.name, wirePath });
        }
        return candidates;
    }

    private async matchesWorkDir(sessionDir: string): Promise<boolean> {
        try {
            const raw = await readFile(join(sessionDir, 'state.json'), 'utf8');
            const parsed = JSON.parse(raw) as { workDir?: unknown };
            if (typeof parsed.workDir !== 'string' || parsed.workDir.length === 0) {
                return true;
            }
            return normalizePath(parsed.workDir) === this.targetCwd;
        } catch {
            // state.json may not be written yet — do not exclude the candidate.
            return true;
        }
    }
}

function normalizePath(value: string): string {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
