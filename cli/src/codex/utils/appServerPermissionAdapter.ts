import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CodexPermissionHandler } from './permissionHandler';
import type { CodexAppServerClient } from '../codexAppServerClient';

type PermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

type PermissionResult = {
    decision: PermissionDecision;
    reason?: string;
};

type ElicitationSchemaProperty = {
    type?: unknown;
    default?: unknown;
    enum?: unknown;
    oneOf?: unknown;
    items?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapDecision(decision: PermissionDecision): { decision: string } {
    switch (decision) {
        case 'approved':
            return { decision: 'accept' };
        case 'approved_for_session':
            return { decision: 'acceptForSession' };
        case 'denied':
            return { decision: 'decline' };
        case 'abort':
            return { decision: 'cancel' };
    }
}

function firstString(values: unknown): string | undefined {
    if (!Array.isArray(values)) {
        return undefined;
    }

    return values.find((value): value is string => typeof value === 'string');
}

function firstConst(values: unknown): string | undefined {
    if (!Array.isArray(values)) {
        return undefined;
    }

    for (const value of values) {
        const record = asRecord(value);
        if (typeof record?.const === 'string') {
            return record.const;
        }
    }

    return undefined;
}

function defaultValueForElicitationProperty(property: ElicitationSchemaProperty): unknown {
    if ('default' in property) {
        return property.default;
    }

    switch (property.type) {
        case 'string':
            return firstString(property.enum)
                ?? firstConst(property.oneOf)
                ?? '';
        case 'boolean':
            return true;
        case 'number':
        case 'integer':
            return 0;
        case 'array': {
            const items = asRecord(property.items);
            const value = firstString(items?.enum)
                ?? firstConst(items?.anyOf);
            return value ? [value] : [];
        }
        default:
            return null;
    }
}

function buildAcceptedElicitationContent(params: unknown): Record<string, unknown> {
    const record = asRecord(params);
    const schema = asRecord(record?.requestedSchema);
    const properties = asRecord(schema?.properties);

    if (!properties) {
        return {};
    }

    const required = Array.isArray(schema?.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : Object.keys(properties);
    const content: Record<string, unknown> = {};

    for (const key of required) {
        const property = asRecord(properties[key]);
        if (!property) {
            continue;
        }

        content[key] = defaultValueForElicitationProperty(property);
    }

    return content;
}

function isHapiBridgeElicitation(params: unknown): boolean {
    const record = asRecord(params);
    return record?.serverName === 'hapi';
}

export function registerAppServerPermissionHandlers(args: {
    client: CodexAppServerClient;
    permissionHandler: CodexPermissionHandler;
    onUserInputRequest?: (request: { id: string; input: unknown }) => Promise<
        | { decision: 'accept'; answers: Record<string, string[]> | Record<string, { answers: string[] }> }
        | { decision: 'decline' | 'cancel' }
    >;
}): void {
    const { client, permissionHandler, onUserInputRequest } = args;

    client.registerRequestHandler('item/commandExecution/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const command = record.command;
        const cwd = asString(record.cwd);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexBash',
            {
                message: reason,
                command,
                cwd
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/fileChange/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const grantRoot = asString(record.grantRoot);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexPatch',
            {
                message: reason,
                grantRoot
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/tool/requestUserInput', async (params) => {
        const record = asRecord(params) ?? {};
        const requestId = asString(record.itemId) ?? randomUUID();

        if (!onUserInputRequest) {
            logger.debug('[CodexAppServer] No user-input handler registered; cancelling request');
            return { decision: 'cancel' };
        }

        const result = await onUserInputRequest({
            id: requestId,
            input: params
        });

        if (result.decision !== 'accept') {
            return { decision: result.decision };
        }

        return result;
    });

    client.registerRequestHandler('mcpServer/elicitation/request', async (params) => {
        const record = asRecord(params) ?? {};

        if (!isHapiBridgeElicitation(params)) {
            logger.debug('[CodexAppServer] Cancelling unsupported MCP elicitation request', {
                serverName: record.serverName,
                mode: record.mode,
                message: record.message
            });

            return {
                action: 'cancel',
                content: null,
                _meta: null
            };
        }

        logger.debug('[CodexAppServer] Accepting MCP elicitation request', {
            serverName: record.serverName,
            mode: record.mode,
            message: record.message
        });

        return {
            action: 'accept',
            content: buildAcceptedElicitationContent(params),
            _meta: null
        };
    });
}
