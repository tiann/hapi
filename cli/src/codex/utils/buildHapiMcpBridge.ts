/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import {
    startHappyServer,
    type HapiMcpToolRegistration
} from '@/claude/utils/startHappyServer';
import { HAPI_GOAL_MCP_TOOL_NAMES } from '@/claude/utils/hapiMcpTools';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
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

export interface BuildHapiMcpBridgeOptions {
    extraTools?: HapiMcpToolRegistration[];
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
    options: BuildHapiMcpBridgeOptions = {}
): Promise<HapiMcpBridge> {
    const happyServer = await startHappyServer(client, { extraTools: options.extraTools });
    const registeredToolNames = new Set((options.extraTools ?? []).map((tool) => tool.name));
    const includeGoalTools = HAPI_GOAL_MCP_TOOL_NAMES.every((toolName) => registeredToolNames.has(toolName));
    const bridgeArgs = ['mcp', '--url', happyServer.url];
    if (includeGoalTools) {
        bridgeArgs.push('--goal-tools');
    }
    const bridgeCommand = getHappyCliCommand(bridgeArgs);

    return {
        server: {
            url: happyServer.url,
            stop: happyServer.stop
        },
        mcpServers: {
            hapi: {
                command: bridgeCommand.command,
                args: bridgeCommand.args
            }
        }
    };
}
