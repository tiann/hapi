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

/**
 * MCP server entry configuration.
 */
export type McpToolApprovalMode = 'auto' | 'prompt' | 'approve';

export interface McpServerToolConfig {
    approval_mode?: McpToolApprovalMode;
}

export interface McpServerEntry {
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
    exportHapiSessionEnv(client.sessionId);

    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary,
        enableChangeTitle: options.enableChangeTitle,
        skillLookup: options.skillLookup
    });
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(',')
    ]);
    const tools: Record<string, McpServerToolConfig> = {
        display_image: {
            approval_mode: 'prompt'
        },
        display_video: {
            approval_mode: 'prompt'
        }
    };
    if (options.enableChangeTitle !== false) {
        tools.change_title = {
            approval_mode: 'approve'
        };
    }
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
