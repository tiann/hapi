import { OPENCODE_PERMISSION_MODES } from '@hapi/protocol/modes';
import type { OpencodePermissionMode } from '@hapi/protocol/types';
import type { SlashCommand } from '@/modules/common/slashCommands';

const OPENCODE_INIT_PROMPT = [
    'Please analyze this codebase and create (or update) an `AGENTS.md` file at the repo root so future coding agents have what they need.',
    '',
    'Cover:',
    '1. **Build / lint / test commands** — including how to run a *single* test, not just the whole suite.',
    '2. **Code style** — imports, formatting, types, naming, error handling, anything non-obvious.',
    '3. **Project layout** — only what is not derivable from a quick `ls`; highlight unusual boundaries or generated code.',
    '',
    'Guidelines:',
    '- If `AGENTS.md` already exists, refine it rather than rewriting from scratch.',
    '- If `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, or similar conventions exist, fold their substance in (do not duplicate verbatim).',
    '- Keep it concise (~20–40 lines). Skip the obvious.'
].join('\n');

export type OpencodeSlashResolution =
    | { kind: 'passthrough' }
    | {
        kind: 'handled';
        message: string;
        updates?: {
            permissionMode?: OpencodePermissionMode;
            model?: string | null;
            modelReasoningEffort?: string | null;
        };
    }
    | {
        kind: 'replace';
        text: string;
        message?: string;
        updates?: {
            permissionMode?: OpencodePermissionMode;
            model?: string | null;
            modelReasoningEffort?: string | null;
        };
    };

export function resolveOpencodeSlashCommand(
    text: string,
    state: {
        commands?: readonly SlashCommand[];
        permissionMode: OpencodePermissionMode;
        model?: string | null;
        modelReasoningEffort?: string | null;
    }
): OpencodeSlashResolution {
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
                message: 'OpenCode plan mode disabled',
                updates: { permissionMode: 'default' }
            };
        }
        if (rest) {
            return {
                kind: 'replace',
                text: rest,
                message: 'OpenCode plan mode enabled',
                updates: { permissionMode: 'plan' }
            };
        }
        return {
            kind: 'handled',
            message: 'OpenCode plan mode enabled',
            updates: { permissionMode: 'plan' }
        };
    }

    if (command === 'default') {
        return {
            kind: 'handled',
            message: 'OpenCode permission mode set to default',
            updates: { permissionMode: 'default' }
        };
    }

    if (command === 'status') {
        return {
            kind: 'handled',
            message: [
                '**OpenCode status**',
                '',
                `- permission: \`${state.permissionMode}\``,
                `- model: \`${state.model ?? 'default'}\``,
                `- reasoning: \`${state.modelReasoningEffort ?? 'default'}\``
            ].join('\n')
        };
    }

    if (command === 'model') {
        if (!rest) {
            return { kind: 'handled', message: `OpenCode model: ${state.model ?? 'default'}` };
        }
        const model = rest === 'auto' || rest === 'default' ? null : rest;
        return {
            kind: 'handled',
            message: `OpenCode model set to ${model ?? 'default'}`,
            updates: { model }
        };
    }

    if (command === 'reasoning' || command === 'effort') {
        if (!rest) {
            return {
                kind: 'handled',
                message: `OpenCode reasoning effort: ${state.modelReasoningEffort ?? 'default'}`
            };
        }
        if (rest === 'default' || rest === 'auto') {
            return {
                kind: 'handled',
                message: 'OpenCode reasoning effort set to default',
                updates: { modelReasoningEffort: null }
            };
        }
        return {
            kind: 'handled',
            message: `OpenCode reasoning effort set to ${rest}`,
            updates: { modelReasoningEffort: rest }
        };
    }

    if (command === 'permissions' || command === 'permission') {
        if (!rest) {
            return {
                kind: 'handled',
                message: `OpenCode permission mode: ${state.permissionMode}`
            };
        }
        if (!(OPENCODE_PERMISSION_MODES as readonly string[]).includes(rest)) {
            return {
                kind: 'handled',
                message: `Unknown OpenCode permission mode: ${rest}. Supported: ${OPENCODE_PERMISSION_MODES.join(', ')}.`
            };
        }
        return {
            kind: 'handled',
            message: `OpenCode permission mode set to ${rest}`,
            updates: { permissionMode: rest as OpencodePermissionMode }
        };
    }

    if (command === 'clear' || command === 'compact') {
        return {
            kind: 'handled',
            message: `/${command} is not yet supported in HAPI OpenCode sessions.`
        };
    }

    if (command === 'init') {
        const prompt = rest
            ? `${OPENCODE_INIT_PROMPT}\n\nAdditional instructions: ${rest}`
            : OPENCODE_INIT_PROMPT;
        return {
            kind: 'replace',
            text: prompt,
            message: 'Initializing AGENTS.md…'
        };
    }

    if (command === 'help') {
        return {
            kind: 'handled',
            message: [
                '**Supported OpenCode slash commands**',
                '',
                '- `/help` — show this list',
                '- `/status` — show current OpenCode session config',
                '- `/plan [prompt]` — enable plan mode, optionally send prompt',
                '- `/plan off` — return to default permission mode',
                '- `/default` — return to default permission mode',
                '- `/init [extra]` — generate or refresh AGENTS.md for this project',
                '',
                'Model, reasoning effort, and permission mode have dedicated buttons in the composer. ' +
                'You can still type `/model`, `/reasoning`, or `/permissions` if you prefer.',
                '',
                '`/clear` and `/compact` are not yet supported in HAPI OpenCode sessions.',
                '',
                'Custom commands from `~/.config/opencode/command` or `.opencode/command` are expanded before sending.'
            ].join('\n')
        };
    }

    return { kind: 'passthrough' };
}
