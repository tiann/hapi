import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
    releaseAgentCliSpawnLeaseFromAcpRegisterSync,
    _resetAgentCliSpawnLeaseForTests
} from '@hapi/protocol/agentCliSpawnLease';
import { resolveHapiHomeDir } from '@/configuration';

/**
 * Cursor's `agent` CLI appears to allow only one active process at a time.
 * Spawning `agent --list-models` while `agent acp` is running terminates the ACP
 * child (SIGTERM / exit 143) and crashes the remote session.
 *
 * In-process ref counting covers RPC handlers in the same process; a HAPI_HOME
 * lock directory covers runner vs session child processes. The proper-lockfile
 * spawn lease (`locks/agent-cli.spawn`) is held only around `spawn('agent')`
 * in AcpStdioTransport and during list-models probes — not for the full session
 * (#1520; multi-session ACP must remain possible).
 *
 * Prefer recording the ACP child PID (not only the HAPI host PID) so stale
 * cleanup and logs attribute the real `agent` process. Register the lock
 * before spawn, and keep it held until stdio `close` — releasing on bare
 * `exit` opens a window where list-models can start another `agent`.
 *
 * Filesystem publish order is fail-closed: host PID marker under `pids/` is
 * written before `count`, so concurrent reconcile never sees a lock with no
 * pids and clears it mid-reservation. Per-host `registering/<pid>` markers
 * cover the mkdir→pid gap even when a prior transport left a positive
 * `count` (last-unregister vs concurrent register); dead-owner markers are
 * pruned so a crash cannot pin list-models forever. Mtime grace is a
 * backstop for the tiny window before that marker lands.
 */
let activeAcpTransportCount = 0;

/** @internal Test hook fired between register publish steps. */
let registerPublishHook: ((step: 'after-mkdir' | 'after-host-pid' | 'after-count') => void) | null = null;

/** @internal Test hook inside addLockPid (mkdir vs write gap). */
let addLockPidHook: ((phase: 'after-pids-mkdir' | 'after-pid-write') => void) | null = null;

/** Fail-closed window while mkdir → first pid file is in flight. */
const PRESPAWN_RESERVATION_GRACE_MS = 5_000;

const REGISTERING_MARKER = 'registering';

export type AgentAcpGuardPidOptions = {
    /** Spawned `agent` child PID when known. */
    childPid?: number;
};

function normalizePid(pid: number | undefined): number | null {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    return pid;
}

export function getAgentAcpLockDir(): string {
    return join(resolveHapiHomeDir(), 'locks', 'agent-acp-active');
}

function getAcpLockDir(): string {
    return getAgentAcpLockDir();
}

function getPidsDir(lockDir: string): string {
    return join(lockDir, 'pids');
}

function getRegisteringDir(lockDir: string): string {
    return join(lockDir, REGISTERING_MARKER);
}

function beginRegistering(lockDir: string): void {
    const dir = getRegisteringDir(lockDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, String(process.pid)), String(Date.now()), 'utf8');
}

function endRegistering(lockDir: string): void {
    try {
        rmSync(join(getRegisteringDir(lockDir), String(process.pid)), { force: true });
    } catch {
        // Best effort.
    }
}

/** True if any live host still holds a mid-publish reservation marker. */
function isRegistering(lockDir: string): boolean {
    const dir = getRegisteringDir(lockDir);
    if (!existsSync(dir)) {
        return false;
    }

    let anyLive = false;
    for (const entry of readdirSync(dir)) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 0) {
            try {
                rmSync(join(dir, entry), { force: true });
            } catch {
                // Best effort.
            }
            continue;
        }
        if (isProcessAlive(pid)) {
            anyLive = true;
            continue;
        }
        try {
            rmSync(join(dir, entry), { force: true });
        } catch {
            // Best effort — crash/reboot left a dead registrar marker.
        }
    }
    return anyLive;
}

function isFreshPrespawnReservation(lockDir: string): boolean {
    try {
        return Date.now() - statSync(lockDir).mtimeMs < PRESPAWN_RESERVATION_GRACE_MS;
    } catch {
        // Fail closed — prefer keeping a disputed lock over list-models SIGTERM.
        return true;
    }
}

function readLockPid(lockDir: string): number | null {
    const pidPath = join(lockDir, 'pid');
    if (!existsSync(pidPath)) {
        return null;
    }

    try {
        const raw = readFileSync(pidPath, 'utf8').trim();
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) {
            return null;
        }
        return pid;
    } catch {
        return null;
    }
}

function readLockCount(lockDir: string): number {
    const countPath = join(lockDir, 'count');
    if (!existsSync(countPath)) {
        return 0;
    }

    try {
        const raw = readFileSync(countPath, 'utf8').trim();
        const count = Number(raw);
        if (!Number.isInteger(count) || count < 0) {
            return 0;
        }
        return count;
    } catch {
        return 0;
    }
}

function writeLockCount(lockDir: string, count: number): void {
    writeFileSync(join(lockDir, 'count'), String(Math.max(0, count)), 'utf8');
}

function writeChildPidHint(lockDir: string, childPid: number): void {
    writeFileSync(join(lockDir, 'child-pid'), String(childPid), 'utf8');
}

function clearChildPidHint(lockDir: string): void {
    try {
        rmSync(join(lockDir, 'child-pid'), { force: true });
    } catch {
        // Best effort.
    }
}

function addLockPid(lockDir: string, pid: number): void {
    const pidsDir = getPidsDir(lockDir);
    const pidPath = join(pidsDir, String(pid));
    // Retry once if a concurrent last-unregister deleted the lock mid-publish.
    for (let attempt = 0; attempt < 2; attempt++) {
        mkdirSync(lockDir, { recursive: true });
        mkdirSync(pidsDir, { recursive: true });
        addLockPidHook?.('after-pids-mkdir');
        try {
            writeFileSync(pidPath, String(pid), { encoding: 'utf8', flag: 'w' });
            addLockPidHook?.('after-pid-write');
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt === 0 && (code === 'ENOENT' || code === 'ENOTDIR')) {
                continue;
            }
            throw error;
        }
    }
}

function removeLockPid(lockDir: string, pid: number): void {
    try {
        rmSync(join(getPidsDir(lockDir), String(pid)), { force: true });
    } catch {
        // Best effort.
    }
}

function isLegacyLock(lockDir: string): boolean {
    return existsSync(join(lockDir, 'pid')) && !existsSync(join(lockDir, 'count'));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Process exists but we lack permission to signal it.
        return code === 'EPERM';
    }
}

function removeAcpLockDir(): void {
    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return;
    }
    try {
        rmSync(lockDir, { recursive: true, force: true });
    } catch {
        // Best effort — stale lock is preferable to killing a live ACP session.
    }
}

function reconcileRefcountLock(lockDir: string): boolean {
    const pidsDir = getPidsDir(lockDir);
    if (!existsSync(pidsDir)) {
        // Registrar mid-publish, or grace before `registering` / first pid.
        if (isRegistering(lockDir) || isFreshPrespawnReservation(lockDir)) {
            return true;
        }
        removeAcpLockDir();
        return false;
    }

    let liveCount = 0;
    for (const entry of readdirSync(pidsDir)) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 0) {
            try {
                rmSync(join(pidsDir, entry), { force: true });
            } catch {
                // Best effort.
            }
            continue;
        }

        if (isProcessAlive(pid)) {
            liveCount += 1;
            continue;
        }

        try {
            rmSync(join(pidsDir, entry), { force: true });
        } catch {
            // Best effort.
        }
    }

    if (liveCount <= 0) {
        // Re-read: registrar may have published a pid during our scan, or we
        // are between mkdir(pids) and writeFile (empty dir — fail closed).
        // A live `registering` marker covers overlap with leftover count>0
        // from a concurrent last-unregister.
        let entries: string[] = [];
        try {
            entries = readdirSync(pidsDir);
        } catch {
            entries = [];
        }
        const liveAgain = entries.filter((entry) => {
            const pid = Number(entry);
            return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
        });
        if (liveAgain.length > 0) {
            writeLockCount(lockDir, liveAgain.length);
            return true;
        }
        if (isRegistering(lockDir)) {
            return true;
        }
        if (
            entries.length === 0
            && readLockCount(lockDir) <= 0
            && (isFreshPrespawnReservation(pidsDir) || isFreshPrespawnReservation(lockDir))
        ) {
            return true;
        }
        removeAcpLockDir();
        return false;
    }

    writeLockCount(lockDir, liveCount);
    return true;
}

/** Remove lock directories left behind by SIGKILL / crash / reboot. */
function clearStaleAcpLockIfNeeded(): void {
    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return;
    }

    if (isLegacyLock(lockDir)) {
        const pid = readLockPid(lockDir);
        if (pid === null || !isProcessAlive(pid)) {
            removeAcpLockDir();
        }
        return;
    }

    reconcileRefcountLock(lockDir);
}

/**
 * Reserve / register the ACP lock. Call before spawn (no childPid) so
 * list-models cannot race the new `agent` process, then call
 * {@link recordActiveAcpChildPid} once the child PID is known.
 *
 * Publish order is fail-closed: `pids/<hostPid>` (and optional child) land
 * before `count`, so concurrent reconcile never treats the reservation as
 * a lock with no pids.
 */
export function registerActiveAcpTransport(options?: AgentAcpGuardPidOptions): void {
    activeAcpTransportCount += 1;
    const lockDir = getAcpLockDir();
    const childPid = normalizePid(options?.childPid);
    try {
        mkdirSync(lockDir, { recursive: true });
        beginRegistering(lockDir);
        registerPublishHook?.('after-mkdir');
        // Always keep the HAPI host PID for crash/stale cleanup of the session
        // process; also record the ACP child when known — before count.
        addLockPid(lockDir, process.pid);
        if (childPid !== null) {
            addLockPid(lockDir, childPid);
            writeChildPidHint(lockDir, childPid);
        }
        registerPublishHook?.('after-host-pid');
        writeLockCount(lockDir, readLockCount(lockDir) + 1);
        registerPublishHook?.('after-count');
    } catch {
        // Another process may have created the lock; in-process guard still applies.
    } finally {
        endRegistering(lockDir);
    }
}

/** Upgrade a pre-spawn reservation with the real ACP child PID. */
export function recordActiveAcpChildPid(childPid: number): void {
    const pid = normalizePid(childPid);
    if (pid === null) {
        return;
    }
    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return;
    }
    try {
        addLockPid(lockDir, pid);
        writeChildPidHint(lockDir, pid);
    } catch {
        // Best effort.
    }
}

export function unregisterActiveAcpTransport(options?: AgentAcpGuardPidOptions): void {
    activeAcpTransportCount = Math.max(0, activeAcpTransportCount - 1);

    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return;
    }

    if (isLegacyLock(lockDir)) {
        if (activeAcpTransportCount <= 0) {
            removeAcpLockDir();
        }
        return;
    }

    try {
        const childPid = normalizePid(options?.childPid);
        if (childPid !== null) {
            removeLockPid(lockDir, childPid);
        }
        if (activeAcpTransportCount <= 0) {
            removeLockPid(lockDir, process.pid);
            clearChildPidHint(lockDir);
        }
        reconcileRefcountLock(lockDir);
    } catch {
        // Best effort.
    }
}

export function isAgentAcpTransportActive(): boolean {
    if (activeAcpTransportCount > 0) {
        return true;
    }
    clearStaleAcpLockIfNeeded();
    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return false;
    }

    if (isLegacyLock(lockDir)) {
        const pid = readLockPid(lockDir);
        return pid !== null && isProcessAlive(pid);
    }

    if (readLockCount(lockDir) > 0) {
        return true;
    }
    // Mid-publish: registering marker or mtime grace without a count yet.
    if (isRegistering(lockDir)) {
        return true;
    }
    return isFreshPrespawnReservation(lockDir);
}

/** Debug attribution for exit / list-models races (PID, lock dir, activity). */
export function describeAgentAcpGuardState(childPid?: number | null): {
    lockDir: string;
    inProcessCount: number;
    childPid: number | null;
    childAlive: boolean | null;
    guardActive: boolean;
} {
    const pid = normalizePid(childPid ?? undefined);
    return {
        lockDir: getAgentAcpLockDir(),
        inProcessCount: activeAcpTransportCount,
        childPid: pid,
        childAlive: pid === null ? null : isProcessAlive(pid),
        guardActive: isAgentAcpTransportActive()
    };
}

export function _setRegisterPublishHookForTests(
    hook: ((step: 'after-mkdir' | 'after-host-pid' | 'after-count') => void) | null
): void {
    registerPublishHook = hook;
}

export function _setAddLockPidHookForTests(
    hook: ((phase: 'after-pids-mkdir' | 'after-pid-write') => void) | null
): void {
    addLockPidHook = hook;
}

/** Simulate a cross-process reader (no in-process reservation). */
export function _setActiveAcpTransportCountForTests(count: number): void {
    activeAcpTransportCount = Math.max(0, count);
}

export function _resetAgentCliGuardForTests(): void {
    const home = process.env.HAPI_HOME;
    activeAcpTransportCount = 0;
    registerPublishHook = null;
    addLockPidHook = null;
    releaseAgentCliSpawnLeaseFromAcpRegisterSync();
    _resetAgentCliSpawnLeaseForTests(home);
    removeAcpLockDir();
}
