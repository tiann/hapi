import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import {
    prepareCodexMcpServers,
    shouldProxyCodexMcpStdio
} from './codexMcpProxy';

const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('codexMcpProxy', () => {
    it('limits the compatibility proxy to Windows command shims', () => {
        expect(shouldProxyCodexMcpStdio('uvx', 'win32')).toBe(true);
        expect(shouldProxyCodexMcpStdio('C:\\Tools\\uvx.exe', 'win32')).toBe(true);
        expect(shouldProxyCodexMcpStdio('C:\\Tools\\server.cmd', 'win32')).toBe(true);
        expect(shouldProxyCodexMcpStdio('node', 'win32')).toBe(false);
        expect(shouldProxyCodexMcpStdio('uvx', 'linux')).toBe(false);
    });

    it('preserves server fields while replacing only the Windows shim launcher', async () => {
        const prepared = await prepareCodexMcpServers({
            'package-manager': {
                command: 'uvx',
                args: ['--from', 'example-mcp==1.0.0', 'example-mcp', 'serve'],
                env_vars: ['EXAMPLE_TOKEN'],
                enabled: true,
                tool_timeout_sec: 60
            },
            nodeServer: {
                command: 'node',
                args: ['server.js'],
                enabled: true
            },
            remoteShim: {
                command: 'uvx',
                args: ['remote-mcp', 'serve'],
                environment_id: 'remote',
                enabled: true
            },
            remote: {
                url: 'https://example.test/mcp',
                bearer_token_env_var: 'REMOTE_MCP_TOKEN'
            }
        }, 'win32');

        try {
            const proxied = prepared.servers['package-manager'] as {
                command: string;
                args: string[];
                [key: string]: unknown;
            };
            expect(proxied).toEqual(expect.objectContaining({
                env_vars: ['EXAMPLE_TOKEN'],
                enabled: true,
                tool_timeout_sec: 60
            }));

            const specPath = proxied.args.at(-1);
            expect(typeof specPath).toBe('string');
            if (!specPath) {
                throw new Error('Expected a proxy spec path');
            }
            expect(proxied.args).toContain('mcp-proxy');
            expect(proxied.command).toBe(getHappyCliCommand(['mcp-proxy', '--spec', specPath]).command);
            expect(existsSync(specPath)).toBe(true);
            await expect(readFile(specPath, 'utf8')).resolves.toBe(JSON.stringify({
                command: 'uvx',
                args: ['--from', 'example-mcp==1.0.0', 'example-mcp', 'serve']
            }));

            expect(prepared.servers.nodeServer).toEqual({
                command: 'node',
                args: ['server.js'],
                enabled: true
            });
            expect(prepared.servers.remoteShim).toEqual({
                command: 'uvx',
                args: ['remote-mcp', 'serve'],
                environment_id: 'remote',
                enabled: true
            });
            expect(prepared.servers.remote).toEqual({
                url: 'https://example.test/mcp',
                bearer_token_env_var: 'REMOTE_MCP_TOKEN'
            });
        } finally {
            await prepared.cleanup();
        }

        const cleanedProxy = prepared.servers['package-manager'] as { args: string[] };
        expect(existsSync(cleanedProxy.args.at(-1) as string)).toBe(false);
        await prepared.cleanup();
    });

    windowsIt('launches a bare command through a temporary Windows shim', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-mcp-shim-test-'));
        const serverPath = join(directory, 'server.js');
        const shimPath = join(directory, 'example-mcp.cmd');
        const specPath = join(directory, 'spec.json');
        const originalPath = process.env.PATH ?? '';
        const shimArgs = [
            'C:\\Users\\Jane Doe\\repo',
            'literal&value',
            'percent%value',
            'caret^value'
        ];
        const serverScript = [
            "const receivedArgs = JSON.stringify(process.argv.slice(2));",
            "let buffer = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', (chunk) => {",
            "    buffer += chunk;",
            "    const newline = buffer.indexOf('\\n');",
            "    if (newline < 0) return;",
            "    const request = JSON.parse(buffer.slice(0, newline));",
            "    if (request.method === 'initialize') {",
            "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: 'shim-test', version: receivedArgs } } }) + '\\n');",
            "    }",
            "});"
        ].join('\n');

        try {
            await writeFile(serverPath, serverScript, 'utf8');
            await writeFile(shimPath, '@echo off\r\nnode "%~dp0server.js" %*\r\n', 'utf8');
            await writeFile(specPath, JSON.stringify({ command: 'example-mcp', args: shimArgs }), 'utf8');

            const proxyCommand = getHappyCliCommand(['mcp-proxy', '--spec', specPath]);
            const child = spawn(proxyCommand.command, proxyCommand.args, {
                env: { ...process.env, PATH: `${directory};${originalPath}` },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
                let output = '';
                const timeout = setTimeout(() => {
                    child.kill();
                    reject(new Error('Timed out waiting for the Windows MCP shim response'));
                }, 5_000);
                const finish = (error: Error | null, value?: Record<string, unknown>) => {
                    clearTimeout(timeout);
                    if (error) {
                        reject(error);
                    } else if (value) {
                        resolve(value);
                    }
                };
                child.once('error', (error) => finish(error));
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk) => {
                    output += chunk;
                    const newline = output.indexOf('\n');
                    if (newline < 0) return;
                    try {
                        finish(null, JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                    child.kill();
                });
                child.stderr.resume();
                child.stdin.write(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-06-18' }
                }) + '\n');
            });

            expect(response).toMatchObject({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    serverInfo: { name: 'shim-test', version: JSON.stringify(shimArgs) }
                }
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
