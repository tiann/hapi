import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { CodexPermissionHandler } from './permissionHandler';
import type { CodexAppServerClient } from '../codexAppServerClient';

type PermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

type PermissionResult = {
    decision: PermissionDecision;
    reason?: string;
};

type ElicitationSchemaProperty = {
    title?: unknown;
    description?: unknown;
    type?: unknown;
    default?: unknown;
    enum?: unknown;
    oneOf?: unknown;
    items?: unknown;
};

type UserInputAnswer = Record<string, string[]> | Record<string, { answers: string[] }>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asWebUrl(value: unknown): string | undefined {
    const raw = asString(value);
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

function pickToolName(record: Record<string, unknown>): string {
    return asString(record.toolName)
        ?? asString(record.tool_name)
        ?? asString(record.tool)
        ?? asString(record.name)
        ?? asString(record.permission)
        ?? 'CodexTool';
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

function mapPermissionGrant(
    requested: unknown,
    decision: PermissionDecision
): {
    permissions: unknown;
    scope: 'turn' | 'session';
} {
    if (decision === 'approved' || decision === 'approved_for_session') {
        return {
            permissions: requested,
            scope: decision === 'approved_for_session' ? 'session' : 'turn'
        };
    }

    return {
        permissions: {
            network: null,
            fileSystem: null
        },
        scope: 'turn'
    };
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

function unwrapElicitationRequest(params: unknown): Record<string, unknown> {
    const record = asRecord(params) ?? {};
    return asRecord(record.request) ?? record;
}

function elicitationOptions(property: Record<string, unknown>): Array<{ label: string; description: string }> {
    const values = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
            ? property.oneOf.map((item) => asRecord(item)?.const).filter((item) => item !== undefined)
            : property.type === 'boolean'
                ? [true, false]
                : [];

    return values.map((value) => ({
        label: String(value),
        description: ''
    }));
}

function buildElicitationUserInput(params: unknown): { questions: unknown[]; url?: string } | null {
    const request = unwrapElicitationRequest(params);
    const mode = asString(request.mode) ?? 'form';
    const message = asString(request.message) ?? 'MCP server requires input';

    if (mode === 'url') {
        const url = asWebUrl(request.url);
        if (!url) return null;
        return {
            url,
            questions: [{
                id: '__mcp_url_confirmation',
                question: message,
                options: [{ label: 'Open sign-in page and continue', description: url }]
            }]
        };
    }

    if (mode !== 'form') return null;
    const schema = asRecord(request.requestedSchema);
    const properties = asRecord(schema?.properties);
    if (!properties) return null;
    const required = new Set(
        Array.isArray(schema?.required)
            ? schema.required.filter((value): value is string => typeof value === 'string')
            : []
    );

    const questions = Object.entries(properties).map(([id, rawProperty]) => {
        const property = asRecord(rawProperty) ?? {};
        return {
            id,
            question: asString(property.title) ?? asString(property.description) ?? id,
            required: required.has(id),
            options: elicitationOptions(property)
        };
    });
    return {
        questions: questions.length > 0 ? questions : [{
            id: '__mcp_form_confirmation',
            question: message,
            options: [{ label: 'Continue', description: '' }]
        }]
    };
}

function answerValues(answers: UserInputAnswer, id: string): string[] {
    const value = answers[id];
    if (Array.isArray(value)) return value;
    return asRecord(value)?.answers instanceof Array
        ? (asRecord(value)?.answers as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
}

function buildElicitationContent(params: unknown, answers: UserInputAnswer): Record<string, unknown> {
    const request = unwrapElicitationRequest(params);
    if (request.mode === 'url') return {};
    const properties = asRecord(asRecord(request.requestedSchema)?.properties) ?? {};
    const content: Record<string, unknown> = {};

    for (const [id, rawProperty] of Object.entries(properties)) {
        const property = asRecord(rawProperty) ?? {};
        const values = answerValues(answers, id);
        const selectedValues = values.filter((value) => !value.startsWith('user_note: '));
        const selected = selectedValues[0];
        const note = values.find((value) => value.startsWith('user_note: '))?.slice('user_note: '.length);
        const value = selected ?? note;
        if (value === undefined) continue;

        if (property.type === 'boolean') content[id] = value === 'true';
        else if (property.type === 'number' || property.type === 'integer') content[id] = Number(value);
        else if (property.type === 'array') content[id] = selectedValues;
        else content[id] = value;
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
    getPermissionMode?: () => CodexPermissionMode | undefined;
    onUserInputRequest?: (request: { id: string; input: unknown }) => Promise<
        | { decision: 'accept'; answers: UserInputAnswer }
        | { decision: 'decline' | 'cancel' }
    >;
}): void {
    const { client, permissionHandler, getPermissionMode, onUserInputRequest } = args;

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

    client.registerRequestHandler('item/permissions/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const permissions = record.permissions ?? {};

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexPermission',
            {
                message: asString(record.reason),
                cwd: asString(record.cwd),
                permissions
            }
        ) as PermissionResult;

        return mapPermissionGrant(permissions, result.decision);
    });

    client.registerRequestHandler('item/tool/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? asString(record.item_id) ?? randomUUID();
        const toolName = pickToolName(record);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            toolName,
            record.input ?? record.arguments ?? params
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
        const request = unwrapElicitationRequest(params);

        // HAPI's own bridge only asks for values whose safe defaults are defined by HAPI.
        if (isHapiBridgeElicitation(params)) {
            return {
                action: 'accept',
                content: buildAcceptedElicitationContent(request),
                _meta: null
            };
        }

        const input = buildElicitationUserInput(params);
        if (!onUserInputRequest || !input) {
            logger.debug('[CodexAppServer] Cancelling unsupported MCP elicitation request', {
                serverName: record.serverName,
                mode: request.mode,
                message: request.message,
                permissionMode: getPermissionMode?.() ?? 'unknown'
            });

            return {
                action: 'cancel',
                content: null,
                _meta: null
            };
        }

        const requestId = asString(request.elicitationId) ?? randomUUID();
        const result = await onUserInputRequest({ id: requestId, input });
        if (result.decision !== 'accept') {
            return { action: result.decision === 'decline' ? 'decline' : 'cancel', content: null, _meta: null };
        }

        return {
            action: 'accept',
            content: buildElicitationContent(params, result.answers),
            _meta: null
        };
    });
}
