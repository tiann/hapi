import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { logger } from '@/ui/logger';

export type LocatedCopilotSession = {
    sessionId: string;
    sessionDir: string;
};

export type CopilotSessionLocator = {
    ready: Promise<void>;
    cleanup: () => Promise<void>;
};

type CopilotSessionLocatorOptions = {
    cwd: string;
    startupTimestampMs: number;
    resumeSessionId?: string | null;
    intervalMs?: number;
    sessionStateRoot?: string;
    onLocated: (located: LocatedCopilotSession) => void;
    onAmbiguous?: (sessionIds: string[]) => void;
};

const DEFAULT_LOCATOR_INTERVAL_MS = 500;
const STARTUP_GRACE_MS = 2000;

export function getCopilotSessionStateRoot(): string {
    return join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.copilot', 'session-state');
}

function normalizePath(path: string): string {
    return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Minimal workspace.yaml field extraction (id + cwd). */
export function parseCopilotWorkspaceYaml(content: string): { id?: string; cwd?: string } {
    let parsed: unknown;
    try {
        parsed = parseYaml(content);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    const { id, cwd } = parsed as { id?: unknown; cwd?: unknown };
    return {
        id: typeof id === 'string' ? id : undefined,
        cwd: typeof cwd === 'string' ? cwd : undefined
    };
}

/**
 * Polls ~/.copilot/session-state for the session the locally spawned Copilot
 * TUI just created in this working directory, then persists its id via onLocated.
 */
export function createCopilotSessionLocator(options: CopilotSessionLocatorOptions): CopilotSessionLocator {
    const locator = new CopilotSessionLocatorImpl(options);
    const ready = locator.start().catch((error) => {
        logger.debug('[copilot-session-locator] Failed to initialize', error);
    });
    return {
        ready,
        cleanup: async () => {
            await locator.cleanup();
            await ready;
        }
    };
}

class CopilotSessionLocatorImpl {
    private readonly sessionStateRoot: string;
    private readonly targetCwd: string;
    private readonly startupTimestampMs: number;
    private readonly resumeSessionId: string | null;
    private readonly intervalMs: number;
    private readonly onLocated: CopilotSessionLocatorOptions['onLocated'];
    private readonly onAmbiguous?: CopilotSessionLocatorOptions['onAmbiguous'];
    private readonly initialSessionIds = new Set<string>();
    private interval: ReturnType<typeof setInterval> | null = null;
    private scanPromise: Promise<void> | null = null;
    private stopped = false;

    constructor(options: CopilotSessionLocatorOptions) {
        this.sessionStateRoot = options.sessionStateRoot ?? getCopilotSessionStateRoot();
        this.targetCwd = normalizePath(options.cwd);
        this.startupTimestampMs = options.startupTimestampMs;
        this.resumeSessionId = options.resumeSessionId ?? null;
        this.intervalMs = options.intervalMs ?? DEFAULT_LOCATOR_INTERVAL_MS;
        this.onLocated = options.onLocated;
        this.onAmbiguous = options.onAmbiguous;
    }

    async start(): Promise<void> {
        if (!this.resumeSessionId) {
            try {
                const entries = await readdir(this.sessionStateRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        this.initialSessionIds.add(entry.name);
                    }
                }
            } catch {
                // Session-state root may not exist yet.
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
                `[copilot-session-locator] Ambiguous Copilot sessions (${candidates.length} fresh candidates); refusing attachment`,
                candidates.map((candidate) => candidate.sessionId)
            );
            this.stopPolling();
            this.onAmbiguous?.(candidates.map((candidate) => candidate.sessionId));
            return;
        }

        const [located] = candidates;
        logger.debug(`[copilot-session-locator] Located ${located.sessionId}`);
        this.stopPolling();
        this.onLocated(located);
    }

    private async listCandidates(): Promise<LocatedCopilotSession[]> {
        let entries;
        try {
            entries = await readdir(this.sessionStateRoot, { withFileTypes: true });
        } catch {
            return [];
        }

        const candidates: LocatedCopilotSession[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (this.resumeSessionId) {
                if (entry.name !== this.resumeSessionId) {
                    continue;
                }
            } else if (this.initialSessionIds.has(entry.name)) {
                continue;
            }

            const sessionDir = join(this.sessionStateRoot, entry.name);
            const workspacePath = join(sessionDir, 'workspace.yaml');
            const workspaceStats = await stat(workspacePath).catch(() => null);
            if (!workspaceStats || !workspaceStats.isFile()) {
                continue;
            }

            if (!this.resumeSessionId) {
                const birthMs = workspaceStats.birthtimeMs || workspaceStats.ctimeMs;
                if (birthMs + STARTUP_GRACE_MS < this.startupTimestampMs) {
                    continue;
                }
            }

            const content = await readFile(workspacePath, 'utf8').catch(() => null);
            if (!content) {
                continue;
            }
            const parsed = parseCopilotWorkspaceYaml(content);
            const sessionId = parsed.id ?? entry.name;
            if (this.resumeSessionId && sessionId !== this.resumeSessionId) {
                continue;
            }
            if (!parsed.cwd || normalizePath(parsed.cwd) !== this.targetCwd) {
                continue;
            }

            candidates.push({ sessionId, sessionDir });
        }
        return candidates;
    }
}
