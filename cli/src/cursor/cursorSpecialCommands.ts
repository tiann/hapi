export const CURSOR_PASS_THROUGH_COMMANDS_WITH_ARGS = ['compress', 'model'] as const;

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
            return 'Context compression requested';
        case 'model':
            return 'Model change requested';
        default: {
            const exhaustive: never = command;
            return exhaustive;
        }
    }
}
