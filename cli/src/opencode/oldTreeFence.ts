import { readdirSync, readFileSync } from 'node:fs';

type Identity = { pid: number; startMarker: string };
type State = { parent: number; startMarker: string; zombie: boolean };

function read(path: string): string {
    return readFileSync(path, 'utf8');
}

/** Linux exposes per-thread child lists only with CONFIG_PROC_CHILDREN. */
export function canEnumerateProcChildren(): boolean {
    if (process.platform !== 'linux') return false;
    try {
        read(`/proc/self/task/${process.pid}/children`);
        return true;
    } catch {
        return false;
    }
}

function linuxState(pid: number): State | null {
    try {
        const stat = read(`/proc/${pid}/stat`);
        // comm is parenthesized and can itself contain spaces or parentheses.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Unreadable process start time');
        return { parent: Number(fields[1]), startMarker: fields[19]!, zombie: fields[0] === 'Z' };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function scanDirectServers(parent: number): Identity[] | null {
    const owner = linuxState(parent);
    if (!owner || owner.zombie) return null;
    const pids = new Set<number>();
    for (const tid of readdirSync(`/proc/${parent}/task`)) {
        for (const id of read(`/proc/${parent}/task/${tid}/children`).trim().split(/\s+/)) {
            if (id) pids.add(Number(id));
        }
    }
    const servers: Identity[] = [];
    for (const pid of pids) {
        const state = linuxState(pid);
        if (!state) throw Object.assign(new Error('Child disappeared during capture'), { code: 'ENOENT' });
        if (state.parent !== parent) return null;
        if (state.zombie) continue;
        const argv = read(`/proc/${pid}/cmdline`).split('\0');
        if (!argv[0]) return null;
        if (argv.includes('serve') && argv.includes('--stdio')) servers.push({ pid, startMarker: state.startMarker });
    }
    const finalOwner = linuxState(parent);
    if (!finalOwner || finalOwner.zombie || finalOwner.startMarker !== owner.startMarker) return null;
    for (const server of servers) {
        const current = linuxState(server.pid);
        if (!current) throw Object.assign(new Error('Server disappeared during capture'), { code: 'ENOENT' });
        if (current.parent !== parent || current.startMarker !== server.startMarker) return null;
    }
    return servers;
}

export function captureServeProcesses(parent: number, platform = process.platform): Identity[] | null {
    if (platform !== 'linux') return null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return scanDirectServers(parent);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        }
    }
    return null;
}

// OpenCode starts one standalone serve process before accepting ACP requests.
// Keep identities across observations so a later snapshot cannot erase an owner.
export function createServeFence(
    observe: () => Identity[] | null,
    verifyExit: (servers: readonly Identity[]) => Promise<boolean> = waitForServeExit
) {
    const recorded: Identity[] = [];
    let complete = true;
    const refresh = () => {
        const servers = observe();
        if (servers?.length !== 1) complete = false;
        for (const server of servers ?? []) {
            if (!recorded.some(previous => previous.pid === server.pid && previous.startMarker === server.startMarker)) {
                recorded.push(server);
            }
        }
    };
    refresh();
    return { refresh, verify: () => complete ? verifyExit(recorded) : Promise.resolve(false) };
}

// OpenCode v2.3.0 and v2.3.2 wait 2s for MCP helpers (packages/core/src/mcp/stdio.ts:11,71).
// All 40 observed idle and busy exits took 2.05–2.10s. Allow 3s for helper and store cleanup.
export async function waitForServeExit(servers: readonly Identity[] | null, budgetMs = 3_000): Promise<boolean> {
    if (!servers?.length || process.platform !== 'linux') return false;
    const deadline = performance.now() + budgetMs;
    try {
        while (performance.now() < deadline) {
            if (servers.every(({ pid, startMarker }) => {
                const state = linuxState(pid);
                return !state || state.startMarker !== startMarker || state.zombie;
            })) return performance.now() < deadline;
            await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, deadline - performance.now()))));
        }
    } catch { /* An unreadable process identity cannot prove termination. */ }
    return false;
}
