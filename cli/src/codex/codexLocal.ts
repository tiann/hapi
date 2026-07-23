import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import {
    buildMcpServerConfigArgs,
    buildDeveloperInstructionsArg,
    buildSessionStartHookConfigArgs,
    buildModelReasoningEffortConfigArgs
} from './utils/codexMcpConfig';
import { codexSystemPrompt } from './utils/systemPrompt';
import type { ReasoningEffort } from './appServerTypes';
import { resolveCodexCommand } from './utils/codexExecutable';
import type { McpServersConfig } from './utils/buildHapiMcpBridge';

const CODEX_OPTIONS_WITH_VALUE = new Set([
    '-a',
    '--add-dir',
    '--ask-for-approval',
    '-C',
    '--cd',
    '-c',
    '--config',
    '--disable',
    '--enable',
    '--local-provider',
    '-m',
    '--model',
    '-p',
    '--profile',
    '--remote',
    '--remote-auth-token-env',
    '-s',
    '--sandbox'
]);
// -i/--image is intentionally omitted because it accepts a variable number of files.

function findResumeSubcommandIndex(args: string[]): number {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--') {
            return -1;
        }
        if (arg === 'resume') {
            return i;
        }
        if (!arg.startsWith('-')) {
            return -1;
        }
        if (!arg.includes('=') && CODEX_OPTIONS_WITH_VALUE.has(arg)) {
            i += 1;
        }
    }

    return -1;
}

function findResumeSessionIdIndex(args: string[], resumeIndex: number): number {
    for (let i = resumeIndex + 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--') {
            return -1;
        }
        if (!arg.startsWith('-')) {
            return i;
        }
        if (!arg.includes('=') && CODEX_OPTIONS_WITH_VALUE.has(arg)) {
            i += 1;
        }
    }

    return -1;
}

/**
 * Filter out the Codex resume selector which is managed internally by hapi.
 * Codex accepts global options before the subcommand, for example
 * `codex --sandbox danger-full-access resume --last`.
 */
export function filterResumeSubcommand(args: string[]): string[] {
    const resumeIndex = findResumeSubcommandIndex(args);
    if (resumeIndex === -1) {
        return args;
    }

    const optionTerminatorIndex = args.indexOf('--', resumeIndex + 1);
    const lastIndex = args.findIndex((arg, index) => (
        arg === '--last'
        && index > resumeIndex
        && (optionTerminatorIndex === -1 || index < optionTerminatorIndex)
    ));
    const sessionIdIndex = lastIndex === -1
        ? findResumeSessionIdIndex(args, resumeIndex)
        : -1;
    const filtered = args.filter((_, index) => (
        index !== resumeIndex
        && index !== lastIndex
        && index !== sessionIdIndex
    ));

    if (lastIndex !== -1) {
        logger.debug("[CodexLocal] Filtered 'resume --last' - session managed by hapi");
    } else if (sessionIdIndex !== -1) {
        logger.debug(`[CodexLocal] Filtered 'resume ${args[sessionIdIndex]}' - session managed by hapi`);
    } else {
        logger.debug("[CodexLocal] Filtered 'resume' - session managed by hapi");
    }

    return filtered;
}

export async function codexLocal(opts: {
    abort: AbortSignal;
    sessionId: string | null;
    path: string;
    model?: string;
    modelReasoningEffort?: ReasoningEffort;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
    mcpServers?: McpServersConfig;
    sessionHook?: {
        port: number;
        token: string;
    };
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('resume', opts.sessionId);
        opts.onSessionFound(opts.sessionId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.modelReasoningEffort) {
        args.push(...buildModelReasoningEffortConfigArgs(opts.modelReasoningEffort));
    }

    if (opts.sandbox) {
        args.push('--sandbox', opts.sandbox);
    }

    // Add MCP server configuration
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push(...buildMcpServerConfigArgs(opts.mcpServers));
    }

    if (opts.sessionHook) {
        args.push(...buildSessionStartHookConfigArgs(opts.sessionHook.port, opts.sessionHook.token));
    }

    // Add developer instructions (system prompt)
    args.push(...buildDeveloperInstructionsArg(codexSystemPrompt));

    if (opts.codexArgs) {
        // Before the first launch, Codex still needs the user's selector (for
        // example `resume --last`). Once hapi has the concrete session ID, it
        // prepends that ID above and removes the original selector here.
        const safeArgs = opts.sessionId
            ? filterResumeSubcommand(opts.codexArgs)
            : opts.codexArgs;
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    const codexCommand = resolveCodexCommand();

    await spawnWithTerminalGuard({
        command: codexCommand.command,
        args: [...codexCommand.args, ...args],
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        logLabel: 'CodexLocal',
        spawnName: 'codex',
        installHint: 'Codex CLI',
        includeCause: true,
        logExit: true
    });
}
