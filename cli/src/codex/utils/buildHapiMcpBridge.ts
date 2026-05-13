/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { spawnSync } from 'node:child_process';
import type { ApiSessionClient } from '@/api/apiSession';

/**
 * MCP server entry configuration.
 */
export interface McpServerEntry {
    command: string;
    args: string[];
}

/**
 * Map of MCP server names to their configurations.
 */
export type McpServersConfig = Record<string, McpServerEntry>;

/**
 * Result of starting the hapi MCP bridge.
 */
export interface HapiMcpBridge {
    /** The running server instance */
    server: {
        url: string;
        stop: () => void;
    };
    /** MCP server config to pass to Codex (works for both CLI and SDK) */
    mcpServers: McpServersConfig;
}

export interface HapiMcpBridgeOptions {
    emitTitleSummary?: boolean;
}

// Codex app-server 0.130 can close a Bun-backed MCP stdio server while
// processing the initialize response. Keep a tiny Node stdio shim in front of
// the real hapi MCP bridge so Codex talks to a stable Node process. This is
// intentionally inline instead of a sidecar file so compiled/release HAPI can
// spawn it without needing extra packaged assets.
const HAPI_MCP_STDIO_PROXY_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const [command, ...args] = process.argv.slice(1);
if (!command) {
  process.stderr.write('[hapi-mcp-proxy] Missing child command\n');
  process.exit(2);
}
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: process.platform === 'win32'
});
let exiting = false;
function safeEnd(stream) { try { stream.end(); } catch {} }
function safeKill() {
  if (child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch {}
}
process.stdin.on('data', (chunk) => {
  if (!child.stdin.destroyed) child.stdin.write(chunk);
});
process.stdin.on('end', () => safeEnd(child.stdin));
process.stdin.on('error', () => safeEnd(child.stdin));
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => {
  process.stderr.write('[hapi-mcp-proxy] Failed to start child: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  if (!exiting) { exiting = true; process.exit(1); }
});
child.on('exit', (code, signal) => {
  if (exiting) return;
  exiting = true;
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 0);
});
process.on('SIGTERM', () => { safeKill(); process.exit(143); });
process.on('SIGINT', () => { safeKill(); process.exit(130); });
process.on('exit', safeKill);
`;

function resolveNodeExecutable(): string | null {
    const override = process.env.HAPI_NODE_EXECUTABLE?.trim();
    if (override) {
        return override;
    }

    const result = spawnSync('node', ['--version'], { stdio: 'ignore' });
    return result.status === 0 ? 'node' : null;
}

/**
 * Start the hapi MCP bridge server and return the configuration
 * needed to connect Codex to it.
 *
 * This is the single source of truth for MCP bridge setup,
 * used by both local and remote launchers.
 */
export async function buildHapiMcpBridge(
    client: ApiSessionClient,
    options: HapiMcpBridgeOptions = {}
): Promise<HapiMcpBridge> {
    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary
    });
    const bridgeCommand = getHappyCliCommand(['mcp', '--url', happyServer.url]);
    const nodeCommand = resolveNodeExecutable();
    const hapiMcpServer = nodeCommand
        ? {
            command: nodeCommand,
            args: ['-e', HAPI_MCP_STDIO_PROXY_SCRIPT, bridgeCommand.command, ...bridgeCommand.args]
        }
        : bridgeCommand;

    return {
        server: {
            url: happyServer.url,
            stop: happyServer.stop
        },
        mcpServers: {
            hapi: hapiMcpServer
        }
    };
}
