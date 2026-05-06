import { CODEX_PERMISSION_MODES } from '@hapi/protocol/modes';
import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { ReasoningEffort } from '../appServerTypes';
import type { EnhancedMode } from '../loop';
import type { SlashCommand } from '@/modules/common/slashCommands';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const UNSUPPORTED_CODEX_BUILTIN_COMMANDS = new Set([
    'compat',
    'diff',
    'init',
    'login',
    'logout',
    'mcp',
    'new',
    'prompts',
    'quit',
    'redo',
    'review',
    'undo'
]);

export type CodexSlashResolution =
    | { kind: 'passthrough' }
    | {
        kind: 'handled';
        message: string;
        updates?: {
            collaborationMode?: EnhancedMode['collaborationMode'];
            permissionMode?: CodexPermissionMode;
            model?: string | null;
            modelReasoningEffort?: ReasoningEffort | null;
        };
    }
    | {
        kind: 'replace';
        text: string;
        message?: string;
        updates?: {
            collaborationMode?: EnhancedMode['collaborationMode'];
            permissionMode?: CodexPermissionMode;
            model?: string | null;
            modelReasoningEffort?: ReasoningEffort | null;
        };
    };

export function resolveCodexSlashCommand(
    text: string,
    state: {
        commands?: readonly SlashCommand[];
        permissionMode: CodexPermissionMode;
        collaborationMode: EnhancedMode['collaborationMode'];
        model?: string;
        modelReasoningEffort?: ReasoningEffort;
    }
): CodexSlashResolution {
    const match = /^\s*\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) return { kind: 'passthrough' };

    const command = match[1]?.toLowerCase();
    const rest = match[2]?.trim() ?? '';
    if (!command) return { kind: 'passthrough' };

    const custom = state.commands?.find((candidate) =>
        candidate.source !== 'builtin' && candidate.name.toLowerCase() === command
    );
    if (custom?.content) {
        return {
            kind: 'replace',
            text: rest ? `${custom.content}\n\nUser arguments: ${rest}` : custom.content,
            message: `Expanded /${custom.name}`
        };
    }

    if (command === 'plan') {
        const lowerRest = rest.toLowerCase();
        if (lowerRest === 'off' || lowerRest === 'default' || lowerRest === 'exit' || lowerRest === 'disable') {
            return {
                kind: 'handled',
                message: 'Codex plan mode disabled',
                updates: { collaborationMode: 'default' }
            };
        }
        if (rest) {
            return {
                kind: 'replace',
                text: rest,
                message: 'Codex plan mode enabled',
                updates: { collaborationMode: 'plan' }
            };
        }
        return {
            kind: 'handled',
            message: 'Codex plan mode enabled',
            updates: { collaborationMode: 'plan' }
        };
    }

    if (command === 'default' || command === 'execute') {
        return {
            kind: 'handled',
            message: 'Codex collaboration mode: default',
            updates: { collaborationMode: 'default' }
        };
    }

    if (command === 'status') {
        return {
            kind: 'handled',
            message: [
                `Codex status`,
                `permission: ${state.permissionMode}`,
                `collaboration: ${state.collaborationMode}`,
                `model: ${state.model ?? 'auto'}`,
                `reasoning: ${state.modelReasoningEffort ?? 'default'}`
            ].join('\n')
        };
    }

    if (command === 'model') {
        if (!rest) {
            return { kind: 'handled', message: `Codex model: ${state.model ?? 'auto'}` };
        }
        const model = rest === 'auto' ? null : rest;
        return {
            kind: 'handled',
            message: `Codex model set to ${model ?? 'auto'}`,
            updates: { model }
        };
    }

    if (command === 'reasoning' || command === 'effort') {
        if (!rest) {
            return { kind: 'handled', message: `Codex reasoning effort: ${state.modelReasoningEffort ?? 'default'}` };
        }
        if (rest === 'default' || rest === 'auto') {
            return {
                kind: 'handled',
                message: 'Codex reasoning effort set to default',
                updates: { modelReasoningEffort: null }
            };
        }
        if (!REASONING_EFFORTS.has(rest as ReasoningEffort)) {
            return {
                kind: 'handled',
                message: `Unknown Codex reasoning effort: ${rest}`
            };
        }
        return {
            kind: 'handled',
            message: `Codex reasoning effort set to ${rest}`,
            updates: { modelReasoningEffort: rest as ReasoningEffort }
        };
    }

    if (command === 'permissions' || command === 'permission') {
        if (!rest) {
            return { kind: 'handled', message: `Codex permission mode: ${state.permissionMode}` };
        }
        if (!(CODEX_PERMISSION_MODES as readonly string[]).includes(rest)) {
            return {
                kind: 'handled',
                message: `Unknown Codex permission mode: ${rest}`
            };
        }
        return {
            kind: 'handled',
            message: `Codex permission mode set to ${rest}`,
            updates: { permissionMode: rest as CodexPermissionMode }
        };
    }

    if (command === 'help') {
        return {
            kind: 'handled',
            message: [
                'Supported Codex slash commands:',
                '/plan [prompt] — enable plan mode, optionally send prompt',
                '/plan off — return to default mode',
                '/clear — reset current Codex thread context',
                '/compact — compact current Codex thread context',
                '/status — show current Codex session config',
                '/model [name|auto] — show or set model',
                '/reasoning [low|medium|high|xhigh|default] — show or set reasoning effort',
                '/permissions [default|read-only|safe-yolo|yolo] — show or set permission mode',
                'Custom /commands from .codex/prompts are expanded before sending.'
            ].join('\n')
        };
    }

    if (UNSUPPORTED_CODEX_BUILTIN_COMMANDS.has(command)) {
        return {
            kind: 'handled',
            message: `/${command} is a Codex CLI command that is not supported in HAPI sessions yet.`
        };
    }

    return { kind: 'passthrough' };
}
