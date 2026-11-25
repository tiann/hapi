import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'cross-spawn';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { materializePiExtension } from '@/pi/hapiExtension';

const PEER_TOOLS = [
    'mcp__hapi__list_peers',
    'mcp__hapi__inspect_peer',
    'mcp__hapi__ping_peer',
    'mcp__hapi__spawn_peer',
] as const;

const PROBE_SOURCE = `// Temporary probe for the opt-in HAPI Pi RPC + MCP smoke test.
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expected = ${JSON.stringify(PEER_TOOLS)};

export default function hapiPiMcpProbe(pi) {
    const resultPath = process.env.HAPI_SMOKE_RESULT_PATH;
    if (!resultPath) throw new Error('HAPI_SMOKE_RESULT_PATH is missing');

    pi.on('session_start', (_event, ctx) => {
        // Do not await MCP discovery inside session_start: the built-in MCP
        // extension connects in its own session_start listener.
        void (async () => {
            const finish = (payload) => {
                writeFileSync(resultPath, JSON.stringify(payload, null, 2));
                setTimeout(() => ctx.shutdown(), 50);
            };
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                const names = pi.getAllTools().map((tool) => tool.name);
                if (expected.every((name) => names.includes(name))) {
                    const approved = await ctx.ui.confirm(
                        'HAPI MCP smoke',
                        'Allow the temporary RPC confirmation check?',
                        { timeout: 5_000 },
                    );
                    finish({
                        ok: approved === true,
                        approved,
                        mode: ctx.mode,
                        hasUI: ctx.hasUI,
                        activeTools: pi.getActiveTools(),
                        mcpServers: pi.getMcpServers(),
                    });
                    return;
                }
                await sleep(100);
            }
            finish({
                ok: false,
                error: 'HAPI peer MCP tools did not register before timeout',
                tools: pi.getAllTools().map((tool) => tool.name),
                mcpServers: pi.getMcpServers(),
            });
        })();
    });
}
`;

type SmokeResult = {
    ok: boolean;
    approved?: boolean;
    mode?: string;
    hasUI?: boolean;
    activeTools?: string[];
    mcpServers?: unknown[];
    tools?: string[];
    error?: string;
};

const runSmoke = process.env.HAPI_PI_MCP_SMOKE === '1' ? describe : describe.skip;

runSmoke('Pi RPC + HAPI MCP opt-in smoke', () => {
    let stopServer: (() => void) | null = null;
    let child: ReturnType<typeof spawn> | null = null;

    afterEach(() => {
        stopServer?.();
        stopServer = null;
        if (child && child.exitCode === null) child.kill();
        child = null;
    });

    it('discovers the real HAPI peer MCP server through the bundled Pi extension', async () => {
        const artifactRoot = process.env.HAPI_SMOKE_ARTIFACT_DIR;
        if (!artifactRoot) throw new Error('HAPI_SMOKE_ARTIFACT_DIR is required');
        await mkdir(artifactRoot, { recursive: true });

        const hapiExtensionPath = await materializePiExtension(artifactRoot);
        const probePath = join(artifactRoot, 'pi-mcp-probe.ts');
        const resultPath = join(artifactRoot, 'result.json');
        const stdoutPath = join(artifactRoot, 'pi-stdout.log');
        const stderrPath = join(artifactRoot, 'pi-stderr.log');
        await writeFile(probePath, PROBE_SOURCE, 'utf8');

        const sessionClient = {
            sessionId: 'pi-peer-mcp-smoke-session',
            getMetadata: () => ({ name: 'Pi peer MCP smoke', path: artifactRoot, flavor: 'pi' }),
            updateMetadata: () => undefined,
            sendAgentMessage: () => undefined,
            sendClaudeSessionMessage: () => undefined,
        } as unknown as ApiSessionClient;

        const server = await startHappyServer(sessionClient, {
            enableChangeTitle: false,
            enabledTools: ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
        });
        stopServer = server.stop;

        let stdout = '';
        let stderr = '';
        let confirmSeen = false;
        let pendingStdout = '';

        child = spawn('pi', [
            '--mode', 'rpc',
            '--no-session',
            '--extension', hapiExtensionPath,
            '--extension', probePath,
        ], {
            cwd: artifactRoot,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: join(artifactRoot, 'pi-agent'),
                HAPI_PI_MCP_URL: server.url,
                HAPI_SMOKE_RESULT_PATH: resultPath,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        child.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            stdout += text;
            pendingStdout += text;
            let newline = pendingStdout.indexOf('\n');
            while (newline >= 0) {
                const line = pendingStdout.slice(0, newline).replace(/\r$/, '');
                pendingStdout = pendingStdout.slice(newline + 1);
                if (line.trim()) {
                    try {
                        const record = JSON.parse(line) as {
                            type?: string;
                            method?: string;
                            id?: string;
                        };
                        if (record.type === 'extension_ui_request'
                            && record.method === 'confirm'
                            && typeof record.id === 'string') {
                            confirmSeen = true;
                            child?.stdin?.write(JSON.stringify({
                                type: 'extension_ui_response',
                                id: record.id,
                                confirmed: true,
                            }) + '\n');
                        }
                    } catch {
                        // Malformed lines remain available in the captured stdout.
                    }
                }
                newline = pendingStdout.indexOf('\n');
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });

        const deadline = Date.now() + 25_000;
        let result: SmokeResult | undefined;
        while (Date.now() < deadline) {
            try {
                result = JSON.parse(await readFile(resultPath, 'utf8')) as SmokeResult;
                break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        await writeFile(stdoutPath, stdout, 'utf8');
        await writeFile(stderrPath, stderr, 'utf8');

        if (!result) {
            throw new Error(`Pi smoke produced no result (exit=${child.exitCode}). stderr:\n${stderr}`);
        }

        expect(confirmSeen).toBe(true);
        expect(result).toMatchObject({
            ok: true,
            approved: true,
            mode: 'rpc',
            hasUI: true,
        });
        for (const name of PEER_TOOLS) {
            expect(result.activeTools).toContain(name);
        }
        expect(result.activeTools).not.toContain('mcp__hapi__change_title');
        expect(result.activeTools).not.toContain('mcp__hapi__display_image');
        expect(result.activeTools).not.toContain('mcp__hapi__display_video');
        expect(result.activeTools).not.toContain('mcp__hapi__display_media');
        expect(result.mcpServers).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'hapi' }),
        ]));
    }, 35_000);
});
