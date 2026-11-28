/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import { startHappyServer, type HapiMcpToolName } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import type { ApiSessionClient } from '@/api/apiSession';
import { exportHapiSessionEnv } from '@/agent/hapiSessionEnv';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
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
    enableLinkPr?: boolean;
    onChangeTitle?: (title: string) => void;
    /** Session project cwd for relative spawn_peer directories (Codex --cd aware). */
    workingDirectory?: string;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
    /** Optional subset of HAPI MCP tools to register and expose to the agent. */
    enabledTools?: readonly HapiMcpToolName[];
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

    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary,
        enableChangeTitle: options.enableChangeTitle,
        enableLinkPr: options.enableLinkPr,
        onChangeTitle: options.onChangeTitle,
        workingDirectory: options.workingDirectory ?? options.skillLookup?.workingDirectory,
        skillLookup: options.skillLookup,
        ...(options.enabledTools ? { enabledTools: options.enabledTools } : {})
    });
    // Stamp the hub row id so orphanReap can find MCP helpers after the agent
    // root dies without a full tree kill (#2003 / #1911 follow-up).
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(','),
        '--hapi-session-id',
        client.sessionId,
    ]);
    const enabledTools = new Set<string>(happyServer.toolNames);
    const tools: Record<string, McpServerToolConfig> = {};
    for (const name of ['display_image', 'display_video', 'display_media'] as const) {
        if (enabledTools.has(name)) {
            tools[name] = {
                approval_mode: 'prompt'
            };
        }
    }
    if (options.enableChangeTitle !== false && enabledTools.has('change_title')) {
        tools.change_title = {
            approval_mode: 'approve'
        };
    }
    // Unlike change_title/list_peers/skill_lookup above, this must reach
    // HAPI's own permission handler on every call rather than being
    // pre-approved by Codex itself — link_pr mutates session metadata,
    // and BasePermissionHandler's resolveToolAutoApprovalDecision has a
    // dedicated guard that refuses to auto-approve it in read-only mode.
    // `approve` here would let Codex short-circuit the call before that
    // guard ever runs; `prompt` routes it through, where the handler
    // still auto-approves it in every other mode (bot review, hapi#2147).
    if (enabledTools.has('link_pr')) {
        tools.link_pr = {
            approval_mode: 'prompt'
        };
    }
    if (enabledTools.has('link_issue')) {
        // Same reasoning as link_pr above: link_issue mutates session
        // metadata too, and is unconditionally registered (no opt-in toggle)
        // — `approve` would let Codex short-circuit it before it ever
        // reaches HAPI's own permission handler (bot review, hapi#2147,
        // third follow-up on this same gap).
        tools.link_issue = {
            approval_mode: 'prompt'
        };
    }

    // Discovery shortlist only - same trust as skill_lookup / change_title.
    // Skipped under HAPI_DISABLE_PEER_TOOLS (tool is not registered then).
    if (!isPeerToolsDisabled() && enabledTools.has('list_peers')) {
        tools.list_peers = {
            approval_mode: 'approve'
        };
    }
    // Own-session progress meter (tiann/hapi#1404) — hub REST, not peer inject.
    if (enabledTools.has('session_job')) {
        tools.session_job = {
            approval_mode: 'approve'
        };
    }
    // Own-session external-wait latch (#2020 / #2616) — versioned metadata only.
    if (enabledTools.has('session_waiting')) {
        tools.session_waiting = {
            approval_mode: 'approve'
        };
    }
    // ping_peer / inspect_peer / spawn_peer are registered on the HTTP MCP
    // server / stdio bridge, but are not auto-approved: they target another
    // session (resume + inject, read peer histories, or create + inject).
    if (options.skillLookup && enabledTools.has('skill_lookup')) {
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
