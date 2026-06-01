import { request } from 'node:http';

function logError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error ? String(error) : '');
    const suffix = detail ? `: ${detail}` : '';
    process.stderr.write(`[hook-forwarder] ${message}${suffix}\n`);
}

function parsePort(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }

    return port;
}

function parsePath(value: string | undefined): string | null {
    if (!value || !value.startsWith('/')) {
        return null;
    }

    return value;
}

function parseArgs(args: string[]): { port: number | null; token: string | null; path: string } {
    let port: number | null = null;
    let token: string | null = null;
    let path = '/hook/session-start';

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg) {
            continue;
        }

        if (arg === '--port' || arg === '-p') {
            port = parsePort(args[i + 1]);
            i += 1;
            continue;
        }

        if (arg.startsWith('--port=')) {
            port = parsePort(arg.slice('--port='.length));
            continue;
        }

        if (arg === '--token' || arg === '-t') {
            token = args[i + 1] ?? null;
            i += 1;
            continue;
        }

        if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length);
            continue;
        }

        if (arg === '--path') {
            path = parsePath(args[i + 1]) ?? path;
            i += 1;
            continue;
        }

        if (arg.startsWith('--path=')) {
            path = parsePath(arg.slice('--path='.length)) ?? path;
            continue;
        }

        if (!port) {
            port = parsePort(arg);
            continue;
        }

        if (!token) {
            token = arg;
        }
    }

    return { port, token, path };
}

export async function runSessionHookForwarder(args: string[]): Promise<void> {
    const { port, token, path } = parseArgs(args);
    if (!port) {
        logError('Invalid or missing port argument');
        process.exitCode = 1;
        return;
    }

    if (!token) {
        logError('Missing hook token');
        process.exitCode = 1;
        return;
    }

    try {
        const chunks: Buffer[] = [];
        process.stdin.resume();
        for await (const chunk of process.stdin) {
            if (typeof chunk === 'string') {
                chunks.push(Buffer.from(chunk));
            } else {
                chunks.push(chunk as Buffer);
            }
        }

        const body = Buffer.concat(chunks);

        let hadError = false;
        await new Promise<void>((resolve) => {
            const req = request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    'x-hapi-hook-token': token
                }
            }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    hadError = true;
                    logError(`Hook server responded with status ${res.statusCode}`);
                }
                const responseChunks: Buffer[] = [];
                res.on('data', (chunk) => {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                res.on('error', (error) => {
                    hadError = true;
                    logError('Error reading hook server response', error);
                    resolve();
                });
                res.on('end', () => {
                    if (path !== '/hook/session-start' && responseChunks.length > 0) {
                        process.stdout.write(Buffer.concat(responseChunks));
                    }
                    resolve();
                });
            });

            req.on('error', (error) => {
                hadError = true;
                logError('Failed to send hook request', error);
                resolve();
            });
            req.end(body);
        });
        if (hadError) {
            process.exitCode = 1;
        }
    } catch (error) {
        logError('Failed to forward session hook', error);
        process.exitCode = 1;
    }
}
