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

    const port = Number.parseInt(value, 10);
    if (!port || Number.isNaN(port)) {
        return null;
    }

    return port;
}

export async function runSessionHookForwarder(args: string[]): Promise<void> {
    const port = parsePort(args[0]);
    if (!port) {
        logError('Invalid or missing port argument');
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
                path: '/hook/session-start',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length
                }
            }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    hadError = true;
                    logError(`Hook server responded with status ${res.statusCode}`);
                }
                res.on('error', (error) => {
                    hadError = true;
                    logError('Error reading hook server response', error);
                    resolve();
                });
                res.on('end', () => resolve());
                res.resume();
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
