import type { AgentMessage } from '@/agent/types';

type ToolCall = Extract<AgentMessage, { type: 'tool_call' }>;
type ToolResult = Extract<AgentMessage, { type: 'tool_result' }>;

/**
 * agy's `agy acp` titles its tool calls with free text (the command line,
 * `File notes.md`, `Run invoke_subagent`), so no web card matches them. It
 * also sends its own tool name and args, which identify the tool; this maps
 * them to the canonical cards the other flavors use. Names differ from agy's
 * stream-json tools (read_file / edit_file / write_file there are view_file /
 * replace_file_content / write_to_file).
 */

/** Shown for a command agy moved to the background until its real result arrives. */
export const AGY_BACKGROUND_COMMAND_RESULT = {
    stdout: 'Running in the background. The result appears when agy reports it.'
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asText(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function parseArguments(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try {
            return asRecord(JSON.parse(value)) ?? {};
        } catch {
            return {};
        }
    }
    return asRecord(value) ?? {};
}

/** An artifact write (plan, task list) lives in agy's private brain directory. */
function artifactPlan(args: Record<string, unknown>): string | null {
    const metadata = asRecord(args.ArtifactMetadata);
    if (!metadata) return null;
    const content = asText(args.Content) ?? '';
    const summary = asText(metadata.Summary);
    if (!summary || /^\s*#/.test(content)) return content;
    return `# ${summary}\n\n${content}`;
}

export function mapAgyToolCall(message: ToolCall): ToolCall {
    const args = asRecord(message.nativeArgs);
    if (!message.nativeName || !args) return message;

    let name: string;
    let input: Record<string, unknown>;
    switch (message.nativeName) {
        case 'run_command':
            name = 'Bash';
            input = compact({
                command: args.CommandLine,
                cwd: args.Cwd,
                description: args.toolSummary
            });
            break;
        case 'read_file':
            name = 'Read';
            input = compact({ file_path: args.Path });
            break;
        case 'edit_file':
            name = 'Edit';
            input = compact({ file_path: args.Path, old_string: args.Target, new_string: args.Replacement });
            break;
        case 'write_file': {
            const plan = artifactPlan(args);
            if (plan !== null) {
                name = 'ExitPlanMode';
                input = { plan };
            } else {
                name = 'Write';
                input = compact({ file_path: args.Path, content: args.Content });
            }
            break;
        }
        case 'search_web':
            name = 'WebSearch';
            input = compact({ query: args.query });
            break;
        case 'invoke_subagent':
            name = 'Task';
            input = compact({ description: args.Role, prompt: args.Prompt, subagent_type: args.TypeName });
            break;
        case 'call_mcp_tool': {
            const server = asText(args.ServerName);
            const tool = asText(args.ToolName);
            if (!server || !tool) return message;
            name = `mcp__${server}__${tool}`;
            input = parseArguments(args.Arguments);
            break;
        }
        default:
            return message;
    }

    // An artifact plan must not leak the brain path through the title.
    if (name === 'ExitPlanMode') {
        const { title: _title, ...rest } = message;
        return { ...rest, name, input };
    }
    return { ...message, name, input };
}

/** agy frames a command result as "Command exited with code N.\n\nCommand output:\n<text>". */
export function mapAgyToolResult(message: ToolResult, nativeName: string | undefined): ToolResult {
    if (nativeName !== 'run_command') return message;
    const output = asRecord(message.output);
    const text = asText(output?.output);
    if (!output || text === undefined) return message;
    const body = text
        .replace(/\r\n/g, '\n')
        .replace(/^Command exited with code -?\d+\.\s*\n\s*Command output:\n?/, '')
        .trimEnd();
    return {
        ...message,
        output: {
            stdout: body,
            ...(typeof output.exit_code === 'number' ? { exit_code: output.exit_code } : {})
        }
    };
}
