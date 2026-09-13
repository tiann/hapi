import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveCodexCommand, type CodexCommand } from '../utils/codexExecutable';
import { parseCodexCliOverrides, stripCodexCliOverrides } from '../utils/codexCliOverrides';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';
import { getCodexSystemPrompt } from '../utils/systemPrompt';
import type { CodexAppServerClient } from '../codexAppServerClient';

export const SharedLaunchSchema = z.object({
    startedBy: z.enum(['runner', 'terminal']).optional(),
    codexArgs: z.array(z.string()).optional(),
    permissionMode: z.enum(['default', 'read-only', 'safe-yolo', 'yolo']).optional(),
    resumeSessionId: z.string().optional(), resumeLast: z.boolean().optional(), resumeAll: z.boolean().optional(), existingSessionId: z.string().optional(),
    model: z.string().optional(), modelReasoningEffort: z.string().optional(),
    serviceTier: z.string().optional(), collaborationMode: z.enum(['default', 'plan']).optional(),
    workingDirectory: z.string().optional()
});
export type SharedLaunchOptions = z.infer<typeof SharedLaunchSchema>;

/** Resolve once: a desktop server and a different PATH TUI are never mixed. */
export function resolveSharedCodex(): CodexCommand {
    const command = resolveCodexCommand();
    const version = execFileSync(command.command, [...command.args, '--version'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true
    }).match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
    if (!version || Number(version[1]) === 0 && Number(version[2]) < 154) {
        throw new Error('Shared sessions require Codex >= 0.154.0. Upgrade the Codex executable on PATH.');
    }
    return command;
}

export function sharedLaunchConfig(options: SharedLaunchOptions, cwd: string): {
    cwd: string; serverArgs: string[]; tuiArgs: string[]; threadParams: Record<string, unknown>;
} {
    if (options.permissionMode === 'safe-yolo') throw new Error('safe-yolo is not a native shared permission mode. Choose default, read-only, yolo, or native --approve-for-me.');
    const args = options.codexArgs ?? [];
    const serverArgs: string[] = [];
    let tuiArgs: string[] = [];
    const config: Record<string, unknown> = {};
    const extraDirs: string[] = [];
    let model = options.model;
    let provider: string | undefined;
    let oss = false;
    let autoReview = false;
    for (let i = 0; i < args.length; i++) {
        const raw = args[i];
        if (raw === '--') { tuiArgs.push(...args.slice(i)); break; }
        const equal = raw.indexOf('=');
        const arg = equal > 0 ? raw.slice(0, equal) : /^-[cmiCasp].+/.test(raw) ? raw.slice(0, 2) : raw;
        const inline = equal > 0 ? raw.slice(equal + 1) : arg !== raw ? raw.slice(2) : undefined;
        const value = () => {
            const result = inline ?? args[++i];
            if (!result || result === '--' || result.startsWith('-') && arg !== '-c' && arg !== '--config') throw new Error(`Missing ${arg} value`);
            return result;
        };
        // Standalone app-server has no profile-v2 loader override. Flattening
        // it to -c would change precedence (including project/admin policy).
        if (arg === '-p' || arg === '--profile' || arg === '--config-profile') {
            throw new Error('Codex app-server 0.154 does not support profile selection. Use CODEX_HOME with the desired config.toml or explicit -c overrides.');
        }
        if (arg.startsWith('--remote')) throw new Error('HAPI owns --remote and its authentication options');
        if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
            const v = value(); serverArgs.push(arg, v);
            // Remote resume inherits permissions from the server; do not send
            // competing client-side permission config (including native /new).
            if (!['-c', '--config'].includes(arg) || !/^\s*["']?(approval_policy|sandbox_mode|approvals_reviewer)["']?\s*=/.test(v)) tuiArgs.push(arg, v);
        } else if (arg === '-m' || arg === '--model') {
            model = value(); tuiArgs.push('--model', model);
        } else if (['-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd'].includes(arg)) {
            const v = value();
            if ((arg === '-s' || arg === '--sandbox') && !['read-only', 'workspace-write', 'danger-full-access'].includes(v)) throw new Error(`Invalid ${arg} value`);
            if ((arg === '-a' || arg === '--ask-for-approval') && !['untrusted', 'on-failure', 'on-request', 'never'].includes(v)) throw new Error(`Invalid ${arg} value`);
            tuiArgs.push(arg, v);
        } else if (arg === '--search') {
            config.web_search = 'live'; tuiArgs.push(arg);
        } else if (arg === '--add-dir') {
            extraDirs.push(value());
        } else if (arg === '--oss') {
            oss = true;
        } else if (arg === '--local-provider') {
            provider = value();
            if (!['ollama', 'lmstudio'].includes(provider)) throw new Error('Unsupported --local-provider');
        } else if (arg === '--approve-for-me' || arg === '--not-so-yolo') {
            autoReview = true;
        } else if (arg === '--dangerously-bypass-hook-trust') {
            config.bypass_hook_trust = true;
        } else if (arg === '--strict-config') {
            serverArgs.push(arg);
        } else if (arg === '-i' || arg === '--image') {
            tuiArgs.push('--image', value());
        } else if (['--no-alt-screen', '--yolo', '--dangerously-bypass-approvals-and-sandbox'].includes(arg)) {
            tuiArgs.push(arg);
        } else if (arg === '--full-auto') {
            // Older HAPI accepted this alias; upstream 0.154 removed it.
            tuiArgs.push('--ask-for-approval', 'on-request', '--sandbox', 'workspace-write');
        } else if (arg.startsWith('-')) {
            throw new Error(`Unsupported shared Codex launch flag: ${arg}`);
        } else {
            tuiArgs.push(raw);
        }
    }
    if (oss && !provider) throw new Error('--oss requires --local-provider (ollama or lmstudio) for a shared app-server');
    const overrides = parseCodexCliOverrides(tuiArgs);
    const directory = resolve(cwd, overrides.cwd ?? '.');
    const delimiter = tuiArgs.indexOf('--');
    for (let i = (delimiter < 0 ? tuiArgs.length : delimiter) - 2; i >= 0; i--) {
        if (tuiArgs[i] === '-C' || tuiArgs[i] === '--cd') tuiArgs.splice(i, 2);
    }
    if (extraDirs.length) config['sandbox_workspace_write.writable_roots'] = extraDirs.map(path => resolve(directory, path));
    if (provider) config.model_provider = provider;
    const permission = options.permissionMode ? resolveCodexPermissionModeConfig(options.permissionMode) : undefined;
    if (permission) {
        // Explicit HAPI permission selection wins on every launch surface:
        // initial thread, attached TUI, and later native /new threads.
        config.approval_policy = permission.approvalPolicy;
        config.sandbox_mode = permission.sandbox;
        config.approvals_reviewer = 'user';
    }
    // The attached TUI resumes a remote task, which rejects permission flags.
    // The initial thread already has their resolved policy; inherit it there.
    tuiArgs = stripCodexCliOverrides(tuiArgs);
    // Launch-wide flags also apply to later native /new roots, not just the
    // initial HAPI-created root. Explicit config layers keep their order.
    for (const [key, value] of Object.entries(config)) serverArgs.push('-c', `${key}=${JSON.stringify(value)}`);
    return {
        cwd: directory, serverArgs, tuiArgs,
        threadParams: {
            ...(model ? { model } : {}),
            ...(provider ? { modelProvider: provider } : {}),
            ...(options.serviceTier ? { serviceTier: options.serviceTier === 'fast' ? 'priority' : null } : {}),
            ...(overrides.approvalPolicy ? { approvalPolicy: overrides.approvalPolicy } : {}),
            ...(overrides.sandbox ? { sandbox: overrides.sandbox } : {}),
            ...(autoReview ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' } : {}),
            ...(permission ? { approvalPolicy: permission.approvalPolicy, approvalsReviewer: 'user', sandbox: permission.sandbox } : {}),
            config: { ...config, ...(options.modelReasoningEffort ? { model_reasoning_effort: options.modelReasoningEffort } : {}) },
            developerInstructions: getCodexSystemPrompt()
        }
    };
}

export async function initializeSharedClient(client: CodexAppServerClient): Promise<void> {
    await client.connect();
    await client.initialize({ clientInfo: { name: 'hapi', title: 'HAPI', version: '1' }, capabilities: { experimentalApi: true } });
}

/** Invalid IDs only: no probes may create turns, mutate threads or call a model. */
export async function checkSharedCapabilities(client: CodexAppServerClient): Promise<void> {
    for (const method of ['thread/queue/list', 'thread/queue/add', 'thread/queue/delete', 'thread/queue/start', 'turn/steer', 'thread/settings/update', 'thread/metadata/update', 'thread/fork', 'thread/turns/list']) {
        if (!await client.supportsMethod(method)) throw new Error(`Codex lacks ${method}; upgrade to a compatible >= 0.154.0 build`);
    }
}
