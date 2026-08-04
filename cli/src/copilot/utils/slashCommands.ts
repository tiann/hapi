import { COPILOT_PERMISSION_MODES } from '@hapi/protocol/modes';
import type { CopilotAgentMode } from '@hapi/protocol';
import type { CopilotPermissionMode } from '@hapi/protocol/types';
import type { SlashCommand } from '@/modules/common/slashCommands';

export type CopilotSlashResolution =
    | { kind: 'passthrough' }
    | {
        kind: 'handled';
        message: string;
        updates?: {
            permissionMode?: CopilotPermissionMode;
            model?: string | null;
            agentMode?: CopilotAgentMode;
        };
    }
    | {
        kind: 'replace';
        text: string;
        message?: string;
        updates?: {
            permissionMode?: CopilotPermissionMode;
            model?: string | null;
            agentMode?: CopilotAgentMode;
        };
    };

function resolveCopilotPermissionMode(rest: string): CopilotPermissionMode | null {
    const normalized = rest.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'default' || normalized === 'off') return 'default';
    if ((COPILOT_PERMISSION_MODES as readonly string[]).includes(normalized)) {
        return normalized as CopilotPermissionMode;
    }
    return null;
}

function resolveCopilotAgentMode(rest: string): CopilotAgentMode | null {
    const normalized = rest.trim().toLowerCase();
    if (!normalized || normalized === 'default' || normalized === 'off' || normalized === 'interactive') {
        return 'interactive';
    }
    if (normalized === 'plan') return 'plan';
    if (normalized === 'autopilot') return 'autopilot';
    return null;
}

export function resolveCopilotSlashCommand(
    text: string,
    state: {
        commands?: readonly SlashCommand[];
        permissionMode: CopilotPermissionMode;
        model?: string | null;
        agentMode: CopilotAgentMode;
    }
): CopilotSlashResolution {
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

    if (command === 'help') {
        const lines = (state.commands ?? [])
            .filter((entry) => entry.source === 'builtin')
            .map((entry) => `- \`/${entry.name}\` — ${entry.description}`);
        return {
            kind: 'handled',
            message: [
                '**Supported Copilot slash commands**',
                '',
                ...lines,
                '',
                '`/fleet` is orthogonal to agent mode (Interactive / Plan / Autopilot) and is passed through to Copilot CLI.'
            ].join('\n')
        };
    }

    if (command === 'status') {
        return {
            kind: 'handled',
            message: [
                '**Copilot status**',
                '',
                `- agent mode: \`${state.agentMode}\``,
                `- permission: \`${state.permissionMode}\``,
                `- model: \`${state.model ?? 'auto'}\``
            ].join('\n')
        };
    }

    if (command === 'model') {
        if (!rest) {
            return { kind: 'handled', message: `Copilot model: ${state.model ?? 'auto'}` };
        }
        const model = rest === 'auto' || rest === 'default' ? null : rest;
        return {
            kind: 'handled',
            message: `Copilot model set to ${model ?? 'auto'}`,
            updates: { model }
        };
    }

    if (command === 'permissions' || command === 'permission') {
        if (!rest) {
            return { kind: 'handled', message: `Copilot permission mode: ${state.permissionMode}` };
        }
        const permissionMode = resolveCopilotPermissionMode(rest);
        if (!permissionMode) {
            return {
                kind: 'handled',
                message: `Unknown permission mode \`${rest}\`. Use one of: ${COPILOT_PERMISSION_MODES.join(', ')}`
            };
        }
        return {
            kind: 'handled',
            message: `Copilot permission mode set to ${permissionMode}`,
            updates: { permissionMode }
        };
    }

    if (command === 'plan') {
        const lowerRest = rest.toLowerCase();
        if (lowerRest === 'off' || lowerRest === 'default' || lowerRest === 'exit' || lowerRest === 'disable') {
            return {
                kind: 'handled',
                message: 'Copilot plan mode disabled',
                updates: { agentMode: 'interactive' }
            };
        }
        if (rest) {
            return {
                kind: 'replace',
                text: rest,
                message: 'Copilot plan mode enabled',
                updates: { agentMode: 'plan' }
            };
        }
        return {
            kind: 'handled',
            message: 'Copilot plan mode enabled',
            updates: { agentMode: 'plan' }
        };
    }

    if (command === 'autopilot') {
        const lowerRest = rest.toLowerCase();
        if (lowerRest === 'off' || lowerRest === 'default' || lowerRest === 'exit' || lowerRest === 'disable') {
            return {
                kind: 'handled',
                message: 'Copilot autopilot mode disabled',
                updates: { agentMode: 'interactive' }
            };
        }
        if (rest) {
            return {
                kind: 'replace',
                text: rest,
                message: 'Copilot autopilot mode enabled',
                updates: { agentMode: 'autopilot' }
            };
        }
        return {
            kind: 'handled',
            message: 'Copilot autopilot mode enabled',
            updates: { agentMode: 'autopilot' }
        };
    }

    // /fleet is not an agent mode — pass through so Copilot CLI can orchestrate
    // parallel subagents alongside Interactive / Plan / Autopilot.
    if (command === 'fleet') {
        return { kind: 'passthrough' };
    }

    if (command === 'interactive' || command === 'default') {
        return {
            kind: 'handled',
            message: 'Copilot interactive mode enabled',
            updates: { agentMode: 'interactive' }
        };
    }

    if (command === 'mode') {
        if (rest.trim().toLowerCase() === 'fleet') {
            return {
                kind: 'handled',
                message: 'Fleet is not an agent mode. Use `/fleet <task>` (works with Interactive, Plan, or Autopilot).'
            };
        }
        const agentMode = resolveCopilotAgentMode(rest);
        if (!agentMode) {
            return {
                kind: 'handled',
                message: 'Unknown agent mode. Use interactive, plan, or autopilot. For parallel subagents use `/fleet <task>`.'
            };
        }
        return {
            kind: 'handled',
            message: `Copilot agent mode set to ${agentMode}`,
            updates: { agentMode }
        };
    }

    if (command === 'context' || command === 'usage' || command === 'tasks' || command === 'subagents' || command === 'agents' || command === 'delegate' || command === 'agent' || command === 'rubber-duck' || command === 'security-review' || command === 'research' || command === 'review' || command === 'skills') {
        return { kind: 'passthrough' };
    }

    return { kind: 'passthrough' };
}
