/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';

type ElicitResponseValue = string | number | boolean | string[];
type ElicitRequestedSchema = {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function extractRequestedSchema(params: Record<string, unknown>): ElicitRequestedSchema | null {
    const raw = params.requestedSchema;
    if (!isObject(raw)) return null;
    const properties = isObject(raw.properties) ? (raw.properties as Record<string, unknown>) : undefined;
    const required = Array.isArray(raw.required) ? raw.required.filter((item) => typeof item === 'string') : undefined;
    const type = typeof raw.type === 'string' ? raw.type : undefined;
    return { type, properties, required };
}

function extractToolCallId(params: Record<string, unknown>): string | null {
    const candidateKeys = [
        'codex_call_id',
        'codex_mcp_tool_call_id',
        'codex_event_id',
        'call_id',
        'tool_call_id',
        'toolCallId',
        'mcp_tool_call_id',
        'mcpToolCallId',
        'id'
    ];

    for (const key of candidateKeys) {
        const value = params[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function extractCommand(params: Record<string, unknown>): string[] | null {
    const command = params.codex_command ?? params.command ?? params.cmd;
    if (Array.isArray(command) && command.every((item) => typeof item === 'string')) {
        return command as string[];
    }
    if (typeof command === 'string' && command.length > 0) {
        return [command];
    }
    return null;
}

function extractCwd(params: Record<string, unknown>): string | null {
    const cwd = params.codex_cwd ?? params.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

function buildElicitationResult(
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    requestedSchema: ElicitRequestedSchema | null,
    reason?: string
): {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, ElicitResponseValue>;
    decision?: string;
    reason?: string;
} {
    const action: 'accept' | 'decline' | 'cancel' =
        decision === 'approved' || decision === 'approved_for_session'
            ? 'accept'
            : decision === 'abort'
                ? 'cancel'
                : 'decline';

    if (!requestedSchema?.properties || Object.keys(requestedSchema.properties).length === 0) {
        return reason ? { action, decision, reason } : { action, decision };
    }

    if (action !== 'accept') {
        return reason ? { action, decision, reason } : { action, decision };
    }

    const properties = requestedSchema?.properties ?? null;
    const content: Record<string, ElicitResponseValue> = {};

    if (properties && Object.keys(properties).length > 0) {
        const approved = decision === 'approved' || decision === 'approved_for_session';

        if (Object.prototype.hasOwnProperty.call(properties, 'decision')) {
            content.decision = decision;
        }
        if (Object.prototype.hasOwnProperty.call(properties, 'approved')) {
            content.approved = approved;
        }
        if (Object.prototype.hasOwnProperty.call(properties, 'allow')) {
            content.allow = approved;
        }
        if (reason && Object.prototype.hasOwnProperty.call(properties, 'reason')) {
            content.reason = reason;
        }

        if (Object.keys(content).length === 0) {
            const [fallbackKey] = Object.keys(properties);
            if (fallbackKey) {
                content[fallbackKey] = decision;
            }
        }
    } else {
        content.decision = decision;
        if (reason) {
            content.reason = reason;
        }
    }

    return reason ? { action, content, decision, reason } : { action, content, decision };
}

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 */
function getCodexMcpCommand(): string {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) return 'mcp-server'; // Default to newer command if we can't parse

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 has mcp-server
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            // Check for alpha version
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable has mcp-server
        }
        return 'mcp'; // Older versions use mcp
    } catch (error) {
        logger.debug('[CodexMCP] Error detecting codex version, defaulting to mcp-server:', error);
        return 'mcp-server'; // Default to newer command
    }
}

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'hapi-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        // Avoid TS instantiation depth issues by widening the schema type.
        const codexNotificationSchema: z.ZodTypeAny = z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough();

        const setNotificationHandler = this.client.setNotificationHandler as (
            schema: unknown,
            handler: (notification: { params: { msg: any } }) => void
        ) => void;

        setNotificationHandler(codexNotificationSchema, (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const mcpCommand = getCodexMcpCommand();
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`);

        this.transport = new StdioClientTransport({
            command: 'codex',
            args: [mcpCommand],
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        // Register handler for exec command approval requests
        this.client.setRequestHandler(
            ElicitRequestSchema,
            async (request) => {
                const params = request.params as Record<string, unknown>;
                const requestedSchema = extractRequestedSchema(params);

                // Load params
                const toolCallId = extractToolCallId(params) ?? randomUUID();
                const command = extractCommand(params);
                const cwd = extractCwd(params);
                const toolName = 'CodexBash';

                // If no permission handler set, deny by default
                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler set, denying by default');
                    return buildElicitationResult('denied', requestedSchema, 'Permission handler not configured');
                }

                try {
                    // Request permission through the handler
                    const result = await this.permissionHandler.handleToolCall(
                        toolCallId,
                        toolName,
                        {
                            command: command ?? [],
                            cwd: cwd ?? ''
                        }
                    );

                    logger.debug('[CodexMCP] Permission result:', result);
                    return buildElicitationResult(result.decision, requestedSchema, result.reason);
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission request:', error);
                    const reason = error instanceof Error ? error.message : 'Permission request failed';
                    return buildElicitationResult('denied', requestedSchema, reason);
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            // Some Codex deployments reuse the session ID as the conversation identifier
            this.conversationId = this.sessionId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to sessionId:', this.conversationId);
        }

        const args = { sessionId: this.sessionId, conversationId: this.conversationId, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }

        for (const candidate of candidates) {
            const sessionId = candidate.session_id ?? candidate.sessionId;
            if (sessionId) {
                this.sessionId = sessionId;
                logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.sessionId && item?.sessionId) {
                    this.sessionId = item.sessionId;
                    logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        // Store the previous session ID before clearing for potential resume
        const previousSessionId = this.sessionId;
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    /**
     * Store the current session ID without clearing it, useful for abort handling
     */
    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.sessionId);
        return this.sessionId;
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try { 
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.(); 
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            try {
                process.kill(pid, 0); // check if alive
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch {}
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        this.sessionId = null;
        this.conversationId = null;

        logger.debug('[CodexMCP] Disconnected');
    }
}
