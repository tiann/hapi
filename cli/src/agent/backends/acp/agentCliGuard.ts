import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Cursor's `agent` CLI appears to allow only one active process at a time.
 * Spawning `agent --list-models` while `agent acp` is running terminates the ACP
 * child (SIGTERM / exit 143) and crashes the remote session.
 *
 * In-process ref counting covers RPC handlers in the same process; a HAPI_HOME
 * lock directory covers runner vs session child processes.
 */
let activeAcpTransportCount = 0;

function getAcpLockDir(): string {
    const home = process.env.HAPI_HOME?.trim() || join(tmpdir(), 'hapi');
    return join(home, 'locks', 'agent-acp-active');
}

function getPidsDir(lockDir: string): string {
    return join(lockDir, 'pids');
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

function addLockPid(lockDir: string, pid: number): void {
    const pidsDir = getPidsDir(lockDir);
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, String(pid)), String(pid), 'utf8');
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

export function registerActiveAcpTransport(): void {
    activeAcpTransportCount += 1;
    const lockDir = getAcpLockDir();
    try {
        mkdirSync(lockDir, { recursive: true });
        writeLockCount(lockDir, readLockCount(lockDir) + 1);
        addLockPid(lockDir, process.pid);
    } catch {
        // Another process may have created the lock; in-process guard still applies.
    }
}

export function unregisterActiveAcpTransport(): void {
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
        if (activeAcpTransportCount <= 0) {
            removeLockPid(lockDir, process.pid);
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

    return readLockCount(lockDir) > 0;
}

export function _resetAgentCliGuardForTests(): void {
    activeAcpTransportCount = 0;
    removeAcpLockDir();
}
