import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Remove lock directories left behind by SIGKILL / crash / reboot. */
function clearStaleAcpLockIfNeeded(): void {
    const lockDir = getAcpLockDir();
    if (!existsSync(lockDir)) {
        return;
    }

    const pid = readLockPid(lockDir);
    if (pid === null || !isProcessAlive(pid)) {
        removeAcpLockDir();
    }
}

export function registerActiveAcpTransport(): void {
    activeAcpTransportCount += 1;
    const lockDir = getAcpLockDir();
    try {
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(join(lockDir, 'pid'), String(process.pid));
    } catch {
        // Another process may have created the lock; in-process guard still applies.
    }
}

export function unregisterActiveAcpTransport(): void {
    activeAcpTransportCount = Math.max(0, activeAcpTransportCount - 1);
    if (activeAcpTransportCount > 0) {
        return;
    }
    removeAcpLockDir();
}

export function isAgentAcpTransportActive(): boolean {
    if (activeAcpTransportCount > 0) {
        return true;
    }
    clearStaleAcpLockIfNeeded();
    return existsSync(getAcpLockDir());
}

export function _resetAgentCliGuardForTests(): void {
    activeAcpTransportCount = 0;
    removeAcpLockDir();
}
