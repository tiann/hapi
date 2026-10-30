import { isObject } from '@hapi/protocol';
import type { OpencodeModelVariantsResponse } from '@hapi/protocol/apiTypes';

export type ListOpencodeModelVariantsResponse = OpencodeModelVariantsResponse;

const PROBE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 300;

/**
 * Extract a `{ 'providerId/modelId': string[] }` map of model variants from an
 * OpenCode server `GET /provider` payload. Only models with at least one
 * variant are collected; malformed entries are skipped defensively.
 */
export function parseOpencodeProviderVariants(payload: unknown): Record<string, string[]> {
    if (!isObject(payload) || !Array.isArray(payload.all)) {
        return {};
    }

    const out: Record<string, string[]> = {};
    for (const provider of payload.all) {
        if (!isObject(provider) || !isObject(provider.models)) {
            continue;
        }
        for (const [, rawModel] of Object.entries(provider.models)) {
            if (!isObject(rawModel)) continue;
            const modelId = typeof rawModel.id === 'string' && rawModel.id.trim() ? rawModel.id : '';
            const providerID = typeof rawModel.providerID === 'string' ? rawModel.providerID : '';
            if (!providerID || !modelId) continue;
            if (!isObject(rawModel.variants)) continue;
            const variants = Object.keys(rawModel.variants).filter((key) => key.length > 0);
            if (variants.length === 0) continue;
            out[`${providerID}/${modelId}`] = variants;
        }
    }
    return out;
}

/**
 * Parse `ps` args output for live `opencode acp --port <n>` servers. Pure so
 * the process-scan path is testable without a real process list.
 */
export function extractOpencodeAcpPorts(psArgsOutput: string): number[] {
    return extractOpencodeAcpServers(psArgsOutput).map((server) => server.port);
}

/**
 * Extract port + cwd from live `opencode acp --cwd <path> --port <n>` process
 * args. The cwd lets callers skip servers whose project-level opencode config
 * would produce a different provider catalog than the requesting directory.
 */
export function extractOpencodeAcpServers(psArgsOutput: string): Array<{ port: number; cwd: string | null }> {
    const servers = new Map<number, string | null>();
    for (const line of psArgsOutput.split('\n')) {
        if (!/\bopencode acp\b/.test(line)) continue;
        const portMatch = /--port (\d+)/.exec(line);
        if (!portMatch) continue;
        const port = Number(portMatch[1]);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
        const cwdMatch = /--cwd (.+?)(?= --|$)/.exec(line);
        servers.set(port, cwdMatch ? cwdMatch[1].trim() : null);
    }
    return [...servers.entries()].map(([port, cwd]) => ({ port, cwd }));
}

async function listRunningOpencodeServers(): Promise<Array<{ port: number; cwd: string | null }>> {
    try {
        const proc = Bun.spawn(['ps', '-eo', 'args='], { stdout: 'pipe', stderr: 'ignore' });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return extractOpencodeAcpServers(output);
    } catch {
        return [];
    }
}

async function fetchVariantsFromServer(port: number): Promise<Record<string, string[]> | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/provider`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return null;
        return parseOpencodeProviderVariants(await response.json());
    } catch {
        return null;
    }
}

async function getEphemeralPort(): Promise<number> {
    const net = await import('node:net');
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : null;
            server.close(() => {
                if (port !== null) {
                    resolve(port);
                } else {
                    reject(new Error('Failed to acquire ephemeral port'));
                }
            });
        });
    });
}

/**
 * Spawned-serve cache: the catalog only changes when the opencode binary or
 * user config changes, so the natural cache unit is the server process
 * lifetime, not an arbitrary TTL. A lazily spawned headless `opencode serve`
 * stays resident and answers subsequent calls instantly; an idle reaper kills
 * it after IDLE_REAP_MS without a request, and an `exit` hook kills it when
 * the CLI exits gracefully. The reaper timer is unref'd so it never keeps the
 * CLI process alive.
 */
type ResidentServe = { proc: ReturnType<typeof Bun.spawn>; port: number; cwd: string | null };
let resident: ResidentServe | null = null;
let idleReapTimer: ReturnType<typeof setTimeout> | null = null;
// In-flight coalescing is keyed by cwd: concurrent requests for different
// directories must not share a catalog (project-level opencode config differs).
const inFlightByCwd = new Map<string | null, Promise<ListOpencodeModelVariantsResponse>>();

const IDLE_REAP_MS = 10 * 60 * 1000;

let exitCleanupRegistered = false;

/**
 * Kill the resident serve when the CLI exits gracefully (same pattern as
 * autoStartServer's hub cleanup). Signal ownership stays with the runner so
 * its asynchronous shutdown can finish before the process exits.
 */
function registerExitCleanup(): void {
    if (exitCleanupRegistered) return;
    exitCleanupRegistered = true;
    const killResident = () => {
        resident?.proc.kill();
        resident = null;
    };
    process.on('exit', killResident);
}

function scheduleIdleReap(): void {
    if (idleReapTimer) {
        clearTimeout(idleReapTimer);
    }
    const target = resident;
    idleReapTimer = setTimeout(() => {
        // Only reap the serve this timer was scheduled for — a newer call may
        // have replaced the resident between scheduling and firing.
        if (resident === target && resident) {
            resident.proc.kill();
            resident = null;
        }
        idleReapTimer = null;
    }, IDLE_REAP_MS);
    idleReapTimer.unref?.();
}

export function listOpencodeModelVariants(request?: { cwd?: string | null }): Promise<ListOpencodeModelVariantsResponse> {
    const cwd = request?.cwd ?? null;
    const existing = inFlightByCwd.get(cwd);
    if (existing) {
        return existing;
    }
    const promise = listOpencodeModelVariantsUncached(cwd).finally(() => {
        inFlightByCwd.delete(cwd);
    });
    inFlightByCwd.set(cwd, promise);
    return promise;
}

async function listOpencodeModelVariantsUncached(cwd: string | null): Promise<ListOpencodeModelVariantsResponse> {
    // Prefer a live OpenCode session's server — its /provider catalog is
    // identical and answering from it skips any spawn entirely. Only servers
    // running in the same cwd are used: project-level opencode config can
    // override the provider catalog per directory.
    for (const server of await listRunningOpencodeServers()) {
        if (server.cwd !== cwd) continue;
        const variants = await fetchVariantsFromServer(server.port);
        if (variants) {
            return { success: true, variants };
        }
    }

    // Resident serve from a previous call — still the same opencode install
    // and config, so the cached catalog is current by construction. A cwd
    // mismatch means a different project config: kill and respawn targeted.
    if (resident) {
        if (resident.cwd !== cwd) {
            resident.proc.kill();
            resident = null;
        } else {
            const variants = await fetchVariantsFromServer(resident.port);
            if (variants) {
                scheduleIdleReap();
                return { success: true, variants };
            }
            // Server died (e.g. reaped externally) — fall through and respawn.
            resident.proc.kill();
            resident = null;
        }
    }

    const spawned = await spawnServeWithCatalog(cwd);
    if (!spawned.success) {
        return spawned;
    }
    // A concurrent different-cwd call may have installed its own resident in
    // parallel — it is no longer referenced by anyone once we overwrite it.
    // (Read through an explicit type: TS narrows the module singleton to null
    // on this path, but a concurrent call may have assigned it.)
    const previousResident = resident as ResidentServe | null;
    if (previousResident) {
        previousResident.proc.kill();
    }
    resident = { proc: spawned.proc, port: spawned.port, cwd };
    registerExitCleanup();
    scheduleIdleReap();
    return { success: true, variants: spawned.variants };
}

async function spawnServeWithCatalog(cwd: string | null): Promise<
    { success: false; error: string } | { success: true; proc: ReturnType<typeof Bun.spawn>; port: number; variants: Record<string, string[]> }
> {
    let port: number;
    try {
        port = await getEphemeralPort();
    } catch {
        return { success: false, error: 'Failed to acquire ephemeral port' };
    }

    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
        proc = Bun.spawn(['opencode', 'serve', '--port', String(port)], {
            stdout: 'ignore',
            stderr: 'ignore',
            ...(cwd ? { cwd } : {}),
        });

        const deadline = Date.now() + PROBE_TIMEOUT_MS;
        let payload: unknown = null;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            // Bail out early instead of burning the full deadline when serve
            // died on bind (e.g. the ephemeral port was claimed in the gap).
            if (proc.exitCode !== null) {
                break;
            }
            try {
                const response = await fetch(`http://127.0.0.1:${port}/provider`, { signal: AbortSignal.timeout(2000) });
                if (response.ok) {
                    payload = await response.json();
                    break;
                }
            } catch {
                // Server not ready yet — keep polling until the deadline.
            }
        }

        if (!payload || proc.exitCode !== null) {
            proc.kill();
            return { success: false, error: 'OpenCode provider catalog did not become available in time' };
        }

        return { success: true, proc, port, variants: parseOpencodeProviderVariants(payload) };
    } catch (error) {
        proc?.kill();
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to list OpenCode model variants'
        };
    }
}
