/**
 * Cursor slash commands that are safe to isolate + pass through as ACP/prompt text.
 *
 * Exclude interactive TUI / IDE-only commands (`/config`, `/mcp`, `/sandbox`, `/btw`,
 * `/rewind`, …) — those need a real terminal surface and will not work over remote ACP.
 *
 * Mode switches (`/ask`, `/plan`, `/debug`) are handled by HAPI permission-mode UI via ACP
 * `session/set_config_option`, not by pass-through.
 */
export const CURSOR_PASS_THROUGH_COMMANDS_WITH_ARGS = [
    'compress',
    'summarize',
    'compact',
    'model',
    'multitask',
    'best-of-n',
    'worktree',
    'apply-worktree',
    'delete-worktree',
    'add-dir',
    'context',
    'fork',
    'auto-review',
] as const;

export type CursorPassThroughCommand = typeof CURSOR_PASS_THROUGH_COMMANDS_WITH_ARGS[number];

export type CursorSpecialCommand =
    | { type: 'pass-through'; command: CursorPassThroughCommand; message: string }
    | { type: null };

function matchCommandWithOptionalArgs(trimmed: string, command: CursorPassThroughCommand): string | null {
    const prefix = `/${command}`;
    if (trimmed === prefix) {
        return trimmed;
    }
    if (trimmed.startsWith(`${prefix} `)) {
        return trimmed;
    }
    return null;
}

/**
 * Parse Cursor-specific slash commands for remote sessions.
 * Commands with optional trailing text are passed verbatim to the Cursor agent.
 * This parser is for detection and UI contract only.
 */
export function parseCursorSpecialCommand(message: string): CursorSpecialCommand {
    const trimmed = message.trim();

    for (const command of CURSOR_PASS_THROUGH_COMMANDS_WITH_ARGS) {
        const matched = matchCommandWithOptionalArgs(trimmed, command);
        if (matched) {
            return { type: 'pass-through', command, message: matched };
        }
    }

    return { type: null };
}

export function cursorPassThroughStatusMessage(command: CursorPassThroughCommand): string {
    switch (command) {
        case 'compress':
        case 'summarize':
        case 'compact':
            return 'Context compression requested';
        case 'model':
            return 'Model change requested';
        case 'multitask':
            return 'Multitask (async subagents) requested';
        case 'best-of-n':
            return 'Best-of-N comparison requested';
        case 'worktree':
            return 'Cursor worktree requested';
        case 'apply-worktree':
            return 'Apply Cursor worktree requested';
        case 'delete-worktree':
            return 'Delete Cursor worktree requested';
        case 'add-dir':
            return 'Add workspace directory requested';
        case 'context':
            return 'Context breakdown requested';
        case 'fork':
            return 'Fork conversation requested';
        case 'auto-review':
            return 'Auto-review mode toggle requested';
        default: {
            const exhaustive: never = command;
            return exhaustive;
        }
    }
}
