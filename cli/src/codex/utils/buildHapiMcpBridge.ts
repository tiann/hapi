/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import type { ApiSessionClient } from '@/api/apiSession';
import { exportHapiSessionEnv } from '@/agent/hapiSessionEnv';
import type { CodexMcpServerConfig } from './codexMcpServers';

/**
 * MCP server entry configuration.
 */
export type McpToolApprovalMode = 'auto' | 'prompt' | 'approve';

export interface McpServerToolConfig {
    approval_mode?: McpToolApprovalMode;
}

export interface McpServerEntry extends CodexMcpServerConfig {
    command: string;
    args: string[];
    tools?: Record<string, McpServerToolConfig>;
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
    exportSessionEnv?: boolean;
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
}

/**
 * Start the hapi MCP bridge server and return the configuration
 * needed to connect Codex to it.
 *
 * This is the single source of truth for MCP bridge setup,
 * used by both local and remote launchers.
 *
 * Lazy Codex sessions stay pending until first materialization. We materialize
 * here (before startHappyServer / agent spawn) so:
 * - the hub row exists for REST self-targeting via HAPI_SESSION_ID
 * - hapiMcpUrl from startHappyServer is persisted to the hub, not only local pending state
 */
export async function buildHapiMcpBridge(
    client: ApiSessionClient,
    options: HapiMcpBridgeOptions = {}
): Promise<HapiMcpBridge> {
    if (client.isPending()) {
        const materialized = await client.materialize();
        if (!materialized) {
            throw new Error(`Failed to materialize HAPI session ${client.sessionId} before MCP bridge start`);
        }
    }
    // Belt-and-suspenders: onMaterialized already exports; keep env set for non-lazy too.
    if (options.exportSessionEnv !== false) exportHapiSessionEnv(client.sessionId);

    // This bridge is shared by every non-Codex-"local"/"shared" launcher too
    // (Cursor ACP, Copilot, Grok, Kimi, OpenCode) — each already threads its
    // real flavor through `skillLookup.flavor`. Only fall back to 'codex'
    // for the two Codex call sites that pass no skillLookup at all
    // (codexLocalLauncher.ts, codexRemoteLauncher.ts's app-server path).
    const flavor = options.skillLookup?.flavor ?? 'codex';
    // Every caller of this function proxies the model through the stdio bridge
    // spawned below, not this HTTP server directly, so `flavor` here is NOT
    // what fixes those callers' display_* wording (that's the `--flavor` CLI
    // arg a few lines down, read by happyMcpStdioBridge.ts). This keeps the
    // HTTP server's own tools/list internally correct for `flavor` too, in
    // case anything ever connects to `happyServer.url` directly — do not
    // assume removing the `--flavor` arg below is safe just because this
    // option exists.
    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary,
        enableChangeTitle: options.enableChangeTitle,
        flavor,
        skillLookup: options.skillLookup
    });
    // Stamp the hub row id so orphanReap can find MCP helpers after the agent
    // root dies without a full tree kill (#2003 / #1911 follow-up).
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(','),
        '--flavor',
        flavor,
        '--hapi-session-id',
        client.sessionId,
    ]);
    const tools: Record<string, McpServerToolConfig> = {
        display_image: {
            approval_mode: 'prompt'
        },
        display_video: {
            approval_mode: 'prompt'
        },
        display_media: {
            approval_mode: 'prompt'
        }
    };
    if (options.enableChangeTitle !== false) {
        tools.change_title = {
            approval_mode: 'approve'
        };
    }
    // Discovery shortlist only - same trust as skill_lookup / change_title.
    tools.list_peers = {
        approval_mode: 'approve'
    };
    // ping_peer / inspect_peer are registered on the HTTP MCP server / stdio
    // bridge, but are not auto-approved: they target another session (resume +
    // inject, or read peer histories).
    if (options.skillLookup) {
        tools.skill_lookup = {
            approval_mode: 'approve'
        };
    }

    return {
        server: {
            url: happyServer.url,
            stop: happyServer.stop
        },
        mcpServers: {
            hapi: {
                command: bridgeCommand.command,
                args: bridgeCommand.args,
                tools
            }
        }
    };
}
