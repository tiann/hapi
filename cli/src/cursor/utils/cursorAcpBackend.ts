import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { AcpSdkBackend } from '@/agent/backends/acp';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

function isDefaultSpawnModel(model: string | null | undefined): boolean {
    if (!model) return true;
    const normalized = model.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

export type CursorAcpBackendOptions = {
    cwd: string;
    model?: string | null;
    /** When true, spawn with `--auto-review` (Cursor Smart Auto). */
    autoReview?: boolean;
    /**
     * Cursor-native worktree. `true` / `''` → `--worktree` (agent picks a name).
     * Non-empty string → `--worktree <name>`.
     */
    worktree?: boolean | string;
    /** Extra workspace roots (`--add-dir`, repeatable). */
    addDirs?: readonly string[];
};

/** Build `agent … acp` argv (global flags before the `acp` subcommand). */
export function buildCursorAcpArgs(opts: Omit<CursorAcpBackendOptions, 'cwd'>): string[] {
    const args: string[] = [];

    if (opts.autoReview) {
        args.push('--auto-review');
    }

    if (opts.worktree !== undefined && opts.worktree !== false) {
        args.push('--worktree');
        if (typeof opts.worktree === 'string') {
            const name = opts.worktree.trim();
            if (name) {
                args.push(name);
            }
        }
    }

    for (const dir of opts.addDirs ?? []) {
        const trimmed = dir.trim();
        if (trimmed) {
            args.push('--add-dir', trimmed);
        }
    }

    if (!isDefaultSpawnModel(opts.model)) {
        args.push('--model', opts.model!.trim());
    }

    args.push('acp');
    return args;
}

/**
 * Resolve the on-disk path Cursor uses for a named `--worktree`.
 * Matches CLI output: `~/.cursor/worktrees/<reponame>/<name>`.
 */
export function resolveCursorNativeWorktreePath(repoPath: string, worktreeName: string): string {
    const name = worktreeName.trim();
    if (!name) {
        throw new Error('Cursor worktree name is required to resolve path');
    }
    return join(homedir(), '.cursor', 'worktrees', basename(repoPath), name);
}

export function createCursorAcpBackend(opts: CursorAcpBackendOptions): AcpSdkBackend {
    return new AcpSdkBackend({
        command: 'agent',
        args: buildCursorAcpArgs(opts),
        env: filterEnv(process.env),
        flavor: 'cursor',
    });
}

export const CURSOR_ACP_REQUIRED_MESSAGE =
    'Cursor ACP mode is required for new Cursor remote sessions. Run `agent update` and verify `agent help acp`.';
