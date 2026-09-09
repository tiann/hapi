/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
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
import { resolveSkill } from "@/modules/common/skills";
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    SESSION_ID_PARAM_DESCRIPTION,
    SPAWN_PEER_TOOL_DESCRIPTION,
} from '@hapi/protocol/sessionCitation'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { PingPeerError, formatInspectPeerReport, inspectPeer, pingPeer } from "@/modules/pingPeer/pingPeer";
import { SpawnPeerError, spawnPeer } from "@/modules/spawnPeer/spawnPeer";
import {
    HAPI_SESSION_CONTROL_SKILL_DESCRIPTION,
    HAPI_SESSION_CONTROL_SKILL_NAME,
} from '@/modules/common/hapiSessionControlSkill';

type StartHappyServerOptions = {
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
};

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
    skillLookup: StartHappyServerOptions['skillLookup']
): McpServer {
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            if (emitTitleSummary) {
                client.sendClaudeSessionMessage({
                    type: 'summary',
                    summary: title,
                    leafUuid: randomUUID()
                });
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
        name: z.string().trim().min(1).max(128).describe('Exact skill name from the catalog'),
    });

    const displayVideoInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the video to display inline (mp4 or webm)'),
        title: z.string().optional().describe('Optional display title or filename for the video'),
    });

    const displayMediaInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the media or file to send to the user'),
        title: z.string().trim().min(1).max(255).optional().describe('Optional display title or filename'),
    });

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().uuid().describe(SESSION_ID_PARAM_DESCRIPTION),
        message: z.string().min(1).describe('Message text to deliver to the target session'),
        remitId: z.string().uuid().optional().describe('Stable idempotency key for retries'),
    });

    const spawnPeerInputSchema: z.ZodTypeAny = z.object({
        directory: z.string().trim().min(1).describe('Working directory for the new session'),
        message: z.string().min(1).describe('Required first user message'),
        name: z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH).optional().describe('Session display name'),
        machineId: z.string().trim().min(1).optional().describe('Exact runner machine id'),
        agent: z.enum(CREATABLE_AGENT_FLAVORS as unknown as [string, ...string[]]).optional()
            .describe('Agent flavor; defaults to claude'),
        model: z.string().trim().min(1).optional().describe('Runtime model id'),
        effort: z.string().trim().min(1).optional().describe('Runtime reasoning effort'),
        sessionType: z.enum(['simple', 'worktree']).optional()
            .describe('Session directory mode'),
        permissionMode: PermissionModeSchema.optional()
            .describe('Permission mode for the new session.'),
        remitId: z.string().uuid().optional().describe('Stable idempotency key for retries'),
    });

    const maxInlineMediaBytes = 25 * 1024 * 1024;

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().uuid().describe(SESSION_ID_PARAM_DESCRIPTION),
        messageLimit: z.number().int().min(1).max(100).optional().describe(
            'Recent message page size (default 30, max 100). Text snippets only.'
        ),
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
        mcp.registerTool<any, any>('change_title', {
            description: 'Change the title of the current HAPI chat session.',
            title: 'Change Chat Title',
            inputSchema: changeTitleInputSchema,
        }, async (args: { title: string }) => {
            const response = await handler(args.title);
            logger.debug('[hapiMCP] Response:', response);

            if (response.success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Successfully changed chat title to: "${args.title}"`,
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

    mcp.registerTool<any, any>('display_image', {
        description: 'Display a local image to the human user; this does not provide image input to the model and cannot inspect the image.',
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

    mcp.registerTool<any, any>('display_video', {
        description: 'Display a local mp4 or webm file in the current HAPI chat.',
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

    mcp.registerTool<any, any>('display_media', {
        description: 'Send a local file to the current HAPI chat.',
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
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display media:', message);
            return {
                content: [{ type: 'text' as const, text: `Failed to display media: ${message}` }],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('ping_peer', {
        description: PING_PEER_TOOL_DESCRIPTION,
        title: 'Ping Peer Session',
        inputSchema: pingPeerInputSchema,
    }, async (args: { sessionId: string; message: string; remitId?: string }) => {
        logger.debug('[hapiMCP] ping_peer:', args.sessionId);
        try {
            const result = await pingPeer({
                sessionId: args.sessionId,
                message: args.message,
                remitId: args.remitId,
            });
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Delivered to ${result.sessionId} remit=${result.remitId}${result.resumed ? ' (resumed)' : ''} (${result.name})`,
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
                        text: error instanceof PingPeerError
                            && error.remitId
                            && error.code !== 'remit_conflict'
                            ? `Failed to ping peer: ${message}; retry ping_peer with remitId=${error.remitId}`
                            : `Failed to ping peer: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('spawn_peer', {
        description: SPAWN_PEER_TOOL_DESCRIPTION,
        title: 'Spawn Peer Session',
        inputSchema: spawnPeerInputSchema,
    }, async (args: {
        directory: string
        message: string
        name?: string
        machineId?: string
        agent?: string
        model?: string
        effort?: string
        sessionType?: 'simple' | 'worktree'
        permissionMode?: string
        remitId?: string
    }) => {
        logger.debug('[hapiMCP] spawn_peer:', args.directory);
        try {
            const result = await spawnPeer({
                directory: args.directory,
                message: args.message,
                name: args.name,
                machineId: args.machineId,
                agent: args.agent as Parameters<typeof spawnPeer>[0]['agent'],
                model: args.model,
                effort: args.effort,
                sessionType: args.sessionType,
                permissionMode: args.permissionMode as Parameters<typeof spawnPeer>[0]['permissionMode'],
                remitId: args.remitId,
            });
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Spawned ${result.sessionId} remit=${result.remitId} (${result.name})`,
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
                        text: error instanceof SpawnPeerError && error.remitId
                            ? `Failed to spawn peer: ${message}; retry spawn_peer with remitId=${error.remitId}`
                            : `Failed to spawn peer: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('inspect_peer', {
        description: INSPECT_PEER_TOOL_DESCRIPTION,
        title: 'Inspect Peer Session',
        inputSchema: inspectPeerInputSchema,
    }, async (args: { sessionId: string; messageLimit?: number }) => {
        logger.debug('[hapiMCP] inspect_peer:', args.sessionId);
        try {
            const result = await inspectPeer({
                sessionId: args.sessionId,
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

    if (skillLookup) {
        mcp.registerTool<any, any>('skill_lookup', {
            description: `Load one skill body by exact name. Catalog: ${HAPI_SESSION_CONTROL_SKILL_NAME} — ${HAPI_SESSION_CONTROL_SKILL_DESCRIPTION}`,
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
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcps = new Map<string, McpServer>();

    const createMcpTransport = () => {
        const mcp = createHapiMcpServer(client, emitTitleSummary, enableChangeTitle, options.skillLookup);
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

    const toolNames = enableChangeTitle
        ? ['change_title', 'display_image', 'display_video', 'display_media', 'ping_peer', 'inspect_peer', 'spawn_peer']
        : ['display_image', 'display_video', 'display_media', 'ping_peer', 'inspect_peer', 'spawn_peer'];
    if (options.skillLookup) {
        toolNames.push('skill_lookup');
    }

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
