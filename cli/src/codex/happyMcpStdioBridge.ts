/**
 * HAPI MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing HAPI tools such as `change_title` and `display_image`.
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
import { DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR } from '@/modules/common/displayImagePrompt';

const DEFAULT_TOOL_NAMES = ['change_title', 'display_image', 'display_video'];

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
      path: z.string().describe('Local filesystem path of the image to display to the user'),
      title: z.string().optional().describe('Optional display title or filename for the image'),
    });

    if (toolNames.has('display_image')) {
      server.registerTool<any, any>(
        'display_image',
        {
          description: `Display a local image file inline in the current HAPI chat session. ${DISPLAY_IMAGE_PROMPT_CURSOR}`,
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
          description: `Display a local mp4 or webm file inline in the current HAPI chat session. ${DISPLAY_VIDEO_PROMPT_CURSOR}`,
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

    const skillLookupInputSchema: z.ZodTypeAny = z.object({
      name: z.string().trim().min(1).max(128).describe('Exact skill name shown by HAPI skill autocomplete'),
    });

    if (toolNames.has('skill_lookup')) {
      server.registerTool<any, any>(
        'skill_lookup',
        {
          description: 'Load a HAPI skill by exact name. When a user message starts with $name, call this tool with that name before acting.',
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
