/**
 * HAPI MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing HAPI tools.
 * On invocation it forwards tool calls to an existing HAPI HTTP MCP server
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

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

export async function runHappyMcpStdioBridge(argv: string[]): Promise<void> {
  try {
    // Resolve target HTTP MCP URL
    const { url: urlFromArgs } = parseArgs(argv);
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

    const spawnSessionInputSchema: z.ZodTypeAny = z.object({
      directory: z.string().min(1).describe('Working directory for the new session (prefer absolute path)'),
      machineId: z.string().optional().describe('Optional machine ID. Defaults to current session machine when available'),
      agent: z.enum(['claude', 'codex', 'gemini', 'opencode']).optional().describe('Agent type for the new session: claude (default), codex (OpenAI Codex), gemini (Google Gemini), or opencode. Match to the user\'s requested agent.'),
      model: z.string().optional().describe('Optional model override for the spawned session'),
      yolo: z.boolean().optional().describe('Enable aggressive auto-approval mode for the spawned session'),
      sessionType: z.enum(['simple', 'worktree']).optional().describe('Spawn a normal session or a Git worktree session'),
      worktreeName: z.string().optional().describe('Optional worktree name hint (worktree sessions only)'),
      worktreeBranch: z.string().optional().describe('Optional worktree branch name (worktree sessions only)'),
      initialPrompt: z.string().max(100_000).optional().describe('Optional initial prompt/task to send after spawn (max 100000 chars)'),
    });

    const registerForwardTool = (
      toolName: string,
      options: {
        description: string;
        title: string;
        inputSchema: z.ZodTypeAny;
      }
    ): void => {
      server.registerTool<any, any>(
        toolName,
        options,
        async (args: Record<string, unknown>) => {
          try {
            const client = await ensureHttpClient();
            const response = await client.callTool({ name: toolName, arguments: args });
            // Pass-through response from HTTP server
            return response as any;
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to run ${toolName}: ${error instanceof Error ? error.message : String(error)}`
                },
              ],
              isError: true,
            };
          }
        }
      );
    };

    registerForwardTool('change_title', {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: changeTitleInputSchema,
    });

    registerForwardTool('spawn_session', {
      description: 'Spawn a new HAPI session on an online machine',
      title: 'Spawn HAPI Session',
      inputSchema: spawnSessionInputSchema,
    });

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
