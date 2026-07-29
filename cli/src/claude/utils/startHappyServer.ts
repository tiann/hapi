/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { detectImageMimeType, registerGeneratedImage } from "@/modules/common/generatedImages";
import { resolveSkill } from "@/modules/common/skills";
import { PingPeerError, formatInspectPeerReport, inspectPeer, pingPeer } from "@/modules/pingPeer/pingPeer";

type StartHappyServerOptions = {
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
};

/** Registered on the MCP server, but never pre-approved via Claude --allowedTools. */
const CLAUDE_MANUAL_APPROVAL_HAPI_TOOLS = new Set(['ping_peer', 'inspect_peer']);

/**
 * Map HAPI MCP tool names to Claude `--allowedTools` entries.
 * Keeps `ping_peer` / `inspect_peer` off the auto-allow list so cross-session
 * write (resume+inject) and read (peer histories) still prompt.
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
        path: z.string().describe('Local filesystem path of the image to display to the user'),
        title: z.string().optional().describe('Optional display title or filename for the image'),
    });

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(
            'Target HAPI session id or unique id prefix (another session - not this chat). Prefer the full UUID from a [title](/sessions/<id>) citation.'
        ),
        message: z.string().min(1).describe('Message text to deliver to the target session'),
    });

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
        sessionIdPrefix: z.string().trim().min(1).describe(
            'Target HAPI session id or unique id prefix. Prefer the full UUID from a [title](/sessions/<id>) citation.'
        ),
        messageLimit: z.number().int().min(1).max(100).optional().describe(
            'Recent message page size (default 30, max 100). Text snippets only.'
        ),
    });

    const skillLookupInputSchema: z.ZodTypeAny = z.object({
        name: z.string().trim().min(1).max(128).describe('Exact skill name shown by HAPI skill autocomplete'),
    });

    if (enableChangeTitle) {
        mcp.registerTool<any, any>('change_title', {
            description: 'Change the title of the current chat session',
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
        description: 'Display a local image file inline in the current HAPI chat session',
        title: 'Display Image',
        inputSchema: displayImageInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display image:', args.path);

        try {
            const info = await lstat(args.path);
            if (!info.isFile()) {
                throw new Error('Path is not a regular file');
            }

            const maxImageBytes = 25 * 1024 * 1024;
            if (info.size > maxImageBytes) {
                throw new Error('Image is too large to display inline');
            }

            const bytes = await readFile(args.path);
            const mimeType = detectImageMimeType(bytes);
            if (!mimeType) {
                throw new Error('Unsupported image content');
            }

            const image = registerGeneratedImage({
                id: randomUUID(),
                path: args.path,
                fileName: args.title,
                mimeType,
                bytes
            });

            client.sendAgentMessage({
                type: 'generated-image',
                imageId: image.id,
                fileName: image.fileName,
                mimeType: image.mimeType,
                id: randomUUID()
            });

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

    mcp.registerTool<any, any>('ping_peer', {
        description: 'Send a message to another HAPI session (peer handoff / nudge). Resolves by session id prefix, resumes if inactive, then POSTs the message on the same hub/namespace. Prefer this (or `hapi ping-peer`) over reinventing JWT+curl. Targets another session - not the current chat. When the user cites [title](/sessions/<id>), pass that <id> as sessionIdPrefix.',
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
        description: 'Read another HAPI session (metadata + recent message text). Resolves by session id / prefix on the same hub/namespace. Read-only: does not resume. Prefer this (or `hapi inspect-peer`) over JWT+curl. When the user cites [title](/sessions/<id>), pass that <id> as sessionIdPrefix.',
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
        ? ['change_title', 'display_image', 'ping_peer', 'inspect_peer']
        : ['display_image', 'ping_peer', 'inspect_peer'];
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
