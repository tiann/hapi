/**
 * HAPI MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing selected HAPI tools.
 * On invocation it forwards the tool call to an existing HAPI HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPI_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import {
  HAPI_SESSION_CONTROL_SKILL_DESCRIPTION,
  HAPI_SESSION_CONTROL_SKILL_NAME,
} from '@/modules/common/hapiSessionControlSkill';
import {
  INSPECT_PEER_TOOL_DESCRIPTION,
  PING_PEER_TOOL_DESCRIPTION,
  SESSION_ID_PARAM_DESCRIPTION,
  SPAWN_PEER_TOOL_DESCRIPTION,
} from '@hapi/protocol/sessionCitation';
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol';
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes';
import { PermissionModeSchema } from '@hapi/protocol/schemas';

const DEFAULT_TOOL_NAMES = ['change_title', 'display_image', 'display_video', 'display_media', 'ping_peer', 'inspect_peer', 'spawn_peer'];

function parseArgs(argv: string[]): { url: string | null; toolNames: Set<string> } {
  let url: string | null = null;
  let toolNames = new Set(DEFAULT_TOOL_NAMES);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    } else if (a === '--tools' && i + 1 < argv.length) {
      toolNames = new Set(argv[i + 1].split(',').map((name) => name.trim()).filter(Boolean));
      i++;
    }
  }
  return { url, toolNames };
}

export async function runHappyMcpStdioBridge(argv: string[]): Promise<void> {
  try {
    // Resolve target HTTP MCP URL
    const { url: urlFromArgs, toolNames } = parseArgs(argv);
    const baseUrl = urlFromArgs || process.env.HAPI_HTTP_MCP_URL || '';

    if (!baseUrl) {
      // Write to stderr; never stdout.
      process.stderr.write(
        '[hapi-mcp] Missing target URL. Set HAPI_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
      );
      process.exit(2);
    }

    let httpClient: Client | null = null;

    async function ensureHttpClient(): Promise<Client> {
      if (httpClient) return httpClient;
      const client = new Client(
        { name: 'hapi-stdio-bridge', version: '1.0.0' },
        { capabilities: {} }
      );

      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      await client.connect(transport);
      httpClient = client;
      return client;
    }

    // Create STDIO MCP server
    const server = new McpServer({
      name: 'HAPI MCP Bridge',
      version: '1.0.0',
    });

    // Register tools and forward to HTTP MCP
    const changeTitleInputSchema: z.ZodTypeAny = z.object({
      title: z.string().describe('The new title for the chat session'),
    });

    if (toolNames.has('change_title')) {
      server.registerTool<any, any>(
        'change_title',
        {
          description: 'Change the title of the current chat session',
          title: 'Change Chat Title',
          inputSchema: changeTitleInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'change_title', arguments: args });
            // Pass-through response from HTTP server
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }



    const displayImageInputSchema: z.ZodTypeAny = z.object({
      path: z.string().describe('Absolute filesystem path of the local image to display to the human user. This file is sent for user display, not provided to the model for image inspection'),
      title: z.string().optional().describe('Optional display title or filename shown to the human user'),
    });

    if (toolNames.has('display_image')) {
      server.registerTool<any, any>(
        'display_image',
        {
          description: 'Display a local image to the human user; this does not provide image input to the model and cannot inspect the image.',
          title: 'Display Image',
          inputSchema: displayImageInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'display_image', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to display image: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

    const displayVideoInputSchema: z.ZodTypeAny = z.object({
      path: z.string().describe('Local filesystem path of the video to display inline (mp4 or webm)'),
      title: z.string().optional().describe('Optional display title or filename for the video'),
    });

    if (toolNames.has('display_video')) {
      server.registerTool<any, any>(
        'display_video',
        {
          description: 'Display a local mp4 or webm file in the current HAPI chat.',
          title: 'Display Video',
          inputSchema: displayVideoInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'display_video', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to display video: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

    const displayMediaInputSchema: z.ZodTypeAny = z.object({
      path: z.string().describe('Local filesystem path of the media or file to send to the user'),
      title: z.string().trim().min(1).max(255).optional().describe('Optional display title or filename'),
    });

    if (toolNames.has('display_media')) {
      server.registerTool<any, any>(
        'display_media',
        {
          description: 'Send a local file to the current HAPI chat.',
          title: 'Display Media',
          inputSchema: displayMediaInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            return await client.callTool({ name: 'display_media', arguments: args }) as any;
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: `Failed to display media: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
            };
          }
        }
      );
    }

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
      sessionId: z.string().uuid().describe(SESSION_ID_PARAM_DESCRIPTION),
      message: z.string().min(1).describe('Message text to deliver to the target session'),
      remitId: z.string().uuid().optional().describe('Stable retry id; reuse only for the same target and message'),
    });

    if (toolNames.has('ping_peer')) {
      server.registerTool<any, any>(
        'ping_peer',
        {
          description: PING_PEER_TOOL_DESCRIPTION,
          title: 'Ping Peer Session',
          inputSchema: pingPeerInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'ping_peer', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to ping peer: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

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
      remitId: z.string().uuid().optional().describe('Stable retry id; reuse only for the same spawn request'),
    });

    if (toolNames.has('spawn_peer')) {
      server.registerTool<any, any>(
        'spawn_peer',
        {
          description: SPAWN_PEER_TOOL_DESCRIPTION,
          title: 'Spawn Peer Session',
          inputSchema: spawnPeerInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'spawn_peer', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to spawn peer: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
      sessionId: z.string().uuid().describe(SESSION_ID_PARAM_DESCRIPTION),
      messageLimit: z.number().int().min(1).max(100).optional().describe(
        'Recent message page size (default 30, max 100). Text snippets only.'
      ),
    });

    if (toolNames.has('inspect_peer')) {
      server.registerTool<any, any>(
        'inspect_peer',
        {
          description: INSPECT_PEER_TOOL_DESCRIPTION,
          title: 'Inspect Peer Session',
          inputSchema: inspectPeerInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'inspect_peer', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to inspect peer: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

    const skillLookupInputSchema: z.ZodTypeAny = z.object({
      name: z.string().trim().min(1).max(128).describe('Exact skill name from the catalog'),
    });

    if (toolNames.has('skill_lookup')) {
      server.registerTool<any, any>(
        'skill_lookup',
        {
          description: `Load one skill body by exact name. Catalog: ${HAPI_SESSION_CONTROL_SKILL_NAME} — ${HAPI_SESSION_CONTROL_SKILL_DESCRIPTION}`,
          title: 'Look Up Skill',
          inputSchema: skillLookupInputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: 'skill_lookup', arguments: args });
            return response as any;
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to look up skill: ${error instanceof Error ? error.message : String(error)}` },
              ],
              isError: true,
            };
          }
        }
      );
    }

    // Start STDIO transport
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
  } catch (err) {
    try {
      process.stderr.write(`[hapi-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.exit(1);
    }
  }
}
