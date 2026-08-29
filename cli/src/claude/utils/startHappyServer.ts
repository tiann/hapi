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
import { DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_LINKS_PROMPT_CURSOR, DISPLAY_MEDIA_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR } from "@/modules/common/displayImagePrompt";
import { buildDisplayLinksPayload, buildDisplayLinksToolName, parseDisplayLinksToolInput, assertBoundDisplayLinksSession } from "@hapi/protocol";
import { resolveSkill } from "@/modules/common/skills";
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    SESSION_ID_PREFIX_PARAM_DESCRIPTION,
} from '@hapi/protocol/sessionCitation'
import { PingPeerError, formatInspectPeerReport, formatPeerSessionsList, inspectPeer, listPeerSessions, peerListFetchLimit, pingPeer } from "@/modules/pingPeer/pingPeer";

type StartHappyServerOptions = {
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    /**
     * Cursor-only (#1516): doubled-letter URL recall is a Cursor-routed failure mode.
     * Defaults on when skillLookup.flavor === 'cursor'.
     */
    enableDisplayLinks?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
};

function resolveEnableDisplayLinks(options: StartHappyServerOptions): boolean {
    if (options.enableDisplayLinks !== undefined) {
        return options.enableDisplayLinks;
    }
    return options.skillLookup?.flavor === 'cursor';
}

/** Registered on the MCP server, but never pre-approved via Claude --allowedTools. */
const CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS = new Set([
    'display_media',
    'display_video',
    'ping_peer',
    'inspect_peer'
]);

/**
 * Map HAPI MCP tool names to Claude `--allowedTools` entries.
 * Keeps `display_media` / `display_video` (arbitrary local-path readers), `ping_peer`, and
 * `inspect_peer` off the auto-allow list so they still prompt.
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
    enableDisplayLinks: boolean
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

    const displayLinksInputSchema: z.ZodTypeAny = z.object({
        urls: z.array(z.union([
            z.object({
                href: z.string().describe('http(s) URL to paint. Construct by concatenation for landmine strings (tia+nn), never copy from model prose.'),
                title: z.string().trim().min(1).max(255).optional().describe('Optional link label shown on the card'),
            }),
            z.string(),
        ])).min(1).max(20).optional().describe('Optional http(s) URLs to paint as tappable cards'),
        texts: z.array(z.union([
            z.object({
                value: z.string().min(1).max(8192).describe('Exact string to paint for copy. Construct by concatenation (VK+K), never copy from model prose.'),
                title: z.string().trim().min(1).max(255).optional().describe('Optional label shown on the copy card'),
            }),
            z.string().min(1).max(8192),
        ])).min(1).max(20).optional().describe('Optional exact-copy strings (secrets, tokens, SHAs, tags, MagicDNS labels)'),
        sessionId: z.string().min(1).optional().describe('This chat\'s HAPI session id (required at runtime). Cursor routes duplicate MCP tool names to one server; a mismatch means the call landed on the wrong session MCP.'),
    });

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
        message: z.string().min(1).describe('Message text to deliver to the target session'),
    });

    const maxInlineMediaBytes = 25 * 1024 * 1024;

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
            description: 'Change the title of the current HAPI chat session. Call once when the user\'s primary objective is clear; use a concise task title.',
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
        description: `Display a local image file to the human user inline in the current HAPI chat session. ${DISPLAY_IMAGE_PROMPT_CURSOR}`,
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
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display media:', message);
            return {
                content: [{ type: 'text' as const, text: `Failed to display media: ${message}` }],
                isError: true,
            };
        }
    });

    if (enableDisplayLinks) {
        const displayLinksToolName = buildDisplayLinksToolName(client.sessionId);
        mcp.registerTool<any, any>(displayLinksToolName, {
            description: `Paint clickable http(s) URL cards and/or exact-copy strings into the current HAPI chat without a fake user turn. Cursor-only: other flavors type URLs and secrets fine. Per-session tool name (ends with _display_links) so concurrent hapi-* MCP overlays do not collide. ${DISPLAY_LINKS_PROMPT_CURSOR}`,
            title: 'Display Links',
            inputSchema: displayLinksInputSchema,
        }, async (args: {
            urls?: Array<{ href: string; title?: string } | string>
            texts?: Array<{ value: string; title?: string } | string>
            sessionId?: string
        }) => {
            logger.debug(
                '[hapiMCP] Display links: bound=',
                client.sessionId,
                'caller=',
                args.sessionId,
                'urls=',
                args.urls?.length ?? 0,
                'texts=',
                args.texts?.length ?? 0,
            );

            try {
                assertBoundDisplayLinksSession(client.sessionId, args.sessionId);
                const parsed = parseDisplayLinksToolInput(args);
                client.sendAgentMessage(buildDisplayLinksPayload({
                    urls: parsed.urls,
                    texts: parsed.texts,
                    id: randomUUID(),
                }));

                const parts: string[] = [];
                if (parsed.urls.length > 0) {
                    parts.push(`${parsed.urls.length} link${parsed.urls.length === 1 ? '' : 's'}`);
                }
                if (parsed.texts.length > 0) {
                    parts.push(`${parsed.texts.length} exact-copy card${parsed.texts.length === 1 ? '' : 's'}`);
                }
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Displayed ${parts.join(', ')}`,
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug('[hapiMCP] Failed to display links:', message);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to display links: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }

    mcp.registerTool<any, any>('ping_peer', {
        description: PING_PEER_TOOL_DESCRIPTION,
        title: 'Ping Peer Session',
        inputSchema: pingPeerInputSchema,
    }, async (args: { sessionIdPrefix: string; message: string }) => {
        logger.debug('[hapiMCP] ping_peer:', args.sessionIdPrefix);
        try {
            const result = await pingPeer({
                sessionIdPrefix: args.sessionIdPrefix,
                message: args.message,
            });
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Delivered to ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name})`,
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

    mcp.registerTool<any, any>('inspect_peer', {
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

    mcp.registerTool<any, any>('list_peers', {
        description: 'List peer HAPI sessions on the same hub/namespace (id prefix, active, flavor, name). Uses this session\'s hub credentials - works from runner-spawned agents without being on the hub host. Prefer this over shelling `hapi ping-peer --list`. Then call inspect_peer / ping_peer with a listed id.',
        title: 'List Peer Sessions',
        inputSchema: listPeersInputSchema,
    }, async (args: { limit?: number }) => {
        logger.debug('[hapiMCP] list_peers');
        try {
            const limit = args.limit ?? 30;
            const sessions = await listPeerSessions({
                limit: peerListFetchLimit(limit, { excludeCaller: true }),
            });
            const peers = sessions.filter((session) => session.id !== client.sessionId);
            const hasMore = peers.length > limit;
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: formatPeerSessionsList(peers, {
                            maxRows: limit,
                            hasMore,
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


    if (skillLookup) {
        mcp.registerTool<any, any>('skill_lookup', {
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
    const enableDisplayLinks = resolveEnableDisplayLinks(options);
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcps = new Map<string, McpServer>();

    const createMcpTransport = () => {
        const mcp = createHapiMcpServer(client, emitTitleSummary, enableChangeTitle, options.skillLookup, enableDisplayLinks);
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
        ? ['change_title', 'display_image', 'display_video', 'display_media']
        : ['display_image', 'display_video', 'display_media'];
    if (enableDisplayLinks) {
        toolNames.push(buildDisplayLinksToolName(client.sessionId));
    }
    toolNames.push('list_peers', 'ping_peer', 'inspect_peer');
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
