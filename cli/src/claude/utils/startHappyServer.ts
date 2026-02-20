/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 * and session spawning.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";

type SpawnSessionInput = {
    directory: string
    machineId?: string
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode'
    model?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    worktreeBranch?: string
    initialPrompt?: string
}

export async function startHappyServer(client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const resolveMachineId = async (requestedMachineId?: string): Promise<string> => {
        const explicitMachineId = typeof requestedMachineId === 'string' ? requestedMachineId.trim() : ''
        if (explicitMachineId) {
            return explicitMachineId
        }

        const currentMachineId = client.getCurrentMachineId()
        if (currentMachineId) {
            return currentMachineId
        }

        const onlineMachines = await client.listOnlineMachines()
        if (onlineMachines.length === 0) {
            throw new Error('No online machines available in this namespace')
        }
        if (onlineMachines.length === 1) {
            return onlineMachines[0].id
        }

        const machineList = onlineMachines.map((machine) => {
            const host = machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id
            return `${machine.id} (${host})`
        }).join(', ')
        throw new Error(`Multiple online machines found. Please provide machineId. Available machines: ${machineList}`)
    }

    const spawnSession = async (input: SpawnSessionInput): Promise<
        { success: true; sessionId: string; machineId: string; initialPromptDelivery?: 'delivered' | 'timed_out' }
        | { success: false; error: string }
    > => {
        try {
            const directory = input.directory.trim()
            if (!directory) {
                return { success: false, error: 'Directory is required' }
            }

            const machineId = await resolveMachineId(input.machineId)
            const result = await client.spawnSessionOnMachine({
                machineId,
                directory,
                agent: input.agent,
                model: input.model,
                yolo: input.yolo,
                sessionType: input.sessionType,
                worktreeName: input.worktreeName,
                worktreeBranch: input.worktreeBranch,
                initialPrompt: input.initialPrompt
            })

            if (result.type !== 'success') {
                return { success: false, error: result.message }
            }

            return {
                success: true,
                sessionId: result.sessionId,
                machineId,
                initialPromptDelivery: result.initialPromptDelivery
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            }
        }
    }

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "HAPI MCP",
        version: "1.0.0",
    });

    // Avoid TS instantiation depth issues by widening the schema type.
    const changeTitleInputSchema: z.ZodTypeAny = z.object({
        title: z.string().describe('The new title for the chat session'),
    });

    // Avoid TS instantiation depth issues by widening the schema type.
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
        } else {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('spawn_session', {
        description: 'Spawn a new HAPI session on an online machine',
        title: 'Spawn HAPI Session',
        inputSchema: spawnSessionInputSchema,
    }, async (args: SpawnSessionInput) => {
        logger.debug('[hapiMCP] Spawning session with args:', args);
        const response = await spawnSession(args);
        logger.debug('[hapiMCP] spawn_session response:', response);

        if (response.success) {
            const promptStatusText = args.initialPrompt && args.initialPrompt.trim()
                ? response.initialPromptDelivery === 'timed_out'
                    ? ' Initial prompt delivery timed out; session may not have started yet.'
                    : ' Initial prompt delivered.'
                : ''
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Spawned HAPI session ${response.sessionId} on machine ${response.machineId}.${promptStatusText}`,
                    },
                ],
                isError: false,
            };
        }

        return {
            content: [
                {
                    type: 'text' as const,
                    text: `Failed to spawn HAPI session: ${response.error}`,
                },
            ],
            isError: true,
        };
    });

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
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

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', 'spawn_session'],
        stop: () => {
            logger.debug('[hapiMCP] Stopping server');
            mcp.close();
            server.close();
        }
    }
}
