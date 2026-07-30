import { createServer } from 'node:net';
import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildOpencodeEnv } from './config';
import { getInvokedCwd } from '@/utils/invokedCwd';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Reserves a free TCP port on the given loopback host by binding an
 * ephemeral probe socket (`listen(0)`) and immediately closing it before
 * resolving. `opencode acp` does not announce the port it actually bound
 * when launched with `--port 0` (verified 2026-07-30 — no port appears in
 * stdout/stderr even at DEBUG log level), so HAPI must pick the port itself
 * and hand it to the subprocess explicitly via `--port`. There is a
 * theoretical reuse race between this function releasing the port and the
 * subprocess binding it, but both sides are loopback-only local processes,
 * so the practical risk is low.
 */
export function allocateFreePort(hostname = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, hostname, () => {
            const address = probe.address();
            const port = address && typeof address === 'object' ? address.port : null;
            probe.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }
                if (port === null) {
                    reject(new Error('Failed to allocate a free port for the OpenCode ACP server'));
                    return;
                }
                resolve(port);
            });
        });
    });
}

export function createOpencodeBackend(opts: {
    cwd?: string;
    port?: number;
    hostname?: string;
}): AcpSdkBackend {
    const env = buildOpencodeEnv();
    const args = ['acp', '--cwd', opts.cwd ?? getInvokedCwd()];
    if (opts.port !== undefined) {
        args.push('--port', String(opts.port));
    }
    if (opts.hostname !== undefined) {
        args.push('--hostname', opts.hostname);
    }

    return new AcpSdkBackend({
        command: 'opencode',
        args,
        env: filterEnv(env),
        textChunkMode: 'delta'
    });
}
