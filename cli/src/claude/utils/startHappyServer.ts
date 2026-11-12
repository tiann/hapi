/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { PeerDeliveryModeSchema, type PeerDeliveryMode } from '@/modules/pingPeer/deliveryMode';
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import {
    detectDisplayMediaMimeType,
    detectImageMimeType,
    detectVideoMimeType,
    readBoundedRegularFile,
    registerGeneratedImage,
} from "@/modules/common/generatedImages";
import type { InlineMediaSource } from "@/modules/common/inlineMediaSource";
import { DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_MEDIA_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR } from "@/modules/common/displayImagePrompt";
import { resolveSkill } from "@/modules/common/skills";
import { SESSION_NAME_MAX_LENGTH, toSessionSummaryMetadata } from '@hapi/protocol'
import { isPeerToolsDisabled } from "@/modules/common/peerTools";
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    LIST_PEERS_INCLUDE_INACTIVE_PARAM_DESCRIPTION,
    LIST_PEERS_TOOL_DESCRIPTION,
    PEER_DELIVERY_MODE_DESCRIPTION,
    PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION,
    PEER_WAKE_PARAM_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    SESSION_ID_PREFIX_PARAM_DESCRIPTION,
    SPAWN_PEER_TOOL_DESCRIPTION,
} from '@hapi/protocol/sessionCitation'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { PingPeerError, formatInspectPeerReport, formatPeerSessionsList, forwardPeerReply, inspectPeer, listPeerSessions, peerListFetchLimit, pingPeer, supportsPeerReply } from "@/modules/pingPeer/pingPeer";
import { applySessionDisplayRename, normalizeSessionDisplayTitle } from "@/agent/sessionDisplayRename";
import {
    SESSION_JOB_TOOL_DESCRIPTION,
    SESSION_JOB_TOOL_NAME,
    handleSessionJobTool,
    sessionJobInputSchema,
    type SessionJobToolArgs,
} from "@/modules/sessionJob/sessionJobMcp";
import { SpawnPeerError, spawnPeer } from "@/modules/spawnPeer/spawnPeer";

export type HapiMcpToolName =
    | 'change_title'
    | 'display_image'
    | 'display_video'
    | 'display_media'
    | 'list_peers'
    | 'ping_peer'
    | 'inspect_peer'
    | 'spawn_peer'
    | 'session_job'
    | 'skill_lookup';

type StartHappyServerOptions = {
    /**
     * When true (default), change_title writes metadata.name (web rename
     * semantics). Set false for Codex collab so child agents do not rename
     * the parent HAPI session; the parent launcher applies the title later.
     */
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    onChangeTitle?: (title: string) => void;
    /**
     * Session project cwd for resolving relative `spawn_peer` directories.
     * Prefer the launcher's effective cwd (including Codex `--cd` overrides).
     * Falls back to `skillLookup.workingDirectory`, then hub metadata.path.
     */
    workingDirectory?: string;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
    /**
     * Restrict the server to an explicit subset of HAPI tools. Omit to keep
     * the historical behavior where launchers choose through the other flags.
     */
    enabledTools?: readonly HapiMcpToolName[];
};

/**
 * Resolve the base cwd for MCP spawn_peer relative directories.
 * Prefer launcher workingDirectory (Codex --cd), then skillLookup, then
 * session metadata.path so bridges without skillLookup still anchor to the
 * session tree instead of the long-lived HAPI process cwd.
 */
export function resolveMcpSpawnPeerCwd(options: {
    workingDirectory?: string | null
    skillWorkingDirectory?: string | null
    sessionPath?: string | null
}): string | undefined {
    const fromLauncher = (options.workingDirectory ?? '').trim()
    if (fromLauncher) return fromLauncher
    const fromSkill = (options.skillWorkingDirectory ?? '').trim()
    if (fromSkill) return fromSkill
    const fromSession = (options.sessionPath ?? '').trim()
    return fromSession || undefined
}

/** Registered on the MCP server, but never pre-approved via Claude --allowedTools. */
const CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS = new Set([
    'display_media',
    'display_video',
    'ping_peer',
    'inspect_peer',
    'spawn_peer'
]);

/**
 * Map HAPI MCP tool names to Claude `--allowedTools` entries.
 * Keeps `display_media` / `display_video` (arbitrary local-path readers), `ping_peer`,
 * `inspect_peer`, and `spawn_peer` off the auto-allow list so they still prompt.
 * `list_peers` stays allowed (discovery shortlist only).
 */
export function toClaudeAllowedHapiMcpTools(toolNames: string[]): string[] {
    return toolNames
        .filter((toolName) => !CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS.has(toolName))
        .map((toolName) => `mcp__hapi__${toolName}`);
}

function createHapiMcpServer(
    client: ApiSessionClient,
    emitTitleSummary: boolean,
    enableChangeTitle: boolean,
    skillLookup: StartHappyServerOptions['skillLookup'],
    workingDirectory: string | undefined,
    enabledTools: ReadonlySet<HapiMcpToolName>,
    onChangeTitle?: StartHappyServerOptions['onChangeTitle']
): McpServer {
    const registerTool = (name: HapiMcpToolName, config: any, handler: any): void => {
        if (enabledTools.has(name)) {
            mcp.registerTool<any, any>(name, config, handler);
        }
    };
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            if (!normalizeSessionDisplayTitle(title)) return { success: false, error: 'Title must not be empty' };
            if (!await client.refreshMetadata()) {
                return { success: false, error: 'Could not read the current title lock from the Hub.' };
            }
            if (client.getMetadata()?.titleLocked) {
                return { success: false, error: 'Session title is locked by the user. Only the user can unlock it.' };
            }
            if (!emitTitleSummary) {
                // Codex collab: acknowledge the tool call without writing.
                // Parent-thread mcp_tool_call_end applies the rename later.
                return { success: true };
            }
            if (!applySessionDisplayRename(client, title)) {
                return { success: false, error: 'Title must not be empty' };
            }
            if (!await client.flushMetadata()) {
                return { success: false, error: 'Title update could not be confirmed by the Hub.' };
            }
            // The user may lock the title while this write is in flight.
            // The ACK carries the Hub's preserved title and lock.
            if (client.getMetadata()?.titleLocked) {
                return { success: false, error: 'Session title is locked by the user. Only the user can unlock it.' };
            }
            if (onChangeTitle) {
                onChangeTitle(normalizeSessionDisplayTitle(title)!);
                if (!await client.flushMetadata()) {
                    return { success: false, error: 'Title update could not be confirmed by the Hub.' };
                }
                if (client.getMetadata()?.titleLocked) {
                    return { success: false, error: 'Session title is locked by the user. Only the user can unlock it.' };
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const mcp = new McpServer({
        name: "HAPI MCP",
        version: "1.0.0",
    });

    const changeTitleInputSchema: z.ZodTypeAny = z.object({
        title: z.string().describe('The new title for the chat session'),
    });

    const displayImageInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Absolute filesystem path of the local image to display to the human user. This file is sent for user display, not provided to the model for image inspection'),
        title: z.string().optional().describe('Optional display title or filename shown to the human user'),
    });

    const skillLookupInputSchema: z.ZodTypeAny = z.object({
        name: z.string().trim().min(1).max(128).describe('Exact skill name shown by HAPI skill autocomplete'),
    });

    const displayVideoInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the video to display inline (mp4 or webm)'),
        title: z.string().optional().describe('Optional display title or filename for the video'),
    });

    const displayMediaInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the media or file to send to the user'),
        title: z.string().trim().min(1).max(255).optional().describe('Optional display title or filename'),
    });

    /** Start reply forwarding when asked; returns the note for the tool result. */
    const forwardReplyIfRequested = (
        waitForReply: boolean | undefined,
        task: { sessionId: string; localId?: string; flavor?: string | null }
    ): string => {
        if (!waitForReply) return '';
        if (!task.localId) return '; the delivered message could not be identified, so check the reply with inspect_peer';
        if (!supportsPeerReply(task.flavor)) return `; ${task.flavor} peers do not report turn ends, so check the reply with inspect_peer`;
        forwardPeerReply({ peerSessionId: task.sessionId, taskLocalId: task.localId, callerSessionId: client.sessionId })
            .catch((error) => logger.debug('[hapiMCP] peer reply forwarding failed:', error));
        return '; its reply will be posted here';
    };

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
        message: z.string().min(1).describe('Message text to deliver to the target session'),
        deliveryMode: PeerDeliveryModeSchema.optional().describe(PEER_DELIVERY_MODE_DESCRIPTION),
        wake: z.boolean().optional().describe(PEER_WAKE_PARAM_DESCRIPTION),
        waitForReply: z.boolean().optional().describe(PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION),
    });

    const spawnPeerInputSchema: z.ZodTypeAny = z.object({
        directory: z.string().trim().min(1)
            .describe('Working directory for the new session on the target machine (must exist there)'),
        message: z.string().min(1).describe('Required first user message (the remit). Empty spawn is a failed spawn.'),
        name: z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH).optional().describe('Session display name'),
        machine: z.string().trim().min(1).optional()
            .describe(
                'Optional target runner: hub machine UUID or hostname (metadata.host / displayName from GET /api/machines). '
                + 'Omit to spawn on this host.'
            ),
        agent: z.enum(CREATABLE_AGENT_FLAVORS as unknown as [string, ...string[]]).optional()
            .describe('Agent flavor override. When omitted, uses hub peerSpawnDefaults then stock claude.'),
        model: z.string().trim().min(1).optional()
            .describe('Model override for the resolved agent flavor.'),
        effort: z.string().trim().min(1).optional()
            .describe('Effort override (flavor-dependent).'),
        sessionType: z.enum(['simple', 'worktree']).optional()
            .describe('simple or worktree. Default simple (use directory as cwd). worktree creates a new tree from directory.'),
        permissionMode: PermissionModeSchema.optional()
            .describe(
                'Permission mode for the new session. Omit to use hub/stock default (yolo). '
                + 'Pass only to tighten or when the operator names a mode — do not clone the parent session.'
            ),
        waitForReply: z.boolean().optional().describe(PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION),
    });

    const maxInlineMediaBytes = 25 * 1024 * 1024;

    // HAPI_DISABLE_PEER_TOOLS=1: peer tools are neither registered nor
    // advertised, so wrapped agents cannot browse or message other sessions.
    const peerToolsDisabled = isPeerToolsDisabled();

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
        messageLimit: z.number().int().min(1).max(100).optional().describe(
            'Recent message page size (default 30, max 100). Text snippets only.'
        ),
    });

    const listPeersInputSchema: z.ZodTypeAny = z.object({
        limit: z.number().int().min(1).max(100).optional().describe(
            'Max sessions to return (default 30, max 100). Newest updatedAt first.'
        ),
        includeInactive: z.boolean().optional().describe(LIST_PEERS_INCLUDE_INACTIVE_PARAM_DESCRIPTION),
    });

    async function displayInlineMedia(
        args: { path: string; title?: string },
        mediaKind: 'image' | 'video' | 'media',
        toolName: 'display_image' | 'display_video' | 'display_media'
    ) {
        const bytes = await readBoundedRegularFile(args.path, maxInlineMediaBytes);
        const mimeType = mediaKind === 'video'
            ? detectVideoMimeType(bytes)
            : mediaKind === 'image'
                ? detectImageMimeType(bytes)
                : detectDisplayMediaMimeType(bytes);
        if (!mimeType) {
            throw new Error(mediaKind === 'video' ? 'Unsupported video content' : 'Unsupported image content');
        }

        const media = registerGeneratedImage({
            id: randomUUID(),
            path: args.path,
            fileName: args.title,
            mimeType,
            bytes
        });

        const source: InlineMediaSource = {
            ingress: 'mcp',
            toolName,
        };

        client.sendAgentMessage({
            type: 'generated-image',
            imageId: media.id,
            fileName: media.fileName,
            mimeType: media.mimeType,
            id: randomUUID(),
            source,
        });

        return media;
    }
    if (enableChangeTitle) {
        registerTool('change_title', {
            description: 'Change the title of the current HAPI chat session. Call once when the user\'s primary objective is clear; use a concise task title.',
            title: 'Change Chat Title',
            inputSchema: changeTitleInputSchema,
        }, async (args: { title: string }) => {
            const response = await handler(args.title);
            logger.debug('[hapiMCP] Response:', response);
            const displayTitle = normalizeSessionDisplayTitle(args.title) ?? args.title;

            if (response.success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Successfully changed chat title to: "${displayTitle}"`,
                        },
                    ],
                    isError: false,
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        });
    }

    registerTool('display_image', {
        description: 'Display a local image file to the human user inline in the current HAPI chat session. Call with the absolute filesystem path so HAPI can show it inline. This tool sends the image to the human user for inline display in HAPI; it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.',
        title: 'Display Image',
        inputSchema: displayImageInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display image:', args.path);

        try {
            const image = await displayInlineMedia(args, 'image', 'display_image');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Displayed image: ${image.fileName}`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            client.markAttachmentDenied(args.path);
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display image:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to display image: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    registerTool('display_video', {
        description: `Display a local mp4 or webm file inline in the current HAPI chat session. ${DISPLAY_VIDEO_PROMPT_CURSOR}`,
        title: 'Display Video',
        inputSchema: displayVideoInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display video:', args.path);

        try {
            const video = await displayInlineMedia(args, 'video', 'display_video');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Displayed video: ${video.fileName}`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            client.markAttachmentDenied(args.path);
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display video:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to display video: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    registerTool('display_media', {
        description: `Send a local image, video, audio, or other file to the current HAPI chat session. Recognized media is shown inline; other files use a download card. ${DISPLAY_MEDIA_PROMPT_CURSOR}`,
        title: 'Display Media',
        inputSchema: displayMediaInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display media:', args.path);

        try {
            const media = await displayInlineMedia(args, 'media', 'display_media');
            return {
                content: [{ type: 'text' as const, text: `Displayed media: ${media.fileName}` }],
                isError: false,
            };
        } catch (error) {
            client.markAttachmentDenied(args.path);
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display media:', message);
            return {
                content: [{ type: 'text' as const, text: `Failed to display media: ${message}` }],
                isError: true,
            };
        }
    });

    registerTool(SESSION_JOB_TOOL_NAME, {
        description: SESSION_JOB_TOOL_DESCRIPTION,
        title: 'Session-Attached Job',
        inputSchema: sessionJobInputSchema,
    }, async (args: SessionJobToolArgs) => {
        logger.debug('[hapiMCP] session_job:', args.action, args.jobKey);
        const result = await handleSessionJobTool(args, client.sessionId);
        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: result.isError,
        };
    });

    if (!peerToolsDisabled) {
        registerTool('ping_peer', {
            description: PING_PEER_TOOL_DESCRIPTION,
            title: 'Ping Peer Session',
            inputSchema: pingPeerInputSchema,
        }, async (args: { sessionIdPrefix: string; message: string; deliveryMode?: PeerDeliveryMode; wake?: boolean; waitForReply?: boolean }) => {
            logger.debug('[hapiMCP] ping_peer:', args.sessionIdPrefix);
            try {
                const result = await pingPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    message: args.message,
                    deliveryMode: args.deliveryMode,
                    wake: args.wake === true,
                });
                const replyNote = forwardReplyIfRequested(args.waitForReply, result);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: result.delivery === 'accepted'
                                ? `Accepted for ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name}) localId=${result.localId} — delivery shows in the recipient chat when its runtime consumes it${result.steerNote ? ` (${result.steerNote})` : ''}${replyNote}`
                                : `${result.delivery} to ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name}) localId=${result.localId}${replyNote}`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] ping_peer failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to ping peer: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });

        registerTool('spawn_peer', {
            description: SPAWN_PEER_TOOL_DESCRIPTION,
            title: 'Spawn Peer Session',
            inputSchema: spawnPeerInputSchema,
        }, async (args: {
            directory: string
            message: string
            name?: string
            machine?: string
            agent?: string
            model?: string
            effort?: string
            sessionType?: 'simple' | 'worktree'
            permissionMode?: string
            waitForReply?: boolean
        }) => {
            logger.debug('[hapiMCP] spawn_peer:', args.directory, args.machine ? `machine=${args.machine}` : '');
            try {
                const metadata = client.getMetadata()
                const summaryMeta = toSessionSummaryMetadata(metadata)
                const result = await spawnPeer({
                    directory: args.directory,
                    cwd: resolveMcpSpawnPeerCwd({
                        workingDirectory,
                        skillWorkingDirectory: skillLookup?.workingDirectory,
                        sessionPath: metadata?.path,
                    }),
                    message: args.message,
                    name: args.name,
                    machine: args.machine,
                    agent: args.agent as Parameters<typeof spawnPeer>[0]['agent'],
                    model: args.model,
                    effort: args.effort,
                    sessionType: args.sessionType,
                    permissionMode: args.permissionMode as Parameters<typeof spawnPeer>[0]['permissionMode'],
                    parent: {
                        sessionId: client.sessionId,
                        name: metadata?.name ?? null,
                        agentSessionId: summaryMeta?.agentSessionId ?? null,
                    },
                    requireParent: true,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Spawned ${result.sessionId} (${result.name})${forwardReplyIfRequested(args.waitForReply, result)}`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof SpawnPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] spawn_peer failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to spawn peer: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });

        registerTool('inspect_peer', {
            description: INSPECT_PEER_TOOL_DESCRIPTION,
            title: 'Inspect Peer Session',
            inputSchema: inspectPeerInputSchema,
        }, async (args: { sessionIdPrefix: string; messageLimit?: number }) => {
            logger.debug('[hapiMCP] inspect_peer:', args.sessionIdPrefix);
            try {
                const result = await inspectPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    messageLimit: args.messageLimit,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatInspectPeerReport(result),
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] inspect_peer failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to inspect peer: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });

        registerTool('list_peers', {
            description: LIST_PEERS_TOOL_DESCRIPTION,
            title: 'List Peer Sessions',
            inputSchema: listPeersInputSchema,
        }, async (args: { limit?: number; includeInactive?: boolean }) => {
            logger.debug('[hapiMCP] list_peers');
            try {
                const limit = args.limit ?? 30;
                const includeInactive = args.includeInactive === true;
                const sessions = await listPeerSessions({
                    limit: peerListFetchLimit(limit, { excludeCaller: true }),
                    includeInactive,
                });
                const peerCount = sessions.filter((session) => session.id !== client.sessionId).length;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatPeerSessionsList(sessions, {
                                maxRows: limit,
                                hasMore: peerCount > limit,
                                excludeSessionId: client.sessionId,
                                includeInactive,
                            }),
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof PingPeerError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                logger.debug('[hapiMCP] list_peers failed:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to list peers: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }


    if (skillLookup) {
        registerTool('skill_lookup', {
            description: 'Load a HAPI skill by exact name. When a user message starts with $name, call this tool with that name before acting.',
            title: 'Look Up Skill',
            inputSchema: skillLookupInputSchema,
        }, async (args: { name: string }) => {
            logger.debug('[hapiMCP] Looking up skill:', args.name);
            try {
                const skill = await resolveSkill(args.name, skillLookup.workingDirectory, {
                    flavor: skillLookup.flavor
                });
                if (!skill) {
                    throw new Error(`Skill not found: ${args.name}`);
                }

                const header = [
                    `Skill: ${skill.name}`,
                    ...(skill.description ? [`Description: ${skill.description}`] : [])
                ].join('\n');
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `${header}\n\n${skill.body}`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug('[hapiMCP] Failed to look up skill:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to look up skill: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }

    return mcp;
}

function readMcpSessionId(req: IncomingMessage): string | undefined {
    const raw = req.headers['mcp-session-id'];
    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw[0];
    }
    return undefined;
}

export async function startHappyServer(client: ApiSessionClient, options: StartHappyServerOptions = {}) {
    const emitTitleSummary = options.emitTitleSummary ?? true;
    const enableChangeTitle = options.enableChangeTitle ?? true;
    const requestedTools = options.enabledTools ? new Set(options.enabledTools) : null;
    const includeTool = (name: HapiMcpToolName): boolean =>
        requestedTools === null || requestedTools.has(name);
    const peerToolsDisabled = isPeerToolsDisabled();
    const toolNames: HapiMcpToolName[] = [];
    if (enableChangeTitle && includeTool('change_title')) toolNames.push('change_title');
    for (const name of ['display_image', 'display_video', 'display_media'] as const) {
        if (includeTool(name)) toolNames.push(name);
    }
    if (!peerToolsDisabled) {
        for (const name of ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'] as const) {
            if (includeTool(name)) toolNames.push(name);
        }
    }
    if (includeTool(SESSION_JOB_TOOL_NAME)) toolNames.push(SESSION_JOB_TOOL_NAME);
    if (options.skillLookup && includeTool('skill_lookup')) toolNames.push('skill_lookup');
    if (toolNames.length === 0) {
        throw new Error('startHappyServer requires at least one enabled tool');
    }
    const enabledTools = new Set(toolNames);

    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcps = new Map<string, McpServer>();

    const createMcpTransport = () => {
        const mcp = createHapiMcpServer(
            client,
            emitTitleSummary,
            enableChangeTitle,
            options.skillLookup,
            options.workingDirectory,
            enabledTools,
            options.onChangeTitle
        );
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                transports.set(sessionId, transport);
                mcps.set(sessionId, mcp);
            },
            onsessionclosed: (sessionId) => {
                transports.delete(sessionId);
                const server = mcps.get(sessionId);
                mcps.delete(sessionId);
                void server?.close();
            },
        });
        void mcp.connect(transport);
        return transport;
    };

    const server = createServer(async (req, res) => {
        try {
            const sessionId = readMcpSessionId(req);
            const transport = sessionId
                ? transports.get(sessionId)
                : createMcpTransport();

            if (!transport) {
                if (!res.headersSent) {
                    res.writeHead(404).end();
                }
                return;
            }

            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    const mcpUrl = baseUrl.toString();
    client.updateMetadata((metadata) => ({
        ...metadata,
        hapiMcpUrl: mcpUrl,
    }));

    return {
        url: mcpUrl,
        toolNames,
        stop: () => {
            logger.debug('[hapiMCP] Stopping server');
            for (const mcp of mcps.values()) {
                mcp.close();
            }
            transports.clear();
            mcps.clear();
            server.close();
        }
    };
}
