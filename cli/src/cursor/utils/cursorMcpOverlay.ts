/**
 * Cursor ACP historically ignored mcpServers on session/new, so HAPI overlays
 * native mcp.json. Cursor **merges** user `~/.cursor/mcp.json` with project
 * `<cwd>/.cursor/mcp.json`. Unique `hapi-<uuid>` keys in the user file therefore
 * union-load every live session's ping_peer into every agent (wrong sender +
 * N copies of the tool schema).
 *
 * Isolation: write one stable `hapi` mailbox into the **project** file, and strip
 * PID-stamped `hapi` / `hapi-*` keys from the user file. Same-cwd second live
 * mailbox fails closed rather than multiplexing.
 */

import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { logger } from '@/ui/logger';

/** Stable project mcp.json key — one mailbox per Cursor cwd. */
export const CURSOR_HAPI_MCP_SERVER_ID = 'hapi';

/**
 * Historical unique id shape (`hapi-<session>`). Production install uses
 * {@link CURSOR_HAPI_MCP_SERVER_ID} only; keep this helper for tests / crash
 * recovery of older overlays still present on disk.
 */
export function cursorHapiMcpServerId(sessionId: string): string {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('sessionId is required for Cursor HAPI MCP overlay');
    }
    return `hapi-${trimmed}`;
}

/** Marks HAPI-owned overlay entries so a later launch can prune dead PIDs. */
export const HAPI_MCP_OVERLAY_PID_ENV = 'HAPI_MCP_OVERLAY_PID';

/** Session that owns this mailbox — used to refuse a second live overlay in one cwd. */
export const HAPI_MCP_OVERLAY_SESSION_ENV = 'HAPI_MCP_OVERLAY_SESSION';

type McpServerEntry = {
    command: string;
    args: string[];
    env?: Record<string, string>;
};

/** Resolve the Cursor MCP config directory (override for tests; default `~/.cursor`). */
export function resolveCursorMcpConfigDir(override?: string): string {
    const trimmed = override?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : join(homedir(), '.cursor');
}

function resolveExistingPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * Project `.cursor` is untrusted (repo can ship a symlink to ~/.cursor).
 * Refuse links / realpaths that escape the session cwd. Operator user-dir
 * may follow estate-disk symlinks via {@link resolveExistingPath}.
 *
 * Canonicalize via the parent of `.cursor` before the containment check so
 * estate layouts like `~/coding -> /work/coding` do not false-positive when
 * `session.path` is already realpath'd but `mcpConfigDir` still uses the
 * symlink prefix (common on first install when `.cursor` does not exist yet).
 */
export function resolveProjectCursorConfigDir(cwd: string, mcpConfigDir: string): string {
    const lexical = resolvePath(resolveCursorMcpConfigDir(mcpConfigDir));
    const entry = lstatSync(lexical, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
        throw new Error(
            `Refusing a symlinked project Cursor config dir: ${lexical}`,
        );
    }
    const realCwd = resolveExistingPath(resolvePath(cwd));
    const realParent = resolveExistingPath(resolvePath(lexical, '..'));
    const candidate = join(realParent, basename(lexical));
    const candidateRel = relative(realCwd, candidate);
    if (candidateRel.startsWith('..') || isAbsolute(candidateRel)) {
        throw new Error(
            `Project Cursor config dir escapes session cwd: ${lexical}`,
        );
    }
    if (!existsSync(candidate)) {
        return candidate;
    }
    let resolved: string;
    try {
        resolved = realpathSync(candidate);
    } catch {
        return candidate;
    }
    const rel = relative(realCwd, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(
            `Project Cursor config dir escapes session cwd: ${resolved}`,
        );
    }
    return resolved;
}

function isHapiOverlayKey(id: string): boolean {
    return id === CURSOR_HAPI_MCP_SERVER_ID || id.startsWith('hapi-');
}

function overlayPid(entry: McpServerEntry | undefined): number | null {
    const pidRaw = entry?.env?.[HAPI_MCP_OVERLAY_PID_ENV];
    if (typeof pidRaw !== 'string' || pidRaw.trim() === '') {
        return null;
    }
    const pid = Number(pidRaw);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    return pid;
}

function isDeadPidStampedOverlay(entry: McpServerEntry | undefined): boolean {
    const pid = overlayPid(entry);
    return pid !== null && !isProcessAlive(pid);
}

/**
 * Drop PID-stamped HAPI overlay keys whose owner PID is confirmed dead.
 * Live stamped entries stay (driver-soup: a new CLI must not sever still-running
 * old-binary Cursor sessions sharing the user mcp.json). `keepId` is exempt.
 * User-owned keys without the PID stamp stay.
 */
export function stripPidStampedHapiOverlays(
    servers: Record<string, McpServerEntry>,
    keepId?: string,
): void {
    for (const [id, entry] of Object.entries(servers)) {
        if (keepId && id === keepId) {
            continue;
        }
        if (!isHapiOverlayKey(id)) {
            continue;
        }
        if (!isDeadPidStampedOverlay(entry)) {
            continue;
        }
        delete servers[id];
    }
}

type CursorMcpJson = {
    mcpServers?: Record<string, McpServerEntry>;
};

type LockOwner = {
    pid: number;
    token: string;
};

export type CursorMcpOverlayHandle = {
    cleanup: () => void;
};

/** Prefix for `.git/info/exclude` lease markers (do not commit session mailbox). */
export const HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX = '# hapi-cursor-mcp-overlay';

/** @deprecated Prefer {@link hapiMcpGitExcludeMarker} with a lease id. */
export const HAPI_MCP_GIT_EXCLUDE_MARKER = `${HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX} (do not commit session mailbox)`;

export function hapiMcpGitExcludeMarker(leaseId: string): string {
    return `${HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX} ${leaseId}`;
}

/** Lease id embeds owner PID so crash recovery can prune dead markers. */
export function makeExcludeLeaseId(pid: number = process.pid): string {
    return `${pid}:${randomUUID()}`;
}

export function parseExcludeLeasePid(leaseId: string): number | null {
    const match = /^(\d+):/.exec(leaseId);
    if (!match) {
        return null;
    }
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Normalize a repo-relative path for gitignore / exclude (always `/`). */
export function toGitExcludePattern(relPath: string): string {
    return relPath.replaceAll('\\', '/');
}

function resolveGitExcludePath(root: string): string | null {
    const excludeProc = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: root,
        encoding: 'utf-8',
    });
    if (excludeProc.status !== 0) {
        return null;
    }
    const raw = excludeProc.stdout.trim();
    if (!raw) {
        return null;
    }
    return isAbsolute(raw) ? raw : resolvePath(root, raw);
}

/**
 * Append a per-install lease block (marker + pattern). Multiple live overlays
 * may share the same pattern across linked worktrees; each keeps its own lease
 * line so cleanup is reference-counted by presence of remaining leases.
 * Serialized via {@link withMcpJsonLock} on `${excludePath}.hapi.lock`.
 */
export function appendExcludeLease(
    excludePath: string,
    pattern: string,
    leaseId: string,
): boolean {
    let added = false;
    withMcpJsonLock(`${excludePath}.hapi.lock`, () => {
        pruneDeadExcludeLeasesUnlocked(excludePath);
        added = appendExcludeLeaseUnlocked(excludePath, pattern, leaseId);
    });
    return added;
}

/** Unlocked RMW — callers must hold `${excludePath}.hapi.lock`. */
export function appendExcludeLeaseUnlocked(
    excludePath: string,
    pattern: string,
    leaseId: string,
): boolean {
    const marker = hapiMcpGitExcludeMarker(leaseId);
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    const lines = existing.split(/\r?\n/);
    if (lines.includes(marker)) {
        return false;
    }
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(
        excludePath,
        `${existing}${prefix}${marker}\n${pattern}\n`,
        { encoding: 'utf-8', mode: 0o644 },
    );
    return true;
}

/** @deprecated Use {@link appendExcludeLease}. */
export function appendExcludeIfMissing(excludePath: string, pattern: string): boolean {
    return appendExcludeLease(excludePath, pattern, randomUUID());
}

/** Remove one lease block (exact marker + pattern lines only). */
export function removeExcludeLease(
    excludePath: string,
    pattern: string,
    leaseId: string,
): void {
    withMcpJsonLock(`${excludePath}.hapi.lock`, () => {
        removeExcludeLeaseUnlocked(excludePath, pattern, leaseId);
    });
}

/** Unlocked RMW — callers must hold `${excludePath}.hapi.lock`. */
export function removeExcludeLeaseUnlocked(
    excludePath: string,
    pattern: string,
    leaseId: string,
): void {
    if (!existsSync(excludePath)) {
        return;
    }
    const marker = hapiMcpGitExcludeMarker(leaseId);
    const lines = readFileSync(excludePath, 'utf-8').split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === marker && lines[i + 1] === pattern) {
            i += 1;
            continue;
        }
        out.push(lines[i]!);
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    const body = out.length === 0 ? '' : `${out.join('\n')}\n`;
    writeFileSync(excludePath, body, { encoding: 'utf-8', mode: 0o644 });
}

/**
 * Drop lease blocks whose owner PID is confirmed dead (SIGKILL / power-loss recovery).
 * Callers must hold `${excludePath}.hapi.lock`.
 */
export function pruneDeadExcludeLeasesUnlocked(excludePath: string): void {
    if (!existsSync(excludePath)) {
        return;
    }
    const lines = readFileSync(excludePath, 'utf-8').split(/\r?\n/);
    const out: string[] = [];
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith(`${HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX} `)) {
            const leaseId = line.slice(HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX.length + 1).trim();
            const pid = parseExcludeLeasePid(leaseId);
            if (pid !== null && !isProcessAlive(pid)) {
                removed = true;
                if (lines[i + 1] !== undefined) {
                    i += 1;
                }
                continue;
            }
        }
        out.push(line);
    }
    if (!removed) {
        return;
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    const body = out.length === 0 ? '' : `${out.join('\n')}\n`;
    writeFileSync(excludePath, body, { encoding: 'utf-8', mode: 0o644 });
}

/** @deprecated Use {@link removeExcludeLease}. */
export function removeExactExcludeBlock(excludePath: string, pattern: string): void {
    withMcpJsonLock(`${excludePath}.hapi.lock`, () => {
        if (!existsSync(excludePath)) {
            return;
        }
        const lines = readFileSync(excludePath, 'utf-8').split(/\r?\n/);
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (
                line.startsWith(`${HAPI_MCP_GIT_EXCLUDE_MARKER_PREFIX} `)
                && lines[i + 1] === pattern
            ) {
                i += 1;
                continue;
            }
            out.push(line);
        }
        while (out.length > 0 && out[out.length - 1] === '') {
            out.pop();
        }
        const body = out.length === 0 ? '' : `${out.join('\n')}\n`;
        writeFileSync(excludePath, body, { encoding: 'utf-8', mode: 0o644 });
    });
}

/**
 * Keep the session mailbox out of accidental commits: local exclude for
 * untracked `.cursor/mcp.json`, and `skip-worktree` when the file is already tracked
 * and was not already skipped. Undo reverses only what this call introduced.
 * Throws when Git shielding cannot be installed so callers can roll back the mailbox write.
 */
export function shieldProjectMcpJsonFromGit(cwd: string, mcpJsonPath: string): () => void {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf-8',
    });
    if (top.status !== 0) {
        return () => {};
    }
    const root = top.stdout.trim();
    if (!root) {
        return () => {};
    }
    const relRaw = relative(root, mcpJsonPath);
    if (!relRaw || relRaw.startsWith('..') || isAbsolute(relRaw)) {
        return () => {};
    }
    const gitRelativePath = toGitExcludePattern(relRaw);
    const leaseId = makeExcludeLeaseId();

    const excludePath = resolveGitExcludePath(root);
    if (!excludePath) {
        throw new Error(`Cannot resolve Git exclude path for ${gitRelativePath}`);
    }

    let addedExclude = false;
    try {
        addedExclude = appendExcludeLease(excludePath, gitRelativePath, leaseId);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to exclude ${gitRelativePath}: ${detail}`);
    }
    if (!addedExclude) {
        throw new Error(`Failed to exclude ${gitRelativePath}`);
    }

    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', gitRelativePath], {
        cwd: root,
        encoding: 'utf-8',
    });
    // Skip-worktree is not crash-safe (bit lives only in-process). Refuse tracked
    // mailboxes; untracked + exclude lease is the supported path.
    if (tracked.status === 0) {
        try {
            removeExcludeLease(excludePath, gitRelativePath, leaseId);
        } catch {
            // best-effort undo
        }
        throw new Error(
            `Refusing runtime overlay for tracked ${gitRelativePath} `
            + '(untrack it or gitignore project .cursor/mcp.json)',
        );
    }
    if (tracked.status !== 1) {
        try {
            removeExcludeLease(excludePath, gitRelativePath, leaseId);
        } catch {
            // best-effort undo
        }
        const detail = (tracked.stderr || tracked.stdout || '').trim();
        throw new Error(`git ls-files failed${detail ? `: ${detail}` : ''}`);
    }

    return () => {
        try {
            removeExcludeLease(excludePath, gitRelativePath, leaseId);
        } catch (error) {
            logger.debug('[cursor-acp] failed to remove mcp.json from git exclude', error);
        }
    };
}

type EnableCursorMcpResult = {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
};

export type EnableCursorMcp = (cwd: string, id: string) => EnableCursorMcpResult;

const LOCK_RETRY_INTERVAL_MS = 50;
const MAX_LOCK_ATTEMPTS = 100;

function defaultEnableCursorMcp(cwd: string, id: string): EnableCursorMcpResult {
    return spawnSync('agent', ['mcp', 'enable', id], {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
    });
}

function parseMcpJson(raw: string): CursorMcpJson {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
        return { mcpServers: {} };
    }
    return parsed as CursorMcpJson;
}

function readMcpJson(path: string): CursorMcpJson {
    if (!existsSync(path)) {
        return { mcpServers: {} };
    }
    return parseMcpJson(readFileSync(path, 'utf-8'));
}

/**
 * Atomic replace so readers never see a partial mcp.json; preserves existing mode.
 * Refuses to write through a symlink — a project-controlled link could point
 * outside `cwd`, and cleanup is not a byte-for-byte restore of the target.
 */
export function writeMcpJsonAtomic(path: string, config: CursorMcpJson): void {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
        throw new Error(`Refusing to write a symlinked Cursor MCP config: ${path}`);
    }
    const mode = existsSync(path) ? (statSync(path).mode & 0o777) : 0o600;
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: 'utf-8',
            mode,
        });
        renameSync(tmp, path);
    } finally {
        rmSync(tmp, { force: true });
    }
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readLockOwner(lockPath: string): LockOwner | null {
    try {
        const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as unknown;
        if (
            parsed !== null
            && typeof parsed === 'object'
            && typeof (parsed as LockOwner).pid === 'number'
            && typeof (parsed as LockOwner).token === 'string'
        ) {
            return parsed as LockOwner;
        }
    } catch {
        // corrupt / empty lock
    }
    return null;
}

/** Fail closed: only ESRCH means the PID is confirmed gone. EPERM ⇒ alive. */
export function isProcessAlive(pid: number): boolean {
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: string }).code
            : undefined;
        return code !== 'ESRCH';
    }
}

/**
 * Exclusive cross-process lock for mcp.json read-modify-write.
 * Owner JSON is published atomically via link(2) from a fully-written staging file.
 * Stale/dead locks fail closed — pathname check-then-unlink/rename can steal a
 * successor's live lock under concurrent recoverers. Release unlinks only when
 * the path still holds this owner's token.
 */
export function withMcpJsonLock(lockPath: string, fn: () => void): void {
    let attempts = 0;
    let owner: LockOwner | undefined;

    while (attempts < MAX_LOCK_ATTEMPTS) {
        owner = { pid: process.pid, token: randomUUID() };
        const candidate = `${lockPath}.${owner.token}.tmp`;
        try {
            writeFileSync(candidate, JSON.stringify(owner), {
                encoding: 'utf-8',
                flag: 'wx',
                mode: 0o600,
            });
            try {
                linkSync(candidate, lockPath);
                break;
            } catch (err: unknown) {
                const code = err && typeof err === 'object' && 'code' in err
                    ? (err as { code?: string }).code
                    : undefined;
                if (code !== 'EEXIST') {
                    throw err;
                }
                attempts++;
                const existing = readLockOwner(lockPath);
                if (existing && isProcessAlive(existing.pid)) {
                    sleepSync(LOCK_RETRY_INTERVAL_MS);
                } else {
                    throw new Error(
                        `Stale Cursor MCP overlay lock: ${lockPath}; remove it and retry `
                        + `(e.g. rm -f ${JSON.stringify(lockPath)})`
                    );
                }
            } finally {
                rmSync(candidate, { force: true });
            }
            continue;
        } catch (err: unknown) {
            rmSync(candidate, { force: true });
            if (err instanceof Error && err.message.startsWith('Stale Cursor MCP overlay lock:')) {
                throw err;
            }
            const code = err && typeof err === 'object' && 'code' in err
                ? (err as { code?: string }).code
                : undefined;
            if (code === 'EEXIST') {
                attempts++;
                sleepSync(LOCK_RETRY_INTERVAL_MS);
                continue;
            }
            throw err;
        }
    }

    if (!owner || !existsSync(lockPath) || readLockOwner(lockPath)?.token !== owner.token) {
        throw new Error(`Timed out waiting for Cursor MCP overlay lock: ${lockPath}`);
    }

    try {
        fn();
    } finally {
        try {
            if (readLockOwner(lockPath)?.token === owner.token) {
                unlinkSync(lockPath);
            }
        } catch {
            // ignore
        }
    }
}

function comparableMcpEnv(env?: Record<string, string>): string {
    // Ignore the HAPI PID stamp (rewritten on install / crash-recovery), but
    // treat any other env edit as a concurrent user change that must survive cleanup.
    return JSON.stringify(
        Object.entries(env ?? {})
            .filter(([key]) => key !== HAPI_MCP_OVERLAY_PID_ENV)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function sameMcpEntry(a: McpServerEntry | undefined, b: McpServerEntry | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.command === b.command
        && JSON.stringify(a.args) === JSON.stringify(b.args)
        && comparableMcpEnv(a.env) === comparableMcpEnv(b.env);
}

/**
 * Write one HAPI stdio bridge into the **project** `.cursor/mcp.json` and approve it.
 * When `userMcpConfigDir` is set, strip PID-stamped `hapi` / `hapi-*` keys from that
 * user-level file so Cursor cannot merge sibling session mailboxes into this agent.
 */
export function installCursorMcpOverlay(
    cwd: string,
    bridge: { command: string; args: string[] },
    options: {
        serverId: string;
        overlaySessionId?: string;
        enableCursorMcp?: EnableCursorMcp;
        /** Project Cursor config dir. Default `<cwd>/.cursor`. */
        mcpConfigDir?: string;
        /** User-level Cursor config dir to strip multiplex `hapi-*` keys from. */
        userMcpConfigDir?: string;
    },
): CursorMcpOverlayHandle {
    const serverId = options.serverId.trim();
    if (!serverId) {
        throw new Error('serverId is required for Cursor HAPI MCP overlay');
    }

    const cursorDir = resolveProjectCursorConfigDir(
        cwd,
        options.mcpConfigDir ?? join(cwd, '.cursor'),
    );
    const mcpJsonPath = join(cursorDir, 'mcp.json');
    const lockPath = `${mcpJsonPath}.hapi.lock`;
    mkdirSync(cursorDir, { recursive: true });

    const overlaySessionId = options.overlaySessionId?.trim() || undefined;
    const installedHapi: McpServerEntry = {
        command: bridge.command,
        args: [...bridge.args],
        env: {
            [HAPI_MCP_OVERLAY_PID_ENV]: String(process.pid),
            ...(overlaySessionId ? { [HAPI_MCP_OVERLAY_SESSION_ENV]: overlaySessionId } : {}),
        },
    };

    const userDirRaw = options.userMcpConfigDir?.trim();
    if (userDirRaw) {
        // User dir is operator-trusted — follow estate-disk symlinks.
        const userDir = resolveExistingPath(resolveCursorMcpConfigDir(userDirRaw));
        if (userDir !== cursorDir) {
            const userJsonPath = join(userDir, 'mcp.json');
            if (existsSync(userJsonPath) && !lstatSync(userJsonPath).isSymbolicLink()) {
                withMcpJsonLock(`${userJsonPath}.hapi.lock`, () => {
                    const userConfig = readMcpJson(userJsonPath);
                    userConfig.mcpServers ??= {};
                    stripPidStampedHapiOverlays(userConfig.mcpServers);
                    writeMcpJsonAtomic(userJsonPath, userConfig);
                });
            }
        }
    }

    let hadFile = false;
    let hadServer = false;
    let previousServer: McpServerEntry | undefined;

    const prepareOverlayMutation = (): CursorMcpJson => {
        hadFile = existsSync(mcpJsonPath);
        const previous = hadFile
            ? readMcpJson(mcpJsonPath)
            : { mcpServers: {} as Record<string, McpServerEntry> };
        previous.mcpServers ??= {};

        stripPidStampedHapiOverlays(previous.mcpServers, serverId);

        const existing = previous.mcpServers[serverId];
        const existingPid = overlayPid(existing);
        if (existing && existingPid === null) {
            throw new Error(
                `Project MCP server "${serverId}" already exists (refusing to overwrite a non-HAPI entry)`,
            );
        }
        const existingSession = existing?.env?.[HAPI_MCP_OVERLAY_SESSION_ENV];
        if (
            overlaySessionId
            && existingPid !== null
            && isProcessAlive(existingPid)
            && typeof existingSession === 'string'
            && existingSession.length > 0
            && existingSession !== overlaySessionId
        ) {
            throw new Error(
                `Cannot install a second live HAPI MCP mailbox in this workspace (held by session ${existingSession}).`,
            );
        }

        hadServer = Object.prototype.hasOwnProperty.call(previous.mcpServers, serverId);
        previousServer = hadServer ? previous.mcpServers[serverId] : undefined;
        // Crash left a dead PID-stamped slot — do not restore it on cleanup.
        if (hadServer && isDeadPidStampedOverlay(previousServer)) {
            hadServer = false;
            previousServer = undefined;
        }
        return previous;
    };

    // Validate under lock without writing — Git shield must land before the mailbox mutate.
    withMcpJsonLock(lockPath, () => {
        prepareOverlayMutation();
    });

    // Exclude lease before any mcp.json write so a crash cannot leave an unignored mailbox.
    const unshieldGit = shieldProjectMcpJsonFromGit(cwd, mcpJsonPath);

    try {
        withMcpJsonLock(lockPath, () => {
            const previous = prepareOverlayMutation();
            const config: CursorMcpJson = {
                ...previous,
                mcpServers: {
                    ...previous.mcpServers,
                    [serverId]: installedHapi,
                },
            };
            writeMcpJsonAtomic(mcpJsonPath, config);
        });
    } catch (error) {
        try {
            unshieldGit();
        } catch (unshieldError) {
            logger.debug('[cursor-acp] unshield after mcp.json write failure failed', unshieldError);
        }
        throw error;
    }

    const cleanup = (): void => {
        let safeToUnshield = false;
        try {
            withMcpJsonLock(lockPath, () => {
                if (!existsSync(mcpJsonPath)) {
                    safeToUnshield = true;
                    return;
                }

                const current = readMcpJson(mcpJsonPath);
                current.mcpServers ??= {};

                const currentServer = current.mcpServers[serverId];
                if (!sameMcpEntry(currentServer, installedHapi)) {
                    safeToUnshield = true;
                    return;
                }

                if (hadServer && previousServer) {
                    current.mcpServers[serverId] = previousServer;
                } else {
                    delete current.mcpServers[serverId];
                }

                const { mcpServers, ...otherTopLevel } = current;
                const remainingServers = Object.keys(mcpServers ?? {});
                if (
                    !hadFile
                    && remainingServers.length === 0
                    && Object.keys(otherTopLevel).length === 0
                ) {
                    rmSync(mcpJsonPath, { force: true });
                    safeToUnshield = true;
                    return;
                }

                writeMcpJsonAtomic(mcpJsonPath, current);
                safeToUnshield = true;
            });
        } catch (error) {
            logger.debug('[cursor-acp] cursor MCP overlay cleanup failed', error);
        }
        if (safeToUnshield) {
            try {
                unshieldGit();
            } catch (error) {
                logger.debug('[cursor-acp] cursor MCP overlay git unshield failed', error);
            }
        }
    };

    const enable = (options.enableCursorMcp ?? defaultEnableCursorMcp)(cwd, serverId);

    if (enable.status !== 0) {
        const detail = (enable.stderr || enable.stdout || '').trim();
        cleanup();
        throw new Error(
            `agent mcp enable ${serverId} failed (status=${enable.status ?? 'null'}${detail ? `: ${detail}` : ''})`
        );
    }

    logger.debug(`[cursor-acp] enabled native MCP server ${serverId} via ${mcpJsonPath}`);
    return { cleanup };
}
