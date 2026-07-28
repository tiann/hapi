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

function getMcpToolApprovalMeta(params: unknown): Record<string, unknown> | null {
    const record = asRecord(params) ?? {};
    const request = unwrapElicitationRequest(params);
    const meta = asRecord(request._meta) ?? asRecord(record._meta);
    if (meta?.codex_approval_kind !== 'mcp_tool_call') return null;

    const mode = asString(request.mode) ?? 'form';
    if (mode !== 'form') return null;

    const schema = asRecord(request.requestedSchema);
    const properties = asRecord(schema?.properties);
    if (properties && Object.keys(properties).length > 0) return null;

    return meta;
}

function mcpApprovalSupportsSessionPersistence(meta: Record<string, unknown>): boolean {
    if (meta.persist === 'session') return true;
    return Array.isArray(meta.persist) && meta.persist.includes('session');
}

function buildMcpToolApprovalInput(
    params: unknown,
    meta: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } {
    const record = asRecord(params) ?? {};
    const request = unwrapElicitationRequest(params);
    const serverName = asString(record.serverName) ?? asString(request.serverName);
    const toolTitle = asString(meta.tool_title);
    const toolName = asString(meta.tool_name) ?? toolTitle ?? serverName ?? 'MCP tool';
    const input: Record<string, unknown> = {
        message: asString(request.message) ?? 'Allow MCP tool call?'
    };

    if (serverName) input.serverName = serverName;
    if (toolTitle) input.toolTitle = toolTitle;
    const toolDescription = asString(meta.tool_description);
    if (toolDescription) input.toolDescription = toolDescription;
    if (meta.tool_params !== undefined) input.toolParams = meta.tool_params;
    if (meta.tool_params_display !== undefined) input.toolParamsDisplay = meta.tool_params_display;

    return { toolName, input };
}

function mapMcpToolApprovalDecision(
    decision: PermissionDecision,
    meta: Record<string, unknown>
): { action: 'accept' | 'decline' | 'cancel'; content: null; _meta: { persist: 'session' } | null } {
    if (decision === 'denied') {
        return { action: 'decline', content: null, _meta: null };
    }
    if (decision === 'abort') {
        return { action: 'cancel', content: null, _meta: null };
    }

    return {
        action: 'accept',
        content: null,
        _meta: decision === 'approved_for_session' && mcpApprovalSupportsSessionPersistence(meta)
            ? { persist: 'session' }
            : null
    };
}

function elicitationChoiceValues(property: Record<string, unknown>): unknown[] {
    if (Array.isArray(property.enum)) return property.enum;
    if (Array.isArray(property.oneOf)) {
        return property.oneOf.map((item) => asRecord(item)?.const).filter((item) => item !== undefined);
    }
    if (property.type === 'array') {
        const items = asRecord(property.items);
        if (Array.isArray(items?.enum)) return items.enum;
        if (Array.isArray(items?.oneOf)) {
            return items.oneOf.map((item) => asRecord(item)?.const).filter((item) => item !== undefined);
        }
        if (items?.type === 'boolean') return [true, false];
    }
    if (property.type === 'boolean') return [true, false];
    return [];
}

function elicitationOptions(property: Record<string, unknown>): Array<{ label: string; description: string }> {
    return elicitationChoiceValues(property).map((value) => ({
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
                header: 'Sign in',
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
        const fieldQuestion = asString(property.title) ?? asString(property.description) ?? id;
        return {
            id,
            header: fieldQuestion,
            question: `${message}\n\n${fieldQuestion}`,
            required: required.has(id),
            ...(property.type === 'array' ? { multiple: true } : {}),
            options: elicitationOptions(property)
        };
    });
    return {
        questions: questions.length > 0 ? questions : [{
            id: '__mcp_form_confirmation',
            header: 'Confirmation',
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

function coerceSchemaValue(value: string, schema: Record<string, unknown>): unknown {
    if (schema.type === 'boolean') {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return undefined;
    }
    if (schema.type === 'number') {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    if (schema.type === 'integer') {
        const number = Number(value);
        return Number.isInteger(number) ? number : undefined;
    }
    return value;
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
        const hasSchemaChoices = elicitationChoiceValues(property).length > 0;
        if (hasSchemaChoices && selected === undefined) continue;
        const value = selected ?? note;
        if (value === undefined) continue;

        if (property.type === 'array') {
            const itemSchema = asRecord(property.items) ?? {};
            const rawValues = selectedValues.length > 0
                ? selectedValues
                : note !== undefined
                    ? [note]
                    : [];
            content[id] = rawValues
                .map((item) => coerceSchemaValue(item, itemSchema))
                .filter((item) => item !== undefined);
        } else {
            const coerced = coerceSchemaValue(value, property);
            if (coerced !== undefined) content[id] = coerced;
        }
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

        const approvalMeta = getMcpToolApprovalMeta(params);
        if (approvalMeta) {
            const requestId = asString(request.elicitationId) ?? randomUUID();
            const approval = buildMcpToolApprovalInput(params, approvalMeta);
            const result = await permissionHandler.handleToolCall(
                requestId,
                approval.toolName,
                approval.input
            ) as PermissionResult;
            return mapMcpToolApprovalDecision(result.decision, approvalMeta);
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
